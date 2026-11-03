"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { currentTier, defaultTiers, monthBounds, tierOpenForPlayer, todayIso } = require("../server.js");

test("default tiers are 1000, 1500, and 2000, one calendar month each", () => {
  const tiers = defaultTiers("2026-11-03");
  assert.deepEqual(tiers.map((tier) => tier.points), [1000, 1500, 2000]);
  assert.deepEqual(tiers.map((tier) => tier.name), ["1000 pts", "1500 pts", "2000 pts"]);
  assert.deepEqual(
    tiers.map((tier) => [tier.starts_on, tier.ends_on]),
    [
      ["2026-11-01", "2026-11-30"],
      ["2026-12-01", "2026-12-31"],
      ["2027-01-01", "2027-01-31"]
    ]
  );
  assert.deepEqual(monthBounds(2028, 1), { starts_on: "2028-02-01", ends_on: "2028-02-29" });
  const leap = defaultTiers("2028-01-15");
  assert.equal(leap[1].ends_on, "2028-02-29");
  assert.equal(defaultTiers("2027-01-15")[1].ends_on, "2027-02-28");
});

test("the current tier is the one whose dates contain today, inclusive", () => {
  const tiers = defaultTiers("2026-11-03");
  assert.equal(currentTier(tiers, "2026-11-01").tier_id, 1);
  assert.equal(currentTier(tiers, "2026-11-30").points, 1000);
  assert.equal(currentTier(tiers, "2026-10-31"), null);
  assert.equal(currentTier(tiers, "2026-12-31").points, 1500);
  assert.equal(currentTier(tiers, "2027-01-15").points, 2000);
  assert.equal(currentTier(tiers, "2027-02-01"), null);
  assert.equal(currentTier([{ tier_id: 9, points: 500, starts_on: "nope", ends_on: "2026-11-03" }], "2026-11-03"), null);
});

test("overlapping tiers pick the later start, then the higher points value", () => {
  const overlap = [
    { tier_id: 1, points: 1000, starts_on: "2026-11-01", ends_on: "2026-11-30" },
    { tier_id: 2, points: 1500, starts_on: "2026-11-15", ends_on: "2026-12-15" }
  ];
  assert.equal(currentTier(overlap, "2026-11-20").tier_id, 2);
  assert.equal(currentTier(overlap, "2026-11-10").tier_id, 1);
  const sameStart = [
    { tier_id: 1, points: 1000, starts_on: "2026-11-01", ends_on: "2026-11-30" },
    { tier_id: 2, points: 2000, starts_on: "2026-11-01", ends_on: "2026-11-30" }
  ];
  assert.equal(currentTier(sameStart, "2026-11-03").tier_id, 2);
});

test("a player can edit a list through the end date and not after", () => {
  const open = { ends_on: "2026-11-30" };
  assert.equal(tierOpenForPlayer(open, "2026-11-30"), true);
  assert.equal(tierOpenForPlayer(open, "2026-12-01"), false);
  assert.equal(tierOpenForPlayer({ starts_on: "2026-12-01", ends_on: "2026-12-31" }, "2026-11-01"), true);
  assert.equal(tierOpenForPlayer({ starts_on: "2026-11-01", ends_on: null }, "2026-12-01"), true);
  assert.equal(tierOpenForPlayer({ ends_on: "2026-02-31" }, "2026-02-01"), false);
  assert.equal(tierOpenForPlayer(null, "2026-11-01"), false);
});

test("LEAGUE_TODAY is ignored in production", () => {
  const now = new Date("2026-11-03T15:00:00Z");
  assert.equal(todayIso({ NODE_ENV: "production", LEAGUE_TODAY: "1999-01-01" }, now), "2026-11-03");
  assert.equal(todayIso({ RENDER: "true", LEAGUE_TODAY: "1999-01-01" }, now), "2026-11-03");
  assert.equal(todayIso({ NODE_ENV: "test", LEAGUE_TODAY: "1999-01-01" }, now), "1999-01-01");
});
