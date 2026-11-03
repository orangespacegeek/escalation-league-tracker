#!/usr/bin/env node
/**
 * Lost Planet Escalation League – JSON API and static file server.
 *
 * Public (no login):
 *   GET /health and GET /api/health
 *   GET /api/state                         tiers, players, lists, reports, standings
 *   GET /api/standings?tier_id=<id|overall>
 *
 * Players (no accounts). Join with the league code. The response includes a
 * personal edit token (keep it in localStorage) and a recovery code (shown
 * once). The recovery code mints a new token on another device and signs the
 * old token out. The recovery code itself stays the same until an admin
 * replaces it. Tokens and recovery codes are hashed at rest.
 *   POST /api/join        { join_code, name, faction, allegiance }
 *   POST /api/recover     { recovery_code }
 *   GET  /api/me          Authorization: Bearer <token>
 *   PUT  /api/me          { name, faction, allegiance }
 *   PUT  /api/lists       { tier_id, text, url }   until the tier end date
 *   POST /api/reports     { opponent_id, result: win|loss|draw, tier_id?, my_score?, opponent_score?, notes? }
 *
 * Admin session is an HttpOnly SameSite=Lax cookie (Secure on https).
 * Cookie writes send header X-EL-Request: 1.
 *   POST /api/admin/login          { password }
 *   POST /api/admin/logout
 *   GET  /api/admin/session
 *   POST /api/admin/tiers          { name, points, starts_on, ends_on }
 *   PUT  /api/admin/tiers/:id
 *   DELETE /api/admin/tiers/:id    blocked when lists or reports still use it
 *   PUT  /api/admin/join-code      { join_code }
 *   PUT  /api/admin/players/:id    { name, faction, allegiance, removed? }
 *   DELETE /api/admin/players/:id  soft-remove
 *   POST /api/admin/players/:id/recovery   new recovery code, shown once
 *   PUT  /api/admin/lists          { player_id, tier_id, text, url }  always allowed
 *   POST /api/admin/reports        { player_a_id, player_b_id, result: a_win|b_win|draw, ... }
 *   PUT  /api/admin/reports/:id
 *   DELETE /api/admin/reports/:id
 *   GET  /api/admin/backup
 *   POST /api/admin/backup/preview { ...backup }
 *   POST /api/admin/backup/restore { confirm: "RESTORE", restore_token }
 *
 * Join and admin login are rate-limited per IP.
 *
 * Env:
 *   PORT (default 3871), HOST (default 0.0.0.0)
 *   DATA_DIR (default ./data). Fresh directory: default tiers only, no sample
 *     players, lists, or games. Files are written atomically.
 *   Production (NODE_ENV=production, or RENDER set to a non-empty value)
 *     refuses to start when DATA_DIR is unset or resolves inside this
 *     application directory. ALLOW_EPHEMERAL_DATA=1 overrides that refusal
 *     and logs a loud warning. A good boot logs: Data directory: /var/data
 *   ADMIN_PASSWORD  required in production, at least 12 characters, not a
 *     common or all-numeric password. Development boots without it; admin
 *     login stays disabled until a strong password is set.
 *   JOIN_CODE       league code players type to join. Hashed at rest. In
 *     production a missing or weak code refuses to start when none is stored
 *     yet. Development prints a generated code once. JOIN_CODE_FORCE=1
 *     replaces the stored code from JOIN_CODE.
 *   TRUST_PROXY     unset or 0: rate-limit the socket address and ignore
 *     X-Forwarded-For. Render is one hop, so set TRUST_PROXY=1 there.
 *   LEAGUE_TODAY    YYYY-MM-DD override for tests. Ignored in production.
 *   AUTH_MAX_ATTEMPTS  optional per-IP cap, ignored in production.
 *   MAX_BODY_BYTES (default 1048576)
 *   RESTORE_MAX_BYTES (default 8388608)
 *
 * Static files are an allow-list. data/, server source, and dotfiles are not served.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const SESSION_DAYS = 14;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const RESTORE_TOKEN_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_RESTORE_MAX = 8 * 1024 * 1024;
const BACKUP_FORMAT = "escalation-league-backup";
const BACKUP_VERSION = 1;

const FILES = {
  meta: "meta.json",
  tiers: "tiers.json",
  players: "players.json",
  lists: "lists.json",
  reports: "reports.json",
  sessions: "sessions.json"
};

const PAGES = new Set([
  "index.html",
  "join.html",
  "play.html",
  "player.html",
  "games.html",
  "admin.html"
]);

const PUBLIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
};

const WEAK_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "admin",
  "admin123",
  "change-me",
  "changeme",
  "123456",
  "12345678",
  "123456789",
  "letmein",
  "qwerty",
  "qwerty123",
  "escalation",
  "lostplanet",
  "lost-planet",
  "horus",
  "heresy",
  "warhammer"
]);

const WEAK_JOIN_CODES = new Set([
  "password",
  "123456",
  "join",
  "league",
  "admin",
  "lostplanet",
  "heresy",
  "horus"
]);

const pendingRestores = new Map();
const authBuckets = new Map();

let DATA = resolveDataDir(process.env, ROOT);

function explicitEnv(env, key) {
  if (!env || env[key] == null) return "";
  return String(env[key]).trim();
}

function resolveDataDir(env, root) {
  const raw = explicitEnv(env, "DATA_DIR");
  return raw ? path.resolve(raw) : path.join(root, "data");
}

function canonicalPath(input) {
  let current = path.resolve(input);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(input);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let real = fs.realpathSync(current);
  for (const part of suffix) real = path.join(real, part);
  return real;
}

function isInsideDir(parent, child) {
  const root = canonicalPath(parent);
  const target = canonicalPath(child);
  const rel = path.relative(root, target);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isProductionEnv(env) {
  if (!env) return false;
  if (env.NODE_ENV === "production") return true;
  return env.RENDER != null && String(env.RENDER) !== "";
}

function evaluateDataDirectory(env = process.env, root = ROOT) {
  const dataDir = resolveDataDir(env, root);
  const unset = !explicitEnv(env, "DATA_DIR");
  const production = isProductionEnv(env);
  const inside = isInsideDir(root, dataDir);
  const ephemeral = unset || inside;
  const warnings = [];
  const errors = [];
  if (production && ephemeral) {
    const where = unset
      ? "is unset and defaults to " + dataDir + ", which is inside the application directory"
      : "resolves inside the application directory (" + dataDir + ")";
    if (String(env.ALLOW_EPHEMERAL_DATA || "") === "1") {
      warnings.push("================================================================");
      warnings.push("WARNING: ALLOW_EPHEMERAL_DATA=1 — league data will not survive a restart or deploy.");
      warnings.push("WARNING: DATA_DIR " + where + ".");
      warnings.push(
        "WARNING: Set DATA_DIR to a persistent disk outside the code folder. On Render, mount a disk at /var/data and set DATA_DIR=/var/data."
      );
      warnings.push("WARNING: A persistent boot logs: Data directory: /var/data");
      warnings.push("================================================================");
    } else {
      errors.push("Refusing to start: DATA_DIR " + where + ".");
      errors.push(
        "Production league data must live on a persistent disk outside the code folder, or players, lists, and reports are wiped on every deploy. On Render, add a disk mounted at /var/data and set DATA_DIR=/var/data. render.yaml does that only for a service created from the Blueprint. A persistent boot logs: Data directory: /var/data"
      );
      errors.push("To start anyway, knowing the data is ephemeral, set ALLOW_EPHEMERAL_DATA=1.");
    }
  } else if (!production && unset) {
    warnings.push(
      "Warning: DATA_DIR is unset. Using " +
        dataDir +
        " inside the application directory. This is fine for local development. Set DATA_DIR to store the league somewhere else."
    );
  }
  return { ok: errors.length === 0, dataDir, warnings, errors, unset, inside, production, ephemeral };
}

function isWeakAdminPassword(password) {
  if (password == null) return "missing";
  const value = String(password);
  if (!value.trim()) return "missing";
  if (value.length < 12) return "too short";
  const lower = value.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) return "a common password";
  for (const word of ["password", "admin", "changeme", "change-me", "qwerty", "letmein"]) {
    if (lower.startsWith(word) && /^\d*$/.test(lower.slice(word.length))) return "a common password";
  }
  if (/^(.)\1+$/.test(value)) return "too repetitive";
  if (/^\d+$/.test(value)) return "too simple";
  return null;
}

function isWeakJoinCode(code) {
  if (code == null) return "missing";
  const value = String(code).trim();
  if (!value) return "missing";
  if (value.length < 6) return "too short";
  if (value.length > 64) return "too long";
  if (WEAK_JOIN_CODES.has(value.toLowerCase())) return "too easy to guess";
  if (/^(.)\1+$/.test(value)) return "too repetitive";
  return null;
}

function hasStoredJoinCode(dataDir) {
  const fp = path.join(dataDir, "meta.json");
  if (!fs.existsSync(fp)) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(fp, "utf8"));
    return !!(meta && meta.join_code_hash && meta.join_code_salt);
  } catch (_) {
    return false;
  }
}

function joinCodeBootError(env, dataDir) {
  const configured = explicitEnv(env, "JOIN_CODE");
  if (configured) {
    const weak = isWeakJoinCode(configured);
    if (weak) {
      return (
        "Refusing to start: JOIN_CODE is " +
        weak +
        ". Use 6 to 64 characters, and not a common word like password or join."
      );
    }
    return null;
  }
  if (isProductionEnv(env) && !hasStoredJoinCode(dataDir)) {
    return "Refusing to start: JOIN_CODE is missing. Set JOIN_CODE to the code players type when they join.";
  }
  return null;
}

function collectBootErrors(env, root) {
  const data = evaluateDataDirectory(env, root);
  const errors = data.errors.slice();
  const warnings = data.warnings.slice();
  if (isProductionEnv(env)) {
    const weak = isWeakAdminPassword(env.ADMIN_PASSWORD);
    if (weak) {
      errors.push(
        "Refusing to start: ADMIN_PASSWORD is " +
          weak +
          ". Set a password of at least 12 characters that is not a common or all-numeric password."
      );
    }
  } else if (isWeakAdminPassword(env.ADMIN_PASSWORD)) {
    warnings.push(
      "Warning: ADMIN_PASSWORD is missing or weak. Admin login stays disabled until you set a password of at least 12 characters. This is allowed for local development."
    );
  }
  if (data.ok) {
    const joinErr = joinCodeBootError(env, data.dataDir);
    if (joinErr) errors.push(joinErr);
  }
  return {
    dataDir: data.dataDir,
    warnings,
    errors,
    unset: data.unset,
    inside: data.inside,
    production: data.production,
    ephemeral: data.ephemeral,
    ok: errors.length === 0
  };
}

function parseIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return value;
}

function isoDateUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function monthBounds(year, monthIndex) {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { starts_on: isoDateUTC(start), ends_on: isoDateUTC(end) };
}

function todayIso(env = process.env, now = new Date()) {
  if (!isProductionEnv(env)) {
    const override = parseIsoDate(explicitEnv(env, "LEAGUE_TODAY"));
    if (override) return override;
  }
  return now.toISOString().slice(0, 10);
}

function defaultTiers(today) {
  const day = parseIsoDate(today);
  if (!day) throw new Error("today must be YYYY-MM-DD");
  const [y, m] = day.split("-").map(Number);
  const specs = [
    { name: "1000 pts", points: 1000 },
    { name: "1500 pts", points: 1500 },
    { name: "2000 pts", points: 2000 }
  ];
  return specs.map((spec, i) => {
    const cursor = new Date(Date.UTC(y, m - 1 + i, 1));
    const bounds = monthBounds(cursor.getUTCFullYear(), cursor.getUTCMonth());
    return {
      tier_id: i + 1,
      name: spec.name,
      points: spec.points,
      starts_on: bounds.starts_on,
      ends_on: bounds.ends_on
    };
  });
}

function currentTier(tiers, today) {
  const day = parseIsoDate(today);
  if (!day || !Array.isArray(tiers)) return null;
  const matches = tiers.filter((tier) => {
    if (!tier) return false;
    const start = parseIsoDate(tier.starts_on);
    const end = parseIsoDate(tier.ends_on);
    if (!start || !end) return false;
    return start <= day && day <= end;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => {
    if (a.starts_on !== b.starts_on) return a.starts_on < b.starts_on ? 1 : -1;
    return (Number(b.points) || 0) - (Number(a.points) || 0);
  });
  return matches[0];
}

function tierOpenForPlayer(tier, today) {
  if (!tier || typeof tier !== "object") return false;
  const day = parseIsoDate(today);
  if (!day) return false;
  if (tier.ends_on == null || tier.ends_on === "") return true;
  const end = parseIsoDate(tier.ends_on);
  if (!end) return false;
  return day <= end;
}

function standingsFrom(players, reports, tierId) {
  const list = Array.isArray(players) ? players : [];
  const allReports = Array.isArray(reports) ? reports : [];
  const scoped = tierId == null ? allReports : allReports.filter((report) => report && report.tier_id === tierId);
  const byId = new Map();
  for (const player of list) {
    if (player && player.player_id != null && !byId.has(player.player_id)) byId.set(player.player_id, player);
  }
  const rows = new Map();
  function blank(player) {
    return {
      player_id: player.player_id,
      name: player.name,
      faction: player.faction,
      allegiance: player.allegiance,
      removed: !!player.removed,
      w: 0,
      l: 0,
      d: 0,
      played: 0
    };
  }
  function ensure(id) {
    if (rows.has(id)) return rows.get(id);
    const player = byId.get(id);
    if (!player) return null;
    const row = blank(player);
    rows.set(id, row);
    return row;
  }
  for (const player of list) {
    if (!player || player.removed) continue;
    ensure(player.player_id);
  }
  for (const report of scoped) {
    if (!report || report.player_a_id == null || report.player_b_id == null) continue;
    if (report.player_a_id === report.player_b_id) continue;
    const winner = report.winner_id;
    if (winner != null && winner !== report.player_a_id && winner !== report.player_b_id) continue;
    const a = ensure(report.player_a_id);
    const b = ensure(report.player_b_id);
    if (!a || !b) continue;
    a.played += 1;
    b.played += 1;
    if (winner == null) {
      a.d += 1;
      b.d += 1;
    } else if (winner === report.player_a_id) {
      a.w += 1;
      b.l += 1;
    } else {
      b.w += 1;
      a.l += 1;
    }
  }
  const table = [...rows.values()];
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const ranked = table
    .filter((row) => row.played > 0)
    .sort((a, b) => {
      if (b.w !== a.w) return b.w - a.w;
      if (a.l !== b.l) return a.l - b.l;
      if (b.d !== a.d) return b.d - a.d;
      return byName(a, b);
    });
  const notPlayed = table.filter((row) => row.played === 0 && !row.removed).sort(byName);
  return { rows: ranked, not_played: notPlayed };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dump(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function ensureDataDir() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
}

function atomicWrite(fp, text) {
  ensureDataDir();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.basename(fp);
  if (!base || base.startsWith(".") || base !== path.basename(base)) {
    throw httpError(500, "Refusing to write outside the data directory");
  }
  const resolvedDir = fs.realpathSync(dir);
  const dest = path.join(resolvedDir, base);
  const root = fs.realpathSync(DATA);
  const rel = path.relative(root, dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw httpError(500, "Refusing to write outside the data directory");
  }
  const tmp = dest + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  const tmpRel = path.relative(resolvedDir, tmp);
  if (!tmpRel || tmpRel.startsWith("..") || path.isAbsolute(tmpRel)) {
    throw httpError(500, "Refusing to write outside the data directory");
  }
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
}

function collectionPath(name) {
  if (typeof name !== "string" || name !== path.basename(name) || name.startsWith(".") || name.includes("..")) {
    throw httpError(500, "Refusing to write outside the data directory");
  }
  ensureDataDir();
  const dest = path.join(DATA, name);
  const root = fs.realpathSync(DATA);
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const resolved = path.resolve(fs.realpathSync(parent), path.basename(dest));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw httpError(500, "Refusing to write outside the data directory");
  }
  return resolved;
}

function writeDataFilesAtomically(files) {
  const planned = files.map((file) => {
    const dest = collectionPath(file.name);
    const previous = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    return { dest, text: file.text, previous };
  });
  const temps = [];
  let renamed = 0;
  try {
    for (const file of planned) {
      const tmp = file.dest + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
      const tmpRel = path.relative(path.dirname(file.dest), tmp);
      if (!tmpRel || tmpRel.startsWith("..") || path.isAbsolute(tmpRel)) {
        throw httpError(500, "Refusing to write outside the data directory");
      }
      fs.writeFileSync(tmp, file.text, { mode: 0o600 });
      temps.push(tmp);
    }
    for (let i = 0; i < planned.length; i++) {
      fs.renameSync(temps[i], planned[i].dest);
      temps[i] = null;
      renamed += 1;
    }
  } catch (err) {
    for (const tmp of temps) {
      if (!tmp) continue;
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
    }
    for (let i = 0; i < renamed; i++) {
      const file = planned[i];
      try {
        if (file.previous == null) fs.unlinkSync(file.dest);
        else atomicWrite(file.dest, file.previous);
      } catch (_) {}
    }
    throw err;
  }
}

function readJsonFile(fp, fallback) {
  if (!fs.existsSync(fp)) return { missing: true, value: fallback };
  return { missing: false, value: JSON.parse(fs.readFileSync(fp, "utf8")) };
}

function defaultMeta(tiers) {
  return {
    join_code_salt: null,
    join_code_hash: null,
    next_player_id: 1,
    next_tier_id: maxId(tiers || [], "tier_id") + 1,
    next_list_id: 1,
    next_report_id: 1
  };
}

function readCollection(name) {
  const file = FILES[name];
  if (!file) throw new Error("Unknown collection");
  const fp = path.join(DATA, file);
  if (name === "meta") {
    const found = readJsonFile(fp, null);
    if (found.missing) {
      const meta = defaultMeta(readCollection("tiers"));
      atomicWrite(fp, dump(meta));
      return meta;
    }
    return found.value;
  }
  if (name === "tiers") {
    const found = readJsonFile(fp, null);
    if (found.missing) {
      const tiers = defaultTiers(todayIso());
      atomicWrite(fp, dump(tiers));
      return tiers;
    }
    return found.value;
  }
  const found = readJsonFile(fp, []);
  if (found.missing) {
    atomicWrite(fp, dump([]));
    return [];
  }
  return found.value;
}

function writeCollection(name, data) {
  const file = FILES[name];
  if (!file) throw new Error("Unknown collection");
  atomicWrite(collectionPath(file), dump(data));
}

function maxId(rows, key) {
  let max = 0;
  for (const row of rows || []) {
    const n = Number(row && row[key]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

function ensureLeagueFiles() {
  ensureDataDir();
  const tiers = readCollection("tiers");
  if (!fs.existsSync(path.join(DATA, "meta.json"))) writeCollection("meta", defaultMeta(tiers));
  readCollection("players");
  readCollection("lists");
  readCollection("reports");
  readCollection("sessions");
}

function hashSecret(secret, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(secret), s, 32).toString("hex");
  return { salt: s, hash };
}

function verifySecret(secret, salt, hash) {
  if (!salt || !hash || secret == null) return false;
  let check;
  try {
    check = crypto.scryptSync(String(secret), String(salt), 32).toString("hex");
  } catch (_) {
    return false;
  }
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(String(hash), "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function passwordsMatch(given, expected) {
  const a = crypto.createHash("sha256").update(String(given == null ? "" : given), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected == null ? "" : expected), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(groups, size) {
  const count = groups * size;
  const bytes = crypto.randomBytes(count);
  let raw = "";
  for (let i = 0; i < count; i++) raw += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  const parts = [];
  for (let g = 0; g < groups; g++) parts.push(raw.slice(g * size, (g + 1) * size));
  return parts.join("-");
}

function bootstrapJoinCode(env) {
  const meta = readCollection("meta");
  const configured = explicitEnv(env, "JOIN_CODE");
  const force = String(env.JOIN_CODE_FORCE || "") === "1";
  if (meta.join_code_hash && meta.join_code_salt && !(force && configured)) {
    if (configured && !force) {
      console.log("Join code: using the code stored in the data directory. Set JOIN_CODE_FORCE=1 to replace it from JOIN_CODE.");
    }
    return;
  }
  let code = configured;
  let printed = false;
  if (!code) {
    code = randomCode(3, 4).replace(/-/g, "");
    printed = true;
  }
  const hashed = hashSecret(code);
  meta.join_code_salt = hashed.salt;
  meta.join_code_hash = hashed.hash;
  writeCollection("meta", meta);
  if (printed) {
    console.log("============================================================");
    console.log("JOIN_CODE (printed once; not stored in plaintext)");
    console.log("code=" + code);
    console.log("Set JOIN_CODE on the host to choose the league code yourself.");
    console.log("============================================================");
  } else if (force) {
    console.log("Applied JOIN_CODE from the environment (JOIN_CODE_FORCE=1).");
  } else {
    console.log("Stored JOIN_CODE from the environment.");
  }
}

function allocId(key) {
  const meta = readCollection("meta");
  const current = Number(meta[key]);
  const id = Number.isInteger(current) && current > 0 ? current : 1;
  meta[key] = id + 1;
  writeCollection("meta", meta);
  return id;
}

function cleanLine(value, max, label) {
  if (value == null) return { text: "" };
  if (typeof value !== "string") return { error: label + " must be text" };
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > max) return { error: label + " is too long" };
  return { text };
}

function cleanBlock(value, max, label) {
  if (value == null) return { text: "" };
  if (typeof value !== "string") return { error: label + " must be text" };
  const text = value.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (text.length > max) return { error: label + " is too long" };
  return { text };
}

function parseUrl(value) {
  if (value == null || value === "") return { url: null };
  const cleaned = cleanLine(value, 400, "Link");
  if (cleaned.error) return cleaned;
  if (!cleaned.text) return { url: null };
  let url;
  try {
    url = new URL(cleaned.text);
  } catch (_) {
    return { error: "Link must be an http or https URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Link must be an http or https URL" };
  return { url: url.toString() };
}

function parseAllegiance(value) {
  if (value !== "Loyalist" && value !== "Traitor") return { error: "Allegiance must be Loyalist or Traitor" };
  return { allegiance: value };
}

function parsePoints(value) {
  let n = value;
  if (typeof n === "string" && /^\d+$/.test(n)) n = Number(n);
  if (!Number.isInteger(n) || n < 1 || n > 100000) return { error: "Points must be a whole number from 1 to 100000" };
  return { points: n };
}

function parseScore(value, label) {
  if (value == null || value === "") return { score: null };
  let n = value;
  if (typeof n === "string" && /^\d+$/.test(n)) n = Number(n);
  if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: label + " must be a whole number from 0 to 10000" };
  return { score: n };
}

function asId(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1e15) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    if (n <= 1e15) return n;
  }
  return null;
}

function pathId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(rest)) return null;
  return Number(rest);
}

function findPlayer(id) {
  return readCollection("players").find((player) => player.player_id === id) || null;
}

function findTier(id) {
  return readCollection("tiers").find((tier) => tier.tier_id === id) || null;
}

function publicPlayer(player) {
  return {
    player_id: player.player_id,
    name: player.name,
    faction: player.faction,
    allegiance: player.allegiance,
    removed: !!player.removed,
    created_at: player.created_at
  };
}

function publicList(list) {
  return {
    list_id: list.list_id,
    player_id: list.player_id,
    tier_id: list.tier_id,
    text: list.text || "",
    url: list.url || null,
    updated_at: list.updated_at
  };
}

function publicReport(report) {
  return {
    report_id: report.report_id,
    tier_id: report.tier_id,
    player_a_id: report.player_a_id,
    player_b_id: report.player_b_id,
    winner_id: report.winner_id == null ? null : report.winner_id,
    score_a: report.score_a == null ? null : report.score_a,
    score_b: report.score_b == null ? null : report.score_b,
    notes: report.notes || null,
    reported_by: report.reported_by == null ? null : report.reported_by,
    created_at: report.created_at,
    updated_at: report.updated_at
  };
}

function viewTier(tier, today) {
  return {
    tier_id: tier.tier_id,
    name: tier.name,
    points: tier.points,
    starts_on: tier.starts_on || null,
    ends_on: tier.ends_on || null,
    open: tierOpenForPlayer(tier, today)
  };
}

function buildStandings(players, reports, tiers) {
  const overall = standingsFrom(players, reports, null);
  const byTier = {};
  for (const tier of tiers) byTier[String(tier.tier_id)] = standingsFrom(players, reports, tier.tier_id);
  return { overall, tiers: byTier };
}

function publicState() {
  const today = todayIso();
  const tiers = readCollection("tiers");
  const players = readCollection("players");
  const lists = readCollection("lists");
  const reports = readCollection("reports");
  const current = currentTier(tiers, today);
  return {
    today,
    tiers: tiers.map((tier) => viewTier(tier, today)),
    current_tier_id: current ? current.tier_id : null,
    players: players.map(publicPlayer),
    lists: lists.map(publicList),
    reports: reports.map(publicReport),
    standings: buildStandings(players, reports, tiers)
  };
}

function playerFromToken(token) {
  if (!token || typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const hash = sha256(token);
  return readCollection("players").find((player) => player.token_hash === hash) || null;
}

function normalizeRecovery(code) {
  if (typeof code !== "string") return "";
  const norm = code.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (norm.length < 8 || norm.length > 32) return "";
  return norm;
}

function playerFromRecovery(code) {
  const norm = normalizeRecovery(code);
  if (!norm) return null;
  const hash = sha256(norm);
  return readCollection("players").find((player) => player.recovery_hash === hash) || null;
}

function issueCredential() {
  const token = crypto.randomBytes(32).toString("base64url");
  const recovery = randomCode(3, 4);
  return {
    token,
    token_hash: sha256(token),
    recovery_code: recovery,
    recovery_hash: sha256(normalizeRecovery(recovery))
  };
}

function parsePlayerFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object" };
  const name = cleanLine(body.name, 60, "Name");
  if (name.error) return name;
  if (!name.text) return { error: "Name is required" };
  const faction = cleanLine(body.faction, 80, "Faction");
  if (faction.error) return faction;
  if (!faction.text) return { error: "Faction is required" };
  const allegiance = parseAllegiance(body.allegiance);
  if (allegiance.error) return allegiance;
  return { name: name.text, faction: faction.text, allegiance: allegiance.allegiance };
}

function parseTierFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object" };
  const name = cleanLine(body.name, 60, "Tier name");
  if (name.error) return name;
  if (!name.text) return { error: "Tier name is required" };
  const points = parsePoints(body.points);
  if (points.error) return points;
  const starts = body.starts_on == null || body.starts_on === "" ? null : parseIsoDate(body.starts_on);
  if (body.starts_on != null && body.starts_on !== "" && !starts) return { error: "Start date must be YYYY-MM-DD" };
  const ends = body.ends_on == null || body.ends_on === "" ? null : parseIsoDate(body.ends_on);
  if (body.ends_on != null && body.ends_on !== "" && !ends) return { error: "End date must be YYYY-MM-DD" };
  if (!starts) return { error: "Start date is required" };
  if (starts && ends && starts > ends) return { error: "End date is before the start date" };
  return { name: name.text, points: points.points, starts_on: starts, ends_on: ends };
}

function parseListFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object" };
  const text = cleanBlock(body.text, 30000, "Army list");
  if (text.error) return text;
  const url = parseUrl(body.url);
  if (url.error) return url;
  return { text: text.text, url: url.url };
}

function resolveTierId(requested) {
  if (requested == null || requested === "") {
    const current = currentTier(readCollection("tiers"), todayIso());
    if (!current) return { error: "No current tier. Choose a tier." };
    return { tier_id: current.tier_id };
  }
  const id = asId(requested);
  if (!id || !findTier(id)) return { error: "Tier was not found" };
  return { tier_id: id };
}

function parseNotes(value) {
  const notes = cleanBlock(value, 2000, "Notes");
  if (notes.error) return notes;
  return { notes: notes.text || null };
}

function saveList(playerId, tierId, text, url) {
  const lists = readCollection("lists");
  const idx = lists.findIndex((list) => list.player_id === playerId && list.tier_id === tierId);
  if (!text && !url) {
    if (idx >= 0) {
      lists.splice(idx, 1);
      writeCollection("lists", lists);
    }
    return null;
  }
  const now = new Date().toISOString();
  if (idx >= 0) {
    lists[idx] = Object.assign({}, lists[idx], { text, url: url || null, updated_at: now });
    writeCollection("lists", lists);
    return lists[idx];
  }
  const row = {
    list_id: allocId("next_list_id"),
    player_id: playerId,
    tier_id: tierId,
    text,
    url: url || null,
    updated_at: now
  };
  const again = readCollection("lists");
  again.push(row);
  writeCollection("lists", again);
  return row;
}

function activePlayer(id) {
  const player = findPlayer(id);
  if (!player || player.removed) return null;
  return player;
}

function buildPlayerReport(player, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object" };
  const opponentId = asId(body.opponent_id);
  if (!opponentId) return { error: "Choose an opponent" };
  if (opponentId === player.player_id) return { error: "Pick another player" };
  const opponent = activePlayer(opponentId);
  if (!opponent) return { error: "Opponent was not found" };
  if (body.result !== "win" && body.result !== "loss" && body.result !== "draw") {
    return { error: "Result must be win, loss, or draw" };
  }
  const tier = resolveTierId(body.tier_id);
  if (tier.error) return tier;
  const myScore = parseScore(body.my_score, "Your score");
  if (myScore.error) return myScore;
  const theirScore = parseScore(body.opponent_score, "Opponent score");
  if (theirScore.error) return theirScore;
  const notes = parseNotes(body.notes);
  if (notes.error) return notes;
  let winnerId = null;
  if (body.result === "win") winnerId = player.player_id;
  if (body.result === "loss") winnerId = opponent.player_id;
  return {
    tier_id: tier.tier_id,
    player_a_id: player.player_id,
    player_b_id: opponent.player_id,
    winner_id: winnerId,
    score_a: myScore.score,
    score_b: theirScore.score,
    notes: notes.notes,
    reported_by: player.player_id
  };
}

function buildAdminReport(body, existing) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object" };
  const a = asId(body.player_a_id);
  const b = asId(body.player_b_id);
  if (!a || !b) return { error: "Choose both players" };
  if (a === b) return { error: "Pick two different players" };
  const playerA = findPlayer(a);
  const playerB = findPlayer(b);
  if (!playerA || !playerB) return { error: "Player was not found" };
  if (!existing && (playerA.removed || playerB.removed)) return { error: "Removed players cannot be added to a new report" };
  if (body.result !== "a_win" && body.result !== "b_win" && body.result !== "draw") {
    return { error: "Result must be a_win, b_win, or draw" };
  }
  const tier = resolveTierId(body.tier_id);
  if (tier.error) return tier;
  const scoreA = parseScore(body.score_a, "Score");
  if (scoreA.error) return scoreA;
  const scoreB = parseScore(body.score_b, "Score");
  if (scoreB.error) return scoreB;
  const notes = parseNotes(body.notes);
  if (notes.error) return notes;
  let winnerId = null;
  if (body.result === "a_win") winnerId = a;
  if (body.result === "b_win") winnerId = b;
  return {
    tier_id: tier.tier_id,
    player_a_id: a,
    player_b_id: b,
    winner_id: winnerId,
    score_a: scoreA.score,
    score_b: scoreB.score,
    notes: notes.notes
  };
}

function insertReport(fields) {
  const now = new Date().toISOString();
  const row = Object.assign(
    {
      report_id: allocId("next_report_id"),
      reported_by: fields.reported_by == null ? null : fields.reported_by,
      created_at: now,
      updated_at: now
    },
    fields,
    { created_at: now, updated_at: now }
  );
  const reports = readCollection("reports");
  reports.push(row);
  writeCollection("reports", reports);
  return row;
}

function trustProxyHops(env) {
  const raw = explicitEnv(env, "TRUST_PROXY").toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off" || raw === "no") return 0;
  if (raw === "true" || raw === "yes" || raw === "on") return 1;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0 && n < 20) return n;
  }
  return 0;
}

function clientIp(req) {
  const hops = trustProxyHops(process.env);
  if (hops > 0) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) {
      const parts = fwd.split(",").map((part) => part.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - hops)];
    }
  }
  const sock = req.socket || req.connection;
  return (sock && sock.remoteAddress) || "unknown";
}

function attemptLimit(action) {
  if (!isProductionEnv(process.env)) {
    const raw = Number(process.env.AUTH_MAX_ATTEMPTS);
    if (Number.isInteger(raw) && raw >= 1 && raw <= 100) return raw;
  }
  if (action === "admin_login" || action === "recover") return 10;
  return 20;
}

function rateLimit(req, action) {
  const limit = attemptLimit(action);
  const now = Date.now();
  const key = action + "|" + clientIp(req);
  let bucket = authBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + AUTH_WINDOW_MS };
    authBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (authBuckets.size > 4000) {
    for (const [k, v] of authBuckets) {
      if (v.resetAt <= now) authBuckets.delete(k);
    }
  }
  if (bucket.count > limit) return { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  return null;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    try {
      out[k] = decodeURIComponent(rest.join("=") || "");
    } catch (_) {
      out[k] = rest.join("=") || "";
    }
  });
  return out;
}

function bearer(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

function adminSession(req) {
  if (isWeakAdminPassword(process.env.ADMIN_PASSWORD)) return null;
  const token = parseCookies(req).el_session;
  if (!token) return null;
  const tag = sha256(String(process.env.ADMIN_PASSWORD));
  const hash = sha256(token);
  const sessions = readCollection("sessions");
  const now = Date.now();
  const live = sessions.filter((session) => new Date(session.expires_at).getTime() > now && session.password_tag === tag);
  if (live.length !== sessions.length) writeCollection("sessions", live);
  return live.find((session) => session.token_hash === hash) || null;
}

function sessionCookie(req, token, maxAge) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = proto === "https" || (req.socket && req.socket.encrypted);
  return (
    "el_session=" +
    encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    maxAge +
    (secure ? "; Secure" : "")
  );
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch (_) {
    return false;
  }
  return url.host === req.headers.host;
}

function requireAdmin(req) {
  if (!adminSession(req)) throw httpError(401, "Admin login required");
  if (req.headers["x-el-request"] !== "1") throw httpError(403, "Missing X-EL-Request header");
  if (!originOk(req)) throw httpError(403, "Cross-origin write blocked");
}

function requirePlayer(req) {
  const token = bearer(req);
  if (!token) throw httpError(401, "Player token required");
  const player = playerFromToken(token);
  if (!player) throw httpError(401, "Player token is not valid");
  if (player.removed) throw httpError(403, "This player was removed from the league");
  return player;
}

function bodyLimit(kind) {
  const raw = Number(kind === "restore" ? process.env.RESTORE_MAX_BYTES : process.env.MAX_BODY_BYTES);
  const fallback = kind === "restore" ? DEFAULT_RESTORE_MAX : DEFAULT_MAX_BODY;
  if (Number.isFinite(raw) && raw >= 1024) return Math.min(Math.floor(raw), 32 * 1024 * 1024);
  return fallback;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(httpError(413, "Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve(null);
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(
          JSON.parse(text, (key, value) => {
            if (key === "__proto__" || key === "prototype" || key === "constructor") {
              throw httpError(400, "Request contains a field this server does not accept");
            }
            return value;
          })
        );
      } catch (err) {
        if (err && err.status) reject(err);
        else reject(httpError(400, "Expected JSON"));
      }
    });
    req.on("error", (err) => fail(err.status ? err : httpError(400, "Could not read the request")));
  });
}

function send(res, status, body, extra) {
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    SECURITY_HEADERS,
    extra || {}
  );
  const payload = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendRateLimited(res, limited) {
  return send(
    res,
    429,
    { error: "Too many attempts. Try again in " + limited.retryAfter + " seconds." },
    { "Retry-After": String(limited.retryAfter) }
  );
}

function rejectUnsafe(value, depth) {
  if (depth > 20) return "Backup is nested too deeply";
  if (value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (value.length > 20000) return "Backup is too large";
    for (const item of value) {
      const err = rejectUnsafe(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length > 40) return "Backup contains a record with too many fields";
  for (const key of keys) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      return "Backup contains a field this server does not accept";
    }
    const err = rejectUnsafe(value[key], depth + 1);
    if (err) return err;
  }
  return null;
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validateBackup(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "Backup must be a JSON object";
  const unsafe = rejectUnsafe(payload, 0);
  if (unsafe) return unsafe;
  const allowed = new Set(["format", "version", "exported_at", "note", "meta", "tiers", "players", "lists", "reports"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) return "Backup contains a field this server does not accept";
  }
  if (payload.format !== BACKUP_FORMAT) return "Unrecognised backup format";
  if (payload.version !== BACKUP_VERSION) return "Unsupported backup version";
  if (!payload.meta || typeof payload.meta !== "object" || Array.isArray(payload.meta)) return "meta must be an object";
  for (const key of ["tiers", "players", "lists", "reports"]) {
    if (!Array.isArray(payload[key])) return key + " must be an array";
  }
  const hasSalt = !!payload.meta.join_code_salt;
  const hasHash = !!payload.meta.join_code_hash;
  if (hasSalt !== hasHash) return "Join code hash is incomplete";
  if (hasSalt && (!isSha256(payload.meta.join_code_hash) || !/^[0-9a-f]{32}$/.test(payload.meta.join_code_salt))) {
    return "Join code hash is not valid";
  }
  const playerIds = new Set();
  for (const player of payload.players) {
    if (!player || typeof player !== "object") return "Invalid player";
    if (!Number.isInteger(player.player_id) || player.player_id < 1) return "Invalid player id";
    if (playerIds.has(player.player_id)) return "Duplicate player id";
    playerIds.add(player.player_id);
    if (typeof player.name !== "string" || !player.name.trim()) return "Invalid player name";
    if (player.allegiance !== "Loyalist" && player.allegiance !== "Traitor") return "Invalid allegiance";
    if (!isSha256(player.token_hash) || !isSha256(player.recovery_hash)) return "Player credentials are not valid";
  }
  const tierIds = new Set();
  for (const tier of payload.tiers) {
    if (!tier || typeof tier !== "object") return "Invalid tier";
    if (!Number.isInteger(tier.tier_id) || tier.tier_id < 1) return "Invalid tier id";
    if (tierIds.has(tier.tier_id)) return "Duplicate tier id";
    tierIds.add(tier.tier_id);
    if (typeof tier.name !== "string" || !tier.name.trim() || tier.name.length > 60) return "Invalid tier name";
    if (!Number.isInteger(tier.points) || tier.points < 1 || tier.points > 100000) return "Invalid tier points";
    const starts = tier.starts_on == null ? null : parseIsoDate(tier.starts_on);
    const ends = tier.ends_on == null ? null : parseIsoDate(tier.ends_on);
    if (tier.starts_on != null && !starts) return "Invalid tier start date";
    if (tier.ends_on != null && !ends) return "Invalid tier end date";
    if (!starts) return "Tier start date is required";
    if (starts && ends && starts > ends) return "Tier dates are out of order";
  }
  const listIds = new Set();
  for (const list of payload.lists) {
    if (!list || typeof list !== "object") return "Invalid army list";
    if (!Number.isInteger(list.list_id) || list.list_id < 1) return "Invalid list id";
    if (listIds.has(list.list_id)) return "Duplicate list id";
    listIds.add(list.list_id);
    if (!playerIds.has(list.player_id) || !tierIds.has(list.tier_id)) return "Army list points at a missing player or tier";
    if (typeof list.text !== "string" || list.text.length > 30000) return "Invalid army list text";
    if (list.url != null && (typeof list.url !== "string" || list.url.length > 400)) return "Invalid army list link";
  }
  const seenLists = new Set();
  for (const list of payload.lists) {
    const key = list.player_id + ":" + list.tier_id;
    if (seenLists.has(key)) return "A player has two lists in one tier";
    seenLists.add(key);
  }
  const reportIds = new Set();
  for (const report of payload.reports) {
    if (!report || typeof report !== "object") return "Invalid report";
    if (!Number.isInteger(report.report_id) || report.report_id < 1) return "Invalid report id";
    if (reportIds.has(report.report_id)) return "Duplicate report id";
    reportIds.add(report.report_id);
    if (!playerIds.has(report.player_a_id) || !playerIds.has(report.player_b_id)) return "Report points at a missing player";
    if (report.player_a_id === report.player_b_id) return "Report lists the same player twice";
    if (!tierIds.has(report.tier_id)) return "Report points at a missing tier";
    if (report.winner_id != null && report.winner_id !== report.player_a_id && report.winner_id !== report.player_b_id) {
      return "Report winner is not one of the players";
    }
  }
  return null;
}

function backupPayload() {
  const meta = readCollection("meta");
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    note: "Player tokens, recovery codes, and the join code are stored as hashes. Admin sessions are not included. Treat this file as secret.",
    meta: {
      join_code_salt: meta.join_code_salt || null,
      join_code_hash: meta.join_code_hash || null,
      next_player_id: meta.next_player_id,
      next_tier_id: meta.next_tier_id,
      next_list_id: meta.next_list_id,
      next_report_id: meta.next_report_id
    },
    tiers: readCollection("tiers"),
    players: readCollection("players"),
    lists: readCollection("lists"),
    reports: readCollection("reports")
  };
}

function backupSummary(payload) {
  return {
    tiers: payload.tiers.length,
    players: payload.players.length,
    lists: payload.lists.length,
    reports: payload.reports.length,
    join_code: !!(payload.meta && payload.meta.join_code_hash),
    player_names: payload.players.map((player) => player.name).slice(0, 30)
  };
}

function rememberRestore(payload) {
  const now = Date.now();
  for (const [key, value] of pendingRestores) {
    if (value.expires <= now) pendingRestores.delete(key);
  }
  const token = crypto.randomBytes(24).toString("hex");
  pendingRestores.set(token, { payload, expires: now + RESTORE_TOKEN_MS });
  return token;
}

function normalizeRestoredMeta(meta, tiers, players, lists, reports) {
  return {
    join_code_salt: meta.join_code_salt || null,
    join_code_hash: meta.join_code_hash || null,
    next_player_id: Math.max(maxId(players, "player_id") + 1, Number(meta.next_player_id) || 1),
    next_tier_id: Math.max(maxId(tiers, "tier_id") + 1, Number(meta.next_tier_id) || 1),
    next_list_id: Math.max(maxId(lists, "list_id") + 1, Number(meta.next_list_id) || 1),
    next_report_id: Math.max(maxId(reports, "report_id") + 1, Number(meta.next_report_id) || 1)
  };
}

function restorePayload(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(DATA, "backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  atomicWrite(path.join(backupDir, "pre-restore-" + stamp + ".json"), dump(backupPayload()));
  const meta = normalizeRestoredMeta(payload.meta, payload.tiers, payload.players, payload.lists, payload.reports);
  writeDataFilesAtomically([
    { name: "meta.json", text: dump(meta) },
    { name: "tiers.json", text: dump(payload.tiers) },
    { name: "players.json", text: dump(payload.players) },
    { name: "lists.json", text: dump(payload.lists) },
    { name: "reports.json", text: dump(payload.reports) },
    { name: "sessions.json", text: dump([]) }
  ]);
}

function listenPort(env) {
  if (env.PORT == null || String(env.PORT).trim() === "") return 3871;
  const n = Number(env.PORT);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n;
}

function noTempsLeft() {
  if (!fs.existsSync(DATA)) return;
  for (const name of fs.readdirSync(DATA)) {
    if (name.includes(".tmp-")) {
      try {
        fs.unlinkSync(path.join(DATA, name));
      } catch (_) {}
    }
  }
}

async function handleApi(req, res, pathname) {
  const url = new URL(req.url, "http://127.0.0.1");
  const method = req.method || "GET";

  if (method === "GET" && pathname === "/api/state") return send(res, 200, publicState());

  if (method === "GET" && pathname === "/api/standings") {
    const tiers = readCollection("tiers");
    const players = readCollection("players");
    const reports = readCollection("reports");
    const requested = url.searchParams.get("tier_id");
    if (!requested || requested === "overall") {
      return send(res, 200, { tier_id: null, standings: standingsFrom(players, reports, null) });
    }
    const id = asId(requested);
    if (!id || !tiers.some((tier) => tier.tier_id === id)) return send(res, 404, { error: "Tier was not found" });
    return send(res, 200, { tier_id: id, standings: standingsFrom(players, reports, id) });
  }

  if (pathname === "/api/join" && method === "POST") {
    const body = await readBody(req, bodyLimit());
    const fields = parsePlayerFields(body || {});
    if (fields.error) return send(res, 400, { error: fields.error });
    const code = body && typeof body.join_code === "string" ? body.join_code.trim() : "";
    if (!code) return send(res, 400, { error: "Join code is required" });
    const limited = rateLimit(req, "join");
    if (limited) return sendRateLimited(res, limited);
    const meta = readCollection("meta");
    if (!meta.join_code_hash || !verifySecret(code, meta.join_code_salt, meta.join_code_hash)) {
      return send(res, 403, { error: "Join code is not valid" });
    }
    const creds = issueCredential();
    const player = {
      player_id: allocId("next_player_id"),
      name: fields.name,
      faction: fields.faction,
      allegiance: fields.allegiance,
      token_hash: creds.token_hash,
      recovery_hash: creds.recovery_hash,
      removed: false,
      created_at: new Date().toISOString()
    };
    const players = readCollection("players");
    players.push(player);
    writeCollection("players", players);
    return send(res, 201, {
      player: publicPlayer(player),
      token: creds.token,
      recovery_code: creds.recovery_code
    });
  }

  if (pathname === "/api/recover" && method === "POST") {
    const body = await readBody(req, bodyLimit());
    const code = body && typeof body.recovery_code === "string" ? body.recovery_code : "";
    if (!normalizeRecovery(code)) return send(res, 400, { error: "Recovery code is required" });
    const limited = rateLimit(req, "recover");
    if (limited) return sendRateLimited(res, limited);
    const player = playerFromRecovery(code);
    if (!player || player.removed) return send(res, 401, { error: "Recovery code is not valid" });
    const token = crypto.randomBytes(32).toString("base64url");
    const players = readCollection("players").map((row) => {
      if (row.player_id !== player.player_id) return row;
      return Object.assign({}, row, { token_hash: sha256(token) });
    });
    writeCollection("players", players);
    const updated = players.find((row) => row.player_id === player.player_id);
    return send(res, 200, { player: publicPlayer(updated), token });
  }

  if (pathname === "/api/me" && method === "GET") {
    const player = requirePlayer(req);
    const today = todayIso();
    const tiers = readCollection("tiers");
    const lists = readCollection("lists").filter((list) => list.player_id === player.player_id);
    const current = currentTier(tiers, today);
    return send(res, 200, {
      player: publicPlayer(player),
      today,
      current_tier_id: current ? current.tier_id : null,
      tiers: tiers.map((tier) => viewTier(tier, today)),
      lists: lists.map(publicList)
    });
  }

  if (pathname === "/api/me" && method === "PUT") {
    const player = requirePlayer(req);
    const body = await readBody(req, bodyLimit());
    const fields = parsePlayerFields(body || {});
    if (fields.error) return send(res, 400, { error: fields.error });
    const players = readCollection("players").map((row) => {
      if (row.player_id !== player.player_id) return row;
      return Object.assign({}, row, {
        name: fields.name,
        faction: fields.faction,
        allegiance: fields.allegiance,
        updated_at: new Date().toISOString()
      });
    });
    writeCollection("players", players);
    return send(res, 200, { player: publicPlayer(players.find((row) => row.player_id === player.player_id)) });
  }

  if (pathname === "/api/lists" && method === "PUT") {
    const player = requirePlayer(req);
    const body = await readBody(req, bodyLimit());
    const tierId = asId(body && body.tier_id);
    const tier = tierId ? findTier(tierId) : null;
    if (!tier) return send(res, 404, { error: "Tier was not found" });
    if (!tierOpenForPlayer(tier, todayIso())) return send(res, 403, { error: "This tier is closed" });
    const fields = parseListFields(body);
    if (fields.error) return send(res, 400, { error: fields.error });
    const saved = saveList(player.player_id, tier.tier_id, fields.text, fields.url);
    return send(res, 200, { list: saved ? publicList(saved) : null });
  }

  if (pathname === "/api/reports" && method === "POST") {
    const player = requirePlayer(req);
    const body = await readBody(req, bodyLimit());
    const fields = buildPlayerReport(player, body || {});
    if (fields.error) return send(res, 400, { error: fields.error });
    const row = insertReport(fields);
    return send(res, 201, { report: publicReport(row) });
  }

  if (pathname === "/api/admin/login" && method === "POST") {
    const body = await readBody(req, bodyLimit());
    const limited = rateLimit(req, "admin_login");
    if (limited) return sendRateLimited(res, limited);
    const password = body && typeof body.password === "string" ? body.password : "";
    if (!password) return send(res, 400, { error: "Password is required" });
    if (isWeakAdminPassword(process.env.ADMIN_PASSWORD)) {
      return send(res, 503, { error: "Admin login is not configured. Set ADMIN_PASSWORD to at least 12 characters." });
    }
    if (!passwordsMatch(password, process.env.ADMIN_PASSWORD)) return send(res, 401, { error: "Wrong password." });
    const token = crypto.randomBytes(32).toString("base64url");
    const sessions = readCollection("sessions");
    const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    sessions.push({
      token_hash: sha256(token),
      password_tag: sha256(String(process.env.ADMIN_PASSWORD)),
      expires_at: expires,
      created_at: new Date().toISOString()
    });
    writeCollection("sessions", sessions);
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, token, SESSION_DAYS * 24 * 60 * 60) });
  }

  if (pathname === "/api/admin/logout" && method === "POST") {
    requireAdmin(req);
    const token = parseCookies(req).el_session;
    const hash = sha256(token || "");
    const sessions = readCollection("sessions").filter((session) => session.token_hash !== hash);
    writeCollection("sessions", sessions);
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  if (pathname === "/api/admin/session" && method === "GET") {
    if (req.headers["x-el-request"] !== "1") return send(res, 403, { error: "Missing X-EL-Request header" });
    return send(res, 200, { authenticated: !!adminSession(req) });
  }

  const tierId = method !== "POST" ? pathId(pathname, "/api/admin/tiers/") : null;
  if (pathname === "/api/admin/tiers" && method === "POST") {
    requireAdmin(req);
    const body = await readBody(req, bodyLimit());
    const fields = parseTierFields(body || {});
    if (fields.error) return send(res, 400, { error: fields.error });
    const tier = Object.assign({ tier_id: allocId("next_tier_id") }, fields);
    const tiers = readCollection("tiers");
    tiers.push(tier);
    writeCollection("tiers", tiers);
    return send(res, 201, { tier: viewTier(tier, todayIso()) });
  }
  if (tierId && method === "PUT" && pathname === "/api/admin/tiers/" + tierId) {
    requireAdmin(req);
    const body = await readBody(req, bodyLimit());
    const fields = parseTierFields(body || {});
    if (fields.error) return send(res, 400, { error: fields.error });
    let found = false;
    const tiers = readCollection("tiers").map((tier) => {
      if (tier.tier_id !== tierId) return tier;
      found = true;
      return Object.assign({}, tier, fields);
    });
    if (!found) return send(res, 404, { error: "Tier was not found" });
    writeCollection("tiers", tiers);
    return send(res, 200, { tier: viewTier(tiers.find((tier) => tier.tier_id === tierId), todayIso()) });
  }
  if (tierId && method === "DELETE" && pathname === "/api/admin/tiers/" + tierId) {
    requireAdmin(req);
    if (!findTier(tierId)) return send(res, 404, { error: "Tier was not found" });
    const lists = readCollection("lists").some((list) => list.tier_id === tierId);
    const reports = readCollection("reports").some((report) => report.tier_id === tierId);
    if (lists || reports) return send(res, 409, { error: "This tier still has lists or games" });
    writeCollection(
      "tiers",
      readCollection("tiers").filter((tier) => tier.tier_id !== tierId)
    );
    return send(res, 200, { ok: true });
  }

  if (pathname === "/api/admin/join-code" && method === "PUT") {
    requireAdmin(req);
    const body = await readBody(req, bodyLimit());
    const code = body && typeof body.join_code === "string" ? body.join_code.trim() : "";
    const weak = isWeakJoinCode(code);
    if (weak) return send(res, 400, { error: "Join code is " + weak + "." });
    const meta = readCollection("meta");
    const hashed = hashSecret(code);
    meta.join_code_salt = hashed.salt;
    meta.join_code_hash = hashed.hash;
    writeCollection("meta", meta);
    return send(res, 200, { ok: true });
  }

  const playerPath = pathname.match(/^\/api\/admin\/players\/([1-9]\d*)$/);
  const recoveryPath = pathname.match(/^\/api\/admin\/players\/([1-9]\d*)\/recovery$/);
  if (recoveryPath && method === "POST") {
    requireAdmin(req);
    const id = Number(recoveryPath[1]);
    const player = findPlayer(id);
    if (!player) return send(res, 404, { error: "Player was not found" });
    const creds = issueCredential();
    player.recovery_hash = creds.recovery_hash;
    const players = readCollection("players").map((row) => (row.player_id === id ? player : row));
    writeCollection("players", players);
    return send(res, 200, { player: publicPlayer(player), recovery_code: creds.recovery_code });
  }
  if (playerPath && method === "PUT") {
    requireAdmin(req);
    const id = Number(playerPath[1]);
    const existing = findPlayer(id);
    if (!existing) return send(res, 404, { error: "Player was not found" });
    const body = await readBody(req, bodyLimit());
    const fields = parsePlayerFields(body || {});
    if (fields.error) return send(res, 400, { error: fields.error });
    let removed = existing.removed;
    if (body && Object.prototype.hasOwnProperty.call(body, "removed")) {
      if (typeof body.removed !== "boolean") return send(res, 400, { error: "removed must be true or false" });
      removed = body.removed;
    }
    const players = readCollection("players").map((row) => {
      if (row.player_id !== id) return row;
      return Object.assign({}, row, {
        name: fields.name,
        faction: fields.faction,
        allegiance: fields.allegiance,
        removed,
        updated_at: new Date().toISOString()
      });
    });
    writeCollection("players", players);
    return send(res, 200, { player: publicPlayer(players.find((row) => row.player_id === id)) });
  }
  if (playerPath && method === "DELETE") {
    requireAdmin(req);
    const id = Number(playerPath[1]);
    const existing = findPlayer(id);
    if (!existing) return send(res, 404, { error: "Player was not found" });
    const players = readCollection("players").map((row) => {
      if (row.player_id !== id) return row;
      return Object.assign({}, row, { removed: true, removed_at: new Date().toISOString() });
    });
    writeCollection("players", players);
    return send(res, 200, { player: publicPlayer(players.find((row) => row.player_id === id)) });
  }

  if (pathname === "/api/admin/lists" && method === "PUT") {
    requireAdmin(req);
    const body = await readBody(req, bodyLimit());
    const playerId = asId(body && body.player_id);
    const tierIdValue = asId(body && body.tier_id);
    if (!playerId || !findPlayer(playerId)) return send(res, 404, { error: "Player was not found" });
    if (!tierIdValue || !findTier(tierIdValue)) return send(res, 404, { error: "Tier was not found" });
    const fields = parseListFields(body || {});
    if (fields.error) return send(res, 400, { error: fields.error });
    const saved = saveList(playerId, tierIdValue, fields.text, fields.url);
    return send(res, 200, { list: saved ? publicList(saved) : null });
  }

  if (pathname === "/api/admin/reports" && method === "POST") {
    requireAdmin(req);
    const body = await readBody(req, bodyLimit());
    const fields = buildAdminReport(body || {}, false);
    if (fields.error) return send(res, 400, { error: fields.error });
    fields.reported_by = null;
    const row = insertReport(fields);
    return send(res, 201, { report: publicReport(row) });
  }

  const reportId = pathId(pathname, "/api/admin/reports/");
  if (reportId && pathname === "/api/admin/reports/" + reportId && method === "PUT") {
    requireAdmin(req);
    const existing = readCollection("reports").find((report) => report.report_id === reportId);
    if (!existing) return send(res, 404, { error: "Report was not found" });
    const body = await readBody(req, bodyLimit());
    const fields = buildAdminReport(body || {}, true);
    if (fields.error) return send(res, 400, { error: fields.error });
    const reports = readCollection("reports").map((report) => {
      if (report.report_id !== reportId) return report;
      return Object.assign({}, report, fields, { updated_at: new Date().toISOString() });
    });
    writeCollection("reports", reports);
    return send(res, 200, { report: publicReport(reports.find((report) => report.report_id === reportId)) });
  }
  if (reportId && pathname === "/api/admin/reports/" + reportId && method === "DELETE") {
    requireAdmin(req);
    const reports = readCollection("reports");
    if (!reports.some((report) => report.report_id === reportId)) return send(res, 404, { error: "Report was not found" });
    writeCollection(
      "reports",
      reports.filter((report) => report.report_id !== reportId)
    );
    return send(res, 200, { ok: true });
  }

  if (pathname === "/api/admin/backup" && method === "GET") {
    requireAdmin(req);
    const body = dump(backupPayload());
    res.writeHead(
      200,
      Object.assign({}, SECURITY_HEADERS, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="escalation-league-backup.json"',
        "Cache-Control": "no-store"
      })
    );
    res.end(body);
    return;
  }

  if (pathname === "/api/admin/backup/preview" && method === "POST") {
    requireAdmin(req);
    const body = await readBody(req, bodyLimit("restore"));
    const problem = validateBackup(body);
    if (problem) return send(res, 400, { error: problem });
    const token = rememberRestore(JSON.parse(JSON.stringify(body)));
    return send(res, 200, { ok: true, restore_token: token, summary: backupSummary(body) });
  }

  if (pathname === "/api/admin/backup/restore" && method === "POST") {
    requireAdmin(req);
    const body = await readBody(req, bodyLimit());
    if (!body || body.confirm !== "RESTORE") return send(res, 400, { error: "Type RESTORE to replace the league." });
    const pending = pendingRestores.get(body.restore_token);
    if (!pending || pending.expires <= Date.now()) return send(res, 400, { error: "Preview expired. Preview the backup again." });
    const problem = validateBackup(pending.payload);
    if (problem) return send(res, 400, { error: problem });
    restorePayload(pending.payload);
    pendingRestores.delete(body.restore_token);
    return send(res, 200, { ok: true, summary: backupSummary(pending.payload) });
  }

  if (pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  return send(res, 405, { error: "Method not allowed" });
}

function resolveStatic(pathname) {
  const rel = pathname.replace(/^\/+/, "");
  if (!rel) return { file: "index.html", type: PUBLIC_TYPES[".html"] };
  if (rel.includes("..") || rel.includes("\\") || rel.startsWith(".")) return null;
  if (PAGES.has(rel)) return { file: rel, type: PUBLIC_TYPES[".html"] };
  if ((rel.startsWith("css/") || rel.startsWith("js/")) && PUBLIC_TYPES[path.extname(rel)]) {
    return { file: rel, type: PUBLIC_TYPES[path.extname(rel)] };
  }
  return null;
}

function serveStatic(res, pathname) {
  const target = resolveStatic(pathname);
  if (!target) {
    res.writeHead(404, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, SECURITY_HEADERS));
    res.end("Not found");
    return;
  }
  const abs = path.resolve(ROOT, target.file);
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(404, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, SECURITY_HEADERS));
    res.end("Not found");
    return;
  }
  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, SECURITY_HEADERS));
      res.end("Not found");
      return;
    }
    res.writeHead(
      200,
      Object.assign({ "Content-Type": target.type, "Cache-Control": "no-cache" }, SECURITY_HEADERS)
    );
    res.end(buf);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
      if (pathname === "/favicon.ico") {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      if (pathname === "/health" || pathname === "/api/health") return send(res, 200, { ok: true });
      if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
      return serveStatic(res, pathname);
    } catch (err) {
      const status = Number(err && err.status) || 500;
      if (status >= 500) console.error(err);
      if (res.headersSent) return;
      try {
        send(res, status, { error: status >= 500 ? "Server error" : err.message || "Request failed" });
      } catch (_) {
        res.writeHead(500);
        res.end("Server error");
      }
    }
  });
}

function start() {
  const decision = collectBootErrors(process.env, ROOT);
  for (const warning of decision.warnings) console.warn(warning);
  if (!decision.ok) {
    for (const error of decision.errors) console.error(error);
    process.exit(1);
  }
  const port = listenPort(process.env);
  if (port == null) {
    console.error("Refusing to start: PORT is not a valid port.");
    process.exit(1);
  }
  DATA = decision.dataDir;
  try {
    ensureLeagueFiles();
    bootstrapJoinCode(process.env);
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
  noTempsLeft();
  const server = createServer();
  server.on("error", (err) => {
    console.error(err.message || err);
    process.exit(1);
  });
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => {
    const addr = server.address();
    const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
    const shownPort = addr && typeof addr === "object" ? addr.port : port;
    console.log("Lost Planet Escalation League");
    console.log("Listening: http://" + shownHost + ":" + shownPort);
    console.log("Data directory: " + DATA);
    console.log("Health: /health");
  });
}

if (require.main === module) start();

module.exports = {
  evaluateDataDirectory,
  collectBootErrors,
  isProductionEnv,
  isWeakAdminPassword,
  isWeakJoinCode,
  currentTier,
  defaultTiers,
  monthBounds,
  tierOpenForPlayer,
  standingsFrom,
  todayIso,
  parseIsoDate
};
