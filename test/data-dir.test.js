"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { evaluateDataDirectory, isWeakAdminPassword } = require("../server.js");
const { ROOT, ADMIN_PW, JOIN_CODE, runServer, withServer, api } = require("./support/http.js");

test("development warns when DATA_DIR is unset and still allows the repo data directory", () => {
  const unset = evaluateDataDirectory({ NODE_ENV: "development" }, ROOT);
  assert.equal(unset.ok, true);
  assert.equal(unset.unset, true);
  assert.equal(unset.production, false);
  assert.equal(unset.inside, true);
  assert.equal(unset.dataDir, path.join(ROOT, "data"));
  assert.match(unset.warnings.join("\n"), /DATA_DIR is unset/);
  assert.equal(unset.errors.length, 0);

  const explicit = evaluateDataDirectory({ DATA_DIR: path.join(ROOT, "data") }, ROOT);
  assert.equal(explicit.ok, true);
  assert.equal(explicit.warnings.length, 0);

  const blank = evaluateDataDirectory({ NODE_ENV: "production", DATA_DIR: "   " }, ROOT);
  assert.equal(blank.ok, false);
  assert.equal(blank.unset, true);
  assert.match(blank.errors.join("\n"), /Refusing to start/);
});

test("production refuses an unset or in-repo DATA_DIR unless the ephemeral override is exactly 1", () => {
  const unset = evaluateDataDirectory({ NODE_ENV: "production" }, ROOT);
  assert.equal(unset.ok, false);
  assert.match(unset.errors.join("\n"), /Refusing to start/);
  assert.match(unset.errors.join("\n"), /ALLOW_EPHEMERAL_DATA=1/);
  assert.match(unset.errors.join("\n"), /\/var\/data/);

  const render = evaluateDataDirectory({ RENDER: "true" }, ROOT);
  assert.equal(render.production, true);
  assert.equal(render.ok, false);

  const renderWord = evaluateDataDirectory({ RENDER: "false" }, ROOT);
  assert.equal(renderWord.production, true);

  const renderEmpty = evaluateDataDirectory({ RENDER: "" }, ROOT);
  assert.equal(renderEmpty.production, false);
  assert.equal(renderEmpty.ok, true);

  const inside = evaluateDataDirectory(
    { NODE_ENV: "production", DATA_DIR: path.join(ROOT, "data", "..", "data") },
    ROOT
  );
  assert.equal(inside.inside, true);
  assert.equal(inside.ok, false);

  const outside = path.join(os.tmpdir(), "el-missing-" + process.pid, "league");
  const external = evaluateDataDirectory({ NODE_ENV: "production", DATA_DIR: outside, RENDER: "true" }, ROOT);
  assert.equal(external.ok, true);
  assert.equal(external.inside, false);
  assert.equal(external.warnings.length, 0);
  assert.equal(external.dataDir, path.resolve(outside));

  const word = evaluateDataDirectory({ NODE_ENV: "production", ALLOW_EPHEMERAL_DATA: "true" }, ROOT);
  assert.equal(word.ok, false);

  const override = evaluateDataDirectory({ NODE_ENV: "production", ALLOW_EPHEMERAL_DATA: "1" }, ROOT);
  assert.equal(override.ok, true);
  assert.match(override.warnings.join("\n"), /ALLOW_EPHEMERAL_DATA=1/);
  assert.match(override.warnings.join("\n"), /Data directory: \/var\/data/);
});

test("a symlink that resolves inside the app is still inside", () => {
  const inside = fs.mkdtempSync(path.join(ROOT, "el-inside-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "el-link-"));
  const link = path.join(parent, "store");
  fs.symlinkSync(inside, link);
  try {
    const result = evaluateDataDirectory({ NODE_ENV: "production", DATA_DIR: link }, ROOT);
    assert.equal(result.inside, true);
    assert.equal(result.ok, false);
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("admin passwords under 12 characters, common phrases, and all digits are weak", () => {
  assert.equal(isWeakAdminPassword(null), "missing");
  assert.equal(isWeakAdminPassword("   "), "missing");
  assert.equal(isWeakAdminPassword("short"), "too short");
  assert.equal(isWeakAdminPassword("password1234"), "a common password");
  assert.equal(isWeakAdminPassword("123456789012"), "too simple");
  assert.equal(isWeakAdminPassword("aaaaaaaaaaaa"), "too repetitive");
  assert.equal(isWeakAdminPassword(ADMIN_PW), null);
});

test("a production process refuses to start when DATA_DIR is unset and does not create ./data", () => {
  const result = runServer({
    NODE_ENV: "production",
    ADMIN_PASSWORD: ADMIN_PW,
    JOIN_CODE,
    ALLOW_EPHEMERAL_DATA: "true"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to start: DATA_DIR/);
  assert.doesNotMatch(result.stdout, /Lost Planet Escalation League/);
  assert.equal(fs.existsSync(path.join(ROOT, "data")), false);
});

test("production refuses a weak admin password and a missing or weak join code before writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "el-boot-"));
  try {
    const weak = runServer({ NODE_ENV: "production", DATA_DIR: dir, ADMIN_PASSWORD: "password1234", JOIN_CODE });
    assert.equal(weak.status, 1);
    assert.match(weak.stderr, /ADMIN_PASSWORD/);
    assert.equal(fs.existsSync(path.join(dir, "players.json")), false);

    const missing = runServer({ NODE_ENV: "production", DATA_DIR: dir, ADMIN_PASSWORD: ADMIN_PW, JOIN_CODE: null });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /JOIN_CODE is missing/);

    const easy = runServer({ NODE_ENV: "production", DATA_DIR: dir, ADMIN_PASSWORD: ADMIN_PW, JOIN_CODE: "password" });
    assert.equal(easy.status, 1);
    assert.match(easy.stderr, /JOIN_CODE is too easy/);
    assert.equal(fs.existsSync(path.join(dir, "tiers.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("production boots on an outside data directory, logs the path, and starts empty", { timeout: 20000 }, async () => {
  await withServer({ NODE_ENV: "production", LEAGUE_TODAY: "1999-01-01" }, async (ctx) => {
    assert.ok(ctx.log().includes("Data directory: " + ctx.dataDir));
    const tiers = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "tiers.json"), "utf8"));
    assert.deepEqual(tiers.map((tier) => tier.points), [1000, 1500, 2000]);
    assert.notEqual(tiers[0].starts_on, "1999-01-01");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "players.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "lists.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "reports.json"), "utf8")), []);
    const page = await fetch(ctx.base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Escalation League/);
    assert.equal((await fetch(ctx.base + "/server.js")).status, 404);
    assert.equal((await fetch(ctx.base + "/data/players.json")).status, 404);
    assert.equal((await fetch(ctx.base + "/%2e%2e/server.js")).status, 404);
  });
});

test("ALLOW_EPHEMERAL_DATA=1 starts inside the app and warns loudly", { timeout: 20000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(ROOT, "el-inside-"));
  try {
    await withServer(
      {
        NODE_ENV: "production",
        DATA_DIR: dataDir,
        ALLOW_EPHEMERAL_DATA: "1",
        ADMIN_PASSWORD: ADMIN_PW,
        JOIN_CODE
      },
      async (ctx) => {
        assert.match(ctx.log(), /ALLOW_EPHEMERAL_DATA=1/);
        assert.match(ctx.log(), /will not survive/);
        assert.ok(ctx.log().includes("Data directory: " + dataDir));
        const health = await api(ctx, "GET", "/health");
        assert.equal(health.json.ok, true);
      }
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
