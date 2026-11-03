"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JOIN_CODE, withServer, api, adminCookie, join } = require("./support/http.js");

test("backup preview does not write, and RESTORE replaces the league", { timeout: 30000 }, async () => {
  await withServer({}, async (ctx) => {
    const joined = await join(ctx, "Alpha");
    assert.equal(joined.status, 201);
    const token = joined.json.token;
    const { cookie } = await adminCookie(ctx);
    const list = await api(ctx, "PUT", "/api/lists", { tier_id: 1, text: "original list", url: "" }, { token });
    assert.equal(list.status, 200);

    const backup = await api(ctx, "GET", "/api/admin/backup", undefined, { cookie });
    assert.equal(backup.status, 200);
    assert.match(backup.headers.get("content-disposition") || "", /escalation-league-backup\.json/);
    assert.equal(backup.text.includes(token), false);
    assert.equal(backup.text.includes(JOIN_CODE), false);
    assert.equal(backup.text.includes(joined.json.recovery_code), false);
    assert.equal(backup.json.format, "escalation-league-backup");
    assert.equal(backup.json.players[0].name, "Alpha");
    assert.equal(typeof backup.json.players[0].token_hash, "string");

    const renamed = await api(ctx, "PUT", "/api/me", {
      name: "Beta",
      faction: "Imperial Fists",
      allegiance: "Loyalist"
    }, { token });
    assert.equal(renamed.status, 200);
    const playersPath = path.join(ctx.dataDir, "players.json");
    const beforePreview = fs.readFileSync(playersPath, "utf8");

    const bad = await api(ctx, "POST", "/api/admin/backup/preview", { format: "nope" }, { cookie });
    assert.equal(bad.status, 400);
    assert.equal(fs.readFileSync(playersPath, "utf8"), beforePreview);

    const preview = await api(ctx, "POST", "/api/admin/backup/preview", backup.json, { cookie });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.summary.players, 1);
    assert.equal(preview.json.summary.lists, 1);
    assert.equal(preview.json.summary.join_code, true);
    assert.equal((await api(ctx, "GET", "/api/me", undefined, { token })).json.player.name, "Beta");

    const wrong = await api(ctx, "POST", "/api/admin/backup/restore", {
      confirm: "restore",
      restore_token: preview.json.restore_token
    }, { cookie });
    assert.equal(wrong.status, 400);
    assert.equal((await api(ctx, "GET", "/api/me", undefined, { token })).json.player.name, "Beta");

    const restored = await api(ctx, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: preview.json.restore_token
    }, { cookie });
    assert.equal(restored.status, 200);
    assert.equal((await api(ctx, "GET", "/api/me", undefined, { token })).json.player.name, "Alpha");
    const lists = await api(ctx, "GET", "/api/state");
    assert.equal(lists.json.lists[0].text, "original list");

    const again = await adminCookie(ctx);
    const replay = await api(ctx, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: preview.json.restore_token
    }, { cookie: again.cookie });
    assert.equal(replay.status, 400);

    const backups = fs.readdirSync(path.join(ctx.dataDir, "backups"));
    assert.equal(backups.some((name) => name.startsWith("pre-restore-")), true);
    const pre = fs.readFileSync(path.join(ctx.dataDir, "backups", backups[0]), "utf8");
    assert.match(pre, /Beta/);
    assert.equal(fs.readdirSync(ctx.dataDir).some((name) => name.includes(".tmp-")), false);

    const rejoined = await join(ctx, "Gamma");
    assert.equal(rejoined.status, 201);
    const session = await api(ctx, "GET", "/api/admin/session", undefined, { cookie });
    assert.equal(session.json.authenticated, false);
  });
});
