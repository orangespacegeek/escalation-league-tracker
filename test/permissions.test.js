"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { withServer, api, adminCookie, join } = require("./support/http.js");

test("players edit only their own open lists; admins can always edit reports and lists", { timeout: 30000 }, async () => {
  await withServer({ LEAGUE_TODAY: "2026-11-15" }, async (ctx) => {
    const a = await join(ctx, "Alpha");
    const b = await join(ctx, "Beta", { faction: "Sons of Horus", allegiance: "Traitor" });
    const c = await join(ctx, "Cara", { faction: "World Eaters", allegiance: "Traitor" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(c.status, 201);
    const tokenA = a.json.token;
    const tokenB = b.json.token;

    const state = await api(ctx, "GET", "/api/state");
    assert.equal(state.json.current_tier_id, 1);
    const saved = await api(ctx, "PUT", "/api/lists", { tier_id: 1, text: "Alpha's fist", url: "" }, { token: tokenA });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.list.text, "Alpha's fist");
    const betaList = await api(
      ctx,
      "PUT",
      "/api/lists",
      { tier_id: 1, text: "Beta's spears", url: "https://example.com/beta" },
      { token: tokenB }
    );
    assert.equal(betaList.status, 200);
    const script = await api(ctx, "PUT", "/api/lists", { tier_id: 1, text: "nope", url: "javascript:alert(1)" }, { token: tokenA });
    assert.equal(script.status, 400);

    const reported = await api(ctx, "POST", "/api/reports", {
      opponent_id: b.json.player.player_id,
      result: "win",
      my_score: 12,
      opponent_score: 8,
      notes: "Zone Mortalis"
    }, { token: tokenA });
    assert.equal(reported.status, 201);
    assert.equal(reported.json.report.winner_id, a.json.player.player_id);
    assert.equal(reported.json.report.tier_id, 1);

    const draw = await api(ctx, "POST", "/api/reports", {
      opponent_id: c.json.player.player_id,
      result: "draw",
      tier_id: 2
    }, { token: tokenB });
    assert.equal(draw.status, 201);

    const table = await api(ctx, "GET", "/api/standings?tier_id=1");
    const alpha = table.json.standings.rows.find((row) => row.name === "Alpha");
    const beta = table.json.standings.rows.find((row) => row.name === "Beta");
    assert.deepEqual({ w: alpha.w, l: alpha.l, d: alpha.d, played: alpha.played }, { w: 1, l: 0, d: 0, played: 1 });
    assert.deepEqual({ w: beta.w, l: beta.l, d: beta.d, played: beta.played }, { w: 0, l: 1, d: 0, played: 1 });
    assert.deepEqual(table.json.standings.not_played.map((row) => row.name), ["Cara"]);

    const overall = await api(ctx, "GET", "/api/standings?tier_id=overall");
    const betaOverall = overall.json.standings.rows.find((row) => row.name === "Beta");
    assert.equal(betaOverall.played, 2);
    assert.equal(betaOverall.d, 1);

    const sneaky = await api(ctx, "PUT", "/api/admin/lists", {
      player_id: b.json.player.player_id,
      tier_id: 1,
      text: "stolen",
      url: ""
    }, { token: tokenA });
    assert.equal(sneaky.status, 401);
    const deleted = await api(ctx, "DELETE", "/api/admin/reports/" + reported.json.report.report_id, undefined, { token: tokenA });
    assert.equal(deleted.status, 401);
    const still = await api(ctx, "GET", "/api/state");
    assert.equal(still.json.lists.find((list) => list.player_id === b.json.player.player_id).text, "Beta's spears");

    const renamed = await api(ctx, "PUT", "/api/me", {
      name: "Alpha Prime",
      faction: "Imperial Fists",
      allegiance: "Loyalist"
    }, { token: tokenA });
    assert.equal(renamed.status, 200);
    const names = await api(ctx, "GET", "/api/state");
    assert.equal(names.json.players.find((player) => player.player_id === b.json.player.player_id).name, "Beta");

    const { cookie } = await adminCookie(ctx);
    const closed = await api(ctx, "PUT", "/api/admin/tiers/1", {
      name: "1000 pts",
      points: 1000,
      starts_on: "2026-11-01",
      ends_on: "2026-11-01"
    }, { cookie });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.tier.open, false);
    const locked = await api(ctx, "PUT", "/api/lists", { tier_id: 1, text: "too late", url: "" }, { token: tokenA });
    assert.equal(locked.status, 403);
    assert.match(locked.json.error, /closed/);
    const adminList = await api(ctx, "PUT", "/api/admin/lists", {
      player_id: a.json.player.player_id,
      tier_id: 1,
      text: "admin fix",
      url: "https://example.com/alpha"
    }, { cookie });
    assert.equal(adminList.status, 200);

    const edited = await api(ctx, "PUT", "/api/admin/reports/" + reported.json.report.report_id, {
      player_a_id: a.json.player.player_id,
      player_b_id: b.json.player.player_id,
      tier_id: 1,
      result: "draw",
      score_a: 10,
      score_b: 10,
      notes: "adjusted"
    }, { cookie });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.report.winner_id, null);
    const afterDraw = await api(ctx, "GET", "/api/standings?tier_id=1");
    assert.equal(afterDraw.json.standings.rows.find((row) => row.name === "Alpha Prime").d, 1);
    assert.equal(afterDraw.json.standings.rows.find((row) => row.name === "Alpha Prime").w, 0);

    const removed = await api(ctx, "DELETE", "/api/admin/reports/" + draw.json.report.report_id, undefined, { cookie });
    assert.equal(removed.status, 200);
    const gone = await api(ctx, "GET", "/api/state");
    assert.equal(gone.json.reports.some((report) => report.report_id === draw.json.report.report_id), false);

    const removedPlayer = await api(ctx, "DELETE", "/api/admin/players/" + c.json.player.player_id, undefined, { cookie });
    assert.equal(removedPlayer.status, 200);
    const caraMe = await api(ctx, "GET", "/api/me", undefined, { token: c.json.token });
    assert.equal(caraMe.status, 403);
    const finalTable = await api(ctx, "GET", "/api/standings?tier_id=1");
    assert.equal(finalTable.json.standings.not_played.some((row) => row.name === "Cara"), false);

    const blockedTier = await api(ctx, "DELETE", "/api/admin/tiers/1", undefined, { cookie });
    assert.equal(blockedTier.status, 409);
    const created = await api(ctx, "POST", "/api/admin/tiers", {
      name: "Spare",
      points: 750,
      starts_on: "2026-08-01",
      ends_on: "2026-08-31"
    }, { cookie });
    assert.equal(created.status, 201);
    const removedTier = await api(ctx, "DELETE", "/api/admin/tiers/" + created.json.tier.tier_id, undefined, { cookie });
    assert.equal(removedTier.status, 200);
  });
});
