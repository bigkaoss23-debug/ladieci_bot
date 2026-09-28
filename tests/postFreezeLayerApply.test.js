"use strict";
// POST-FREEZE RUNNER -- unit tests of the pure parts: target protection, the Economy composite verdict, and the exact layer-state classifier
// (fake clients, no database). The runner's database behaviour is certified on PostgreSQL 17 in the lab (evidence pack of FISCAL P1).
// Run: node --test tests/postFreezeLayerApply.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../scripts/postFreezeLayerApply.js");
const REG = require("../scripts/lib/postFreezeLayers.js");
const { classify170, L170_PINS } = require("../scripts/lib/postFreezeLayerChecks.js");

const LIVE = "wnswassgfuuivmfwjxsf";
const STAGING = "tdikhfeinufaahagmpjz";

test("target: the LIVE project is refused in any position of the connection, for every command", () => {
  for (const env of [
    { PREFLIGHT_DATABASE_URL: `postgres://postgres:x@db.${LIVE}.supabase.co:5432/postgres` },
    { PREFLIGHT_DATABASE_URL: `postgres://postgres.${LIVE}:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres` },
    { PGHOST: `db.${LIVE}.supabase.co`, PGUSER: "postgres" },
    { PGHOST: "127.0.0.1", PGUSER: `postgres.${LIVE}` },
  ]) {
    const t = R.describeTarget(env);
    assert.equal(t.ok, false); assert.equal(t.forbidden, "LIVE");
    assert.equal(R.checkMutationTarget(t, "anything", env).result, "REFUSED_TARGET");
  }
});

test("target: identification of local, Supabase (direct + session pooler) and other remote targets", () => {
  assert.deepEqual(R.describeTarget({ PREFLIGHT_DATABASE_URL: "postgres://postgres@127.0.0.1:55450/lab1" }).id, "local:127.0.0.1:55450/lab1");
  assert.equal(R.describeTarget({ PGHOST: "localhost", PGPORT: "5433", PGDATABASE: "x" }).id, "local:localhost:5433/x");
  const s1 = R.describeTarget({ PREFLIGHT_DATABASE_URL: `postgres://postgres:x@db.${STAGING}.supabase.co:5432/postgres` });
  assert.equal(s1.id, `supabase:${STAGING}`); assert.equal(s1.known, "STAGING"); assert.equal(s1.kind, "SUPABASE");
  const s2 = R.describeTarget({ PREFLIGHT_DATABASE_URL: `postgres://postgres.${STAGING}:x@aws-0-eu-west-3.pooler.supabase.com:5432/postgres` });
  assert.equal(s2.id, `supabase:${STAGING}`);
  assert.equal(R.describeTarget({ PREFLIGHT_DATABASE_URL: "postgres://u@10.0.0.5:5432/db" }).id, "remote:10.0.0.5:5432/db");
  assert.equal(R.describeTarget({ PREFLIGHT_DATABASE_URL: "postgres://postgres@aws-0-eu.pooler.supabase.com:5432/postgres" }).ok, false, "a Supabase host without a readable ref");
  assert.equal(R.describeTarget({ PREFLIGHT_DATABASE_URL: "host=127.0.0.1 dbname=x" }).ok, false, "a libpq keyword string is not classified: refused");
});

test("target: apply / rollback require the exact --target, and a non-local target a second acknowledgement", () => {
  const local = R.describeTarget({ PREFLIGHT_DATABASE_URL: "postgres://postgres@127.0.0.1:55450/lab1" });
  assert.equal(R.checkMutationTarget(local, undefined, {}).result, "REFUSED_TARGET_NOT_NAMED");
  assert.equal(R.checkMutationTarget(local, "local:127.0.0.1:55450/other", {}).result, "REFUSED_TARGET_MISMATCH");
  assert.equal(R.checkMutationTarget(local, "local:127.0.0.1:55450/lab1", {}), null);
  const env = { PREFLIGHT_DATABASE_URL: `postgres://postgres:x@db.${STAGING}.supabase.co:5432/postgres` };
  const stg = R.describeTarget(env);
  assert.equal(R.checkMutationTarget(stg, `supabase:${STAGING}`, env).result, "REFUSED_REMOTE_TARGET_NOT_ACKNOWLEDGED");
  assert.equal(R.checkMutationTarget(stg, `supabase:${STAGING}`, { ...env, [R.REMOTE_ACK_ENV]: "supabase:other" }).result, "REFUSED_REMOTE_TARGET_NOT_ACKNOWLEDGED");
  assert.equal(R.checkMutationTarget(stg, `supabase:${STAGING}`, { ...env, [R.REMOTE_ACK_ENV]: `supabase:${STAGING}` }), null);
});

// A fake client answering the Economy POST_APPLY preflight (inTx: one query) and the ledger query of the composite.
function fakeClient({ rows, ledger }) {
  return { query: async (sql) => (/^SELECT apply_order, filename, checksum_sha256 FROM public\.ladieci_schema_migrations WHERE apply_order > \$1/.test(sql) ? { rows: ledger } : { rows }) };
}
const pass = (sec, k) => ({ sec, k, ok: true, got: "x", want: "x" });
const fail = (sec, k) => ({ sec, k, ok: false, got: "y", want: "x" });
const RANGE = ["ledger tip max(apply_order)", "ledger rows above 138 = exactly the applied prefix (139, ...)"];
const l170 = REG.layerOf(170); const g4 = REG.layerOf(157);
const row = (l, sha = l.sha.slice(0, 16)) => ({ apply_order: l.n, filename: l.file, checksum_sha256: sha });

