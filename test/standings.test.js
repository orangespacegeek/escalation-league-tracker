"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { standingsFrom } = require("../server.js");

function players() {
  return [
    { player_id: 1, name: "Zara", faction: "Imperial Fists", allegiance: "Loyalist" },
    { player_id: 2, name: "Abel", faction: "Sons of Horus", allegiance: "Traitor" },
    { player_id: 3, name: "Cara", faction: "Word Bearers", allegiance: "Traitor" },
    { player_id: 5, name: "Bea", faction: "Raven Guard", allegiance: "Loyalist" },
    { player_id: 4, name: "Gone", faction: "Night Lords", allegiance: "Traitor", removed: true }
  ];
}

test("standings count wins, losses, draws, and games per tier and overall", () => {
  const reports = [
    { tier_id: 1, player_a_id: 1, player_b_id: 2, winner_id: 1 },
    { tier_id: 1, player_a_id: 2, player_b_id: 3, winner_id: null },
    { tier_id: 2, player_a_id: 1, player_b_id: 3, winner_id: 3 },
    { tier_id: 1, player_a_id: 1, player_b_id: 1, winner_id: 1 },
    { tier_id: 1, player_a_id: 1, player_b_id: 2, winner_id: 99 }
  ];
  const tier1 = standingsFrom(players(), reports, 1);
  const byId = (rows) => Object.fromEntries(rows.map((row) => [row.player_id, row]));
  const rows = byId(tier1.rows);
  assert.deepEqual({ w: rows[1].w, l: rows[1].l, d: rows[1].d, played: rows[1].played }, { w: 1, l: 0, d: 0, played: 1 });
  assert.deepEqual({ w: rows[2].w, l: rows[2].l, d: rows[2].d, played: rows[2].played }, { w: 0, l: 1, d: 1, played: 2 });
  assert.deepEqual({ w: rows[3].w, l: rows[3].l, d: rows[3].d, played: rows[3].played }, { w: 0, l: 0, d: 1, played: 1 });
  assert.equal(rows[4], undefined);
  assert.deepEqual(tier1.not_played.map((row) => row.name), ["Bea"]);

  const tier2 = standingsFrom(players(), reports, 2);
  assert.deepEqual(tier2.rows.map((row) => row.player_id), [3, 1]);
  assert.equal(tier2.rows[0].w, 1);
  assert.equal(tier2.rows[1].l, 1);
  assert.deepEqual(tier2.not_played.map((row) => row.name), ["Abel", "Bea"]);

  const overall = standingsFrom(players(), reports, null);
  assert.deepEqual(overall.rows.map((row) => row.name), ["Cara", "Zara", "Abel"]);
  assert.deepEqual(
    overall.rows.map((row) => [row.w, row.l, row.d, row.played]),
    [
      [1, 0, 1, 2],
      [1, 1, 0, 2],
      [0, 1, 1, 2]
    ]
  );
  assert.deepEqual(overall.not_played.map((row) => row.name), ["Bea"]);
});

test("a removed player with games stays on the table and one without games does not", () => {
  const list = players().map((player) => (player.player_id === 1 ? { ...player, removed: true } : player));
  const reports = [{ tier_id: 1, player_a_id: 1, player_b_id: 2, winner_id: 2 }];
  const table = standingsFrom(list, reports, 1);
  const zara = table.rows.find((row) => row.player_id === 1);
  assert.equal(zara.removed, true);
  assert.equal(zara.l, 1);
  assert.equal(table.not_played.some((row) => row.player_id === 1), false);
  assert.equal(table.not_played.some((row) => row.name === "Gone"), false);
  assert.equal(table.rows[0].name, "Abel");
});

test("equal records sort by name", () => {
  const list = [
    { player_id: 1, name: "Mia", faction: "A", allegiance: "Loyalist" },
    { player_id: 2, name: "Ann", faction: "B", allegiance: "Traitor" }
  ];
  const reports = [{ tier_id: 1, player_a_id: 1, player_b_id: 2, winner_id: null }];
  const table = standingsFrom(list, reports, 1);
  assert.deepEqual(table.rows.map((row) => row.name), ["Ann", "Mia"]);
  assert.equal(table.rows[0].d, 1);
  assert.equal(table.rows[0].played, 1);
});
