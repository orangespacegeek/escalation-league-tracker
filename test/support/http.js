"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const ADMIN_PW = "test-admin-pw-123";
const JOIN_CODE = "lost-planet";

function baseEnv(extra) {
  const env = { ...process.env };
  for (const key of [
    "RENDER",
    "ALLOW_EPHEMERAL_DATA",
    "LEAGUE_TODAY",
    "JOIN_CODE_FORCE",
    "JOIN_CODE",
    "ADMIN_PASSWORD",
    "DATA_DIR",
    "TRUST_PROXY",
    "AUTH_MAX_ATTEMPTS",
    "NODE_ENV",
    "PORT",
    "HOST"
  ]) {
    delete env[key];
  }
  env.NODE_ENV = "test";
  env.HOST = "127.0.0.1";
  env.PORT = "0";
  env.ADMIN_PASSWORD = ADMIN_PW;
  env.JOIN_CODE = JOIN_CODE;
  env.TRUST_PROXY = "";
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function runServer(extra) {
  return spawnSync(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: baseEnv(extra),
    encoding: "utf8",
    timeout: 8000
  });
}

function startServer(extra) {
  const env = baseEnv(extra);
  let dataDir = env.DATA_DIR;
  let owned = false;
  if (!dataDir) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "el-data-"));
    env.DATA_DIR = dataDir;
    owned = true;
  }
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("server did not start\n" + log));
    }, 8000);
    const onData = (chunk) => {
      log += chunk;
      if (!settled && log.includes("Health:")) {
        settled = true;
        clearTimeout(timer);
        const match = log.match(/Listening: http:\/\/([^:\s]+):(\d+)/);
        if (!match) {
          reject(new Error("no listen line\n" + log));
          return;
        }
        resolve("http://" + match[1] + ":" + match[2]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("server exited " + code + "\n" + log));
    });
  });
  return {
    dataDir,
    ready,
    log() {
      return log;
    },
    async stop() {
      await ready.catch(() => {});
      await new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode != null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.removeAllListeners("exit");
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
      if (owned) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

async function withServer(extra, fn) {
  const ctx = startServer(extra);
  try {
    ctx.base = await ctx.ready;
    return await fn(ctx);
  } finally {
    await ctx.stop();
  }
}

async function api(ctx, method, pathname, body, opts = {}) {
  const headers = { "X-EL-Request": "1", ...(opts.headers || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = "Bearer " + opts.token;
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(ctx.base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { raw: text };
  }
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, json, text, setCookie, headers: res.headers };
}

function cookieHeader(setCookie) {
  return ((setCookie && setCookie[0]) || "").split(";")[0];
}

async function adminCookie(ctx, password = ADMIN_PW) {
  const login = await api(ctx, "POST", "/api/admin/login", { password });
  if (login.status !== 200) {
    throw new Error("admin login failed " + login.status + " " + JSON.stringify(login.json));
  }
  return { cookie: cookieHeader(login.setCookie), login };
}

async function join(ctx, name, extra = {}) {
  return api(ctx, "POST", "/api/join", {
    join_code: extra.join_code || JOIN_CODE,
    name,
    faction: extra.faction || "Imperial Fists",
    allegiance: extra.allegiance || "Loyalist"
  });
}

module.exports = {
  ROOT,
  ADMIN_PW,
  JOIN_CODE,
  runServer,
  withServer,
  api,
  cookieHeader,
  adminCookie,
  join
};