test("Economy composite: accepts ONLY the two range checks, and only when every row above 156 is a registered layer", async () => {
  const base = [pass("A", "pg17"), pass("B", "fn"), pass("D", "trg"), pass("E", "closeouts")];
  const clean = await R.economyComposite(fakeClient({ rows: [...base, pass("C", RANGE[0]), pass("C", RANGE[1])], ledger: [] }), { inTx: true });
  assert.equal(clean.ok, true);
  const withLayers = await R.economyComposite(fakeClient({ rows: [...base, fail("C", RANGE[0]), fail("C", RANGE[1])], ledger: [row(g4), row(l170)] }), { inTx: true });
  assert.equal(withLayers.ok, true); assert.deepEqual(withLayers.postFreezeLedgerRows, [157, 170]);
  const unknown = await R.economyComposite(fakeClient({ rows: [...base, fail("C", RANGE[0]), fail("C", RANGE[1])], ledger: [row(l170), { apply_order: 171, filename: "x_layer_171.sql", checksum_sha256: "0".repeat(16) }] }), { inTx: true });
  assert.equal(unknown.ok, false); assert.equal(unknown.unknownPostFreezeRows.length, 1);
  const wrongSha = await R.economyComposite(fakeClient({ rows: [...base, fail("C", RANGE[0]), fail("C", RANGE[1])], ledger: [row(g4, "f".repeat(16))] }), { inTx: true });
  assert.equal(wrongSha.ok, false, "a 157 row that is not the certified G4 file is unknown");
  const otherLedger = await R.economyComposite(fakeClient({ rows: [...base, fail("C", RANGE[0]), fail("C", "ledger row 153 present: filename + sha256/16")], ledger: [row(l170)] }), { inTx: true });
  assert.equal(otherLedger.ok, false, "any other ledger failure is fatal");
  const catalog = await R.economyComposite(fakeClient({ rows: [pass("A", "pg17"), fail("B", "fn state"), pass("D", "trg"), pass("E", "x")], ledger: [] }), { inTx: true });
  assert.equal(catalog.ok, false, "the Economy catalog must be exactly POST_APPLY");
  const rangeWithoutRows = await R.economyComposite(fakeClient({ rows: [...base, fail("C", RANGE[0])], ledger: [] }), { inTx: true });
  assert.equal(rangeWithoutRows.ok, false, "a range failure with no post-freeze row is an Economy problem");
});

test("layer 170 state classifier: ABSENT / APPLIED / DETACHED exactly, DRIFT otherwise", () => {
  const P = L170_PINS;
  const absent = { schema_present: false, retained_fp: null, capture_fn: null, capture_triggers: null, last_epoch: null };
  const applied = { schema_present: true, retained_fp: P.retained_fp, capture_fn: P.capture_fn, capture_triggers: P.capture_triggers, last_epoch: "ATTACHED" };
  const detached = { schema_present: true, retained_fp: P.retained_fp, capture_fn: null, capture_triggers: null, last_epoch: "DETACHED" };
  assert.equal(classify170(absent), "ABSENT");
  assert.equal(classify170(applied), "APPLIED");
  assert.equal(classify170(detached), "DETACHED");
  assert.equal(classify170({ ...applied, retained_fp: "x" }), "DRIFT");
  assert.equal(classify170({ ...applied, capture_fn: P.capture_fn.replace("true", "false") }), "DRIFT", "capture no longer SECURITY DEFINER");
  assert.equal(classify170({ ...applied, capture_triggers: P.capture_triggers.replace(/^O /, "D ") }), "DRIFT", "a disabled capture trigger");
  assert.equal(classify170({ ...applied, last_epoch: "DETACHED" }), "DRIFT");
  assert.equal(classify170({ ...detached, capture_triggers: P.capture_triggers }), "DRIFT", "a trigger without its function");
  assert.equal(classify170({ ...absent, capture_triggers: "O CREATE TRIGGER x" }), "DRIFT");
});

test("CLI refuses before connecting: LIVE target (exit 2), apply without --target (exit 2)", () => {
  const { spawnSync } = require("child_process");
  const path = require("path");
  const script = path.join(__dirname, "..", "scripts", "postFreezeLayerApply.js");
  const live = spawnSync(process.execPath, [script, "status"], { env: { PATH: process.env.PATH, PREFLIGHT_DATABASE_URL: `postgres://postgres:x@db.${LIVE}.supabase.co:5432/postgres` }, encoding: "utf8" });
  assert.equal(live.status, 2); assert.match(live.stdout, /REFUSED_TARGET/); assert.match(live.stdout, /LIVE/);
  const noTarget = spawnSync(process.execPath, [script, "apply", "--layer", "170"], { env: { PATH: process.env.PATH, PREFLIGHT_DATABASE_URL: "postgres://postgres@127.0.0.1:1/nowhere" }, encoding: "utf8" });
  assert.equal(noTarget.status, 2); assert.match(noTarget.stdout, /REFUSED_TARGET_NOT_NAMED/);
  const stg = spawnSync(process.execPath, [script, "apply", "--layer", "170", "--target", `supabase:${STAGING}`], { env: { PATH: process.env.PATH, PREFLIGHT_DATABASE_URL: `postgres://postgres:x@db.${STAGING}.supabase.co:5432/postgres` }, encoding: "utf8" });
  assert.equal(stg.status, 2); assert.match(stg.stdout, /REFUSED_REMOTE_TARGET_NOT_ACKNOWLEDGED/);
});
