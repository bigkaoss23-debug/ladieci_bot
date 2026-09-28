"use strict";
// POST-FREEZE LAYERS -- static pins of the registry, the numbering policy and the file integrity (no network, no database).
// Contract: docs/POST_FREEZE_LAYERS_CONTRACT.md. Run: node --test tests/postFreezeLayers.static.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const REG = require("../scripts/lib/postFreezeLayers.js");
const R = require("../scripts/postFreezeLayerApply.js");
const PF = require("../scripts/economy139to146Preflight.js");
const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");

test("numbering: domains are disjoint, above the frozen Economy tip, and every layer sits in its own domain", () => {
  assert.equal(REG.ECONOMY_FROZEN_TIP, 156);
  const d = REG.DOMAINS;
  for (let i = 0; i < d.length; i++) {
    assert.ok(d[i].from > REG.ECONOMY_FROZEN_TIP && d[i].from <= d[i].to, d[i].domain);
    for (let j = i + 1; j < d.length; j++) assert.ok(d[i].to < d[j].from || d[j].to < d[i].from, `${d[i].domain} overlaps ${d[j].domain}`);
  }
  const ns = REG.POST_FREEZE_LAYERS.map((l) => l.n);
  assert.equal(new Set(ns).size, ns.length, "a number is registered twice");
  for (const l of REG.POST_FREEZE_LAYERS) {
    assert.ok(l.n > REG.ECONOMY_FROZEN_TIP && ![141, 142].includes(l.n), `layer ${l.n} inside the Economy numbers`);
    assert.equal(REG.domainOf(l.n) && REG.domainOf(l.n).domain, l.domain, `layer ${l.n} outside its domain`);
    assert.match(l.file, new RegExp(`_(layer|migration)_${l.n}\\.sql$`), `layer ${l.n} file name must carry its number`);
    assert.ok(["OWN", "EXTERNAL"].includes(l.status));
    assert.match(l.sha, /^[0-9a-f]{64}$/); assert.match(l.rbkSha, /^[0-9a-f]{64}$/);
  }
});

test("G4 (157) is reserved as EXTERNAL with its certified bytes; this branch carries no G4 file and no G4 change", () => {
  const g4 = REG.layerOf(157);
  assert.equal(g4.status, "EXTERNAL");
  assert.equal(g4.domain, "SECURITY");
  assert.equal(g4.sha, "0880353a36abbb876d0610d453c49c19e18308282019f6ae9e9a372088d540c1");
  assert.ok(!fs.existsSync(path.join(ROOT, "migrations/post_freeze", g4.file)), "the G4 file lives in its own isolated copy");
  assert.ok(!fs.existsSync(path.join(ROOT, "docs/G4_CLIENTES_GEO_CACHE_SECURITY_CONTRACT.md")));
});

test("verify-files: own layer bytes, no unregistered post-freeze file, Economy 139..156 files byte-identical to their certified sha256", () => {
  const r = R.verifyFiles();
  assert.deepEqual(r.problems, []);
  assert.equal(r.result, "FILES_CERTIFIED");
  assert.equal(r.economyFiles, 32);
  for (const c of PF.CHAIN) {
    assert.equal(sha(`migrations/${c.file}`), c.sha, c.file);
    assert.equal(sha(`migrations/${c.file.replace(/\.sql$/, ".ROLLBACK.sql")}`), c.rbkSha, c.file);
  }
});

test("post-freeze files live OUTSIDE the migrations/ root the Economy tooling enumerates; no root file is numbered above 156", () => {
  const root = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
  const high = root.filter((f) => { const m = /_migration_(\d+)\b/.exec(f); return m && Number(m[1]) > 156; });
  assert.deepEqual(high, []);
  assert.ok(root.every((f) => !/_layer_\d+/.test(f)));
  const dir = path.join(ROOT, "migrations/post_freeze");
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")) : [], [], "no layer file before a layer is registered");
});

test("isCertifiedPostFreezeRow: exact (apply_order, filename, sha256/16) only", () => {
  for (const l of REG.POST_FREEZE_LAYERS) {
    assert.equal(REG.isCertifiedPostFreezeRow({ apply_order: l.n, filename: l.file, checksum_sha256: l.sha.slice(0, 16) }), true);
    assert.equal(REG.isCertifiedPostFreezeRow({ apply_order: l.n, filename: l.file, checksum_sha256: "0".repeat(16) }), false);
    assert.equal(REG.isCertifiedPostFreezeRow({ apply_order: l.n + 1, filename: l.file, checksum_sha256: l.sha.slice(0, 16) }), false);
  }
  assert.equal(REG.isCertifiedPostFreezeRow({ apply_order: 171, filename: "x_layer_171.sql", checksum_sha256: "0".repeat(16) }), false);
});

test("the certified Economy tooling is not modified by the post-freeze runner (it only requires it)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/postFreezeLayerApply.js"), "utf8");
  assert.match(src, /require\('\.\/economy139to146Preflight\.js'\)/);
  assert.doesNotMatch(src, /writeFileSync|appendFileSync/);
  for (const f of ["scripts/economyChainApply.js", "scripts/economy149150GuardedStep.js", "scripts/v3BusinessBootstrap.js", "scripts/lib/migrationTx.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /postFreezeLayer/, `${f} must stay the certified Economy tooling`);
  }
});
