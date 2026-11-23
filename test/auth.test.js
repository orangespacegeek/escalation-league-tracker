"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ADMIN_PW, JOIN_CODE, withServer, api, adminCookie, join } = require("./support/http.js");

function dataText(dir) {
  return fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
}

test("join code, recovery, and admin session", { timeout: 20000 }, async () => {
  await withServer({}, async (ctx) => {
    const wrong = await join(ctx, "Nobody", { join_code: "not-the-code" });
    assert.equal(wrong.status, 403);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "players.json"), "utf8")), []);

    const badSide = await join(ctx, "Nobody", { allegiance: "Renegade" });
    assert.equal(badSide.status, 400);

    const joined = await join(ctx, "Horus", { faction: "Sons of Horus", allegiance: "Traitor" });
    assert.equal(joined.status, 201);
    assert.equal(joined.json.player.name, "Horus");
    assert.equal(joined.json.player.allegiance, "Traitor");
    const token = joined.json.token;
    const recovery = joined.json.recovery_code;
    assert.match(recovery, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = dataText(ctx.dataDir);
    assert.equal(stored.includes(token), false);
    assert.equal(stored.includes(recovery), false);
    assert.equal(stored.includes(JOIN_CODE), false);
    assert.equal(stored.includes("token_hash"), true);
    assert.equal(fs.readdirSync(ctx.dataDir).some((name) => name.includes(".tmp-")), false);

    const me = await api(ctx, "GET", "/api/me", undefined, { token });
    assert.equal(me.status, 200);
    assert.equal(me.json.player.faction, "Sons of Horus");
    const state = await api(ctx, "GET", "/api/state");
    assert.equal(JSON.stringify(state.json).includes("token_hash"), false);
    assert.equal(JSON.stringify(state.json).includes(recovery), false);

    const bogus = await api(ctx, "GET", "/api/me", undefined, { token: token + "nope" });
    assert.equal(bogus.status, 401);

    const again = await api(ctx, "POST", "/api/recover", { recovery_code: recovery.toLowerCase() });
    assert.equal(again.status, 200);
    assert.equal(again.json.token === token, false);
    const signedOut = await api(ctx, "GET", "/api/me", undefined, { token });
    assert.equal(signedOut.status, 401);
    const signedIn = await api(ctx, "GET", "/api/me", undefined, { token: again.json.token });
    assert.equal(signedIn.status, 200);
    const compact = await api(ctx, "POST", "/api/recover", { recovery_code: recovery.replace(/-/g, "") });
    assert.equal(compact.status, 200);

    const missed = await api(ctx, "POST", "/api/admin/login", { password: "wrong-password-1" });
    assert.equal(missed.status, 401);
    assert.equal(missed.setCookie.length, 0);

    const { cookie, login } = await adminCookie(ctx);
    assert.match(login.setCookie[0], /el_session=/);
    assert.match(login.setCookie[0], /HttpOnly/);
    assert.match(login.setCookie[0], /SameSite=Lax/);
    assert.doesNotMatch(login.setCookie[0], /Secure/);
    assert.equal(dataText(ctx.dataDir).includes(cookie.split("=")[1]), false);

    const session = await api(ctx, "GET", "/api/admin/session", undefined, { cookie });
    assert.equal(session.json.authenticated, true);
    const stranger = await api(ctx, "GET", "/api/admin/session");
    assert.equal(stranger.json.authenticated, false);
    const noHeader = await api(ctx, "PUT", "/api/admin/join-code", { join_code: "another-code" }, {
      cookie,
      headers: { "X-EL-Request": "" }
    });
    assert.equal(noHeader.status, 403);
    const noCookie = await api(ctx, "GET", "/api/admin/backup");
    assert.equal(noCookie.status, 401);

    const changed = await api(ctx, "PUT", "/api/admin/join-code", { join_code: "new-code-99" }, { cookie });
    assert.equal(changed.status, 200);
    const oldCode = await join(ctx, "Late");
    assert.equal(oldCode.status, 403);
    const newCode = await join(ctx, "Late", { join_code: "new-code-99" });
    assert.equal(newCode.status, 201);

    const loggedOut = await api(ctx, "POST", "/api/admin/logout", {}, { cookie });
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.setCookie[0], /Max-Age=0/);
    const after = await api(ctx, "GET", "/api/admin/session", undefined, { cookie });
    assert.equal(after.json.authenticated, false);
  });
});

test("join and admin login are rate limited per socket, ignoring a spoofed forwarded header", { timeout: 20000 }, async () => {
  await withServer({ AUTH_MAX_ATTEMPTS: "2", TRUST_PROXY: "" }, async (ctx) => {
    const first = await api(ctx, "POST", "/api/admin/login", { password: "nope-nope-nope" }, {
      headers: { "X-Forwarded-For": "1.1.1.1" }
    });
    const second = await api(ctx, "POST", "/api/admin/login", { password: "nope-nope-nope" }, {
      headers: { "X-Forwarded-For": "2.2.2.2" }
    });
    const third = await api(ctx, "POST", "/api/admin/login", { password: ADMIN_PW }, {
      headers: { "X-Forwarded-For": "3.3.3.3" }
    });
    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(third.status, 429);
    assert.match(third.json.error, /Too many attempts/);

    const badJoin = await join(ctx, "A", { join_code: "wrong-code" });
    const badJoin2 = await join(ctx, "B", { join_code: "wrong-code" });
    const blocked = await join(ctx, "C");
    assert.equal(badJoin.status, 403);
    assert.equal(badJoin2.status, 403);
    assert.equal(blocked.status, 429);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "players.json"), "utf8")), []);
  });
});

test("TRUST_PROXY=1 rate limits the forwarded client, not the proxy", { timeout: 20000 }, async () => {
  await withServer({ AUTH_MAX_ATTEMPTS: "1", TRUST_PROXY: "1" }, async (ctx) => {
    const a = await api(ctx, "POST", "/api/admin/login", { password: "nope-nope-nope" }, {
      headers: { "X-Forwarded-For": "8.8.8.8" }
    });
    const b = await api(ctx, "POST", "/api/admin/login", { password: "nope-nope-nope" }, {
      headers: { "X-Forwarded-For": "9.9.9.9" }
    });
    const c = await api(ctx, "POST", "/api/admin/login", { password: "nope-nope-nope" }, {
      headers: { "X-Forwarded-For": "1.1.1.1, 8.8.8.8" }
    });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(c.status, 429);
  });
});

test("development prints a join code when JOIN_CODE is unset and refuses a weak admin password", { timeout: 20000 }, async () => {
  await withServer({ JOIN_CODE: null, ADMIN_PASSWORD: null }, async (ctx) => {
    assert.match(ctx.log(), /JOIN_CODE \(printed once/);
    assert.match(ctx.log(), /ADMIN_PASSWORD is missing or weak/);
    const code = ctx.log().match(/code=(\S+)/)[1];
    const joined = await join(ctx, "Local", { join_code: code });
    assert.equal(joined.status, 201);
    assert.equal(dataText(ctx.dataDir).includes(code), false);
    const login = await api(ctx, "POST", "/api/admin/login", { password: "whatever-it-is" });
    assert.equal(login.status, 503);
  });
});
