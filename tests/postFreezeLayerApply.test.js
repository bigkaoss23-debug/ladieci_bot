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

// ── --no-registry: only an ephemeral LOCAL database without a Supabase registry ──────────────────────────────────────────────────────────
// Every CLI case below runs with W3_PG_NODE_MODULES pointing nowhere: if a guard regressed, the process would fail loading the driver
// ("connection error"), never open a socket. So STAGING / LIVE / remote hosts are never contacted by these tests.
const NO_DRIVER = "/nonexistent/post-freeze-test-no-driver";
function runCli(args, env) {
  const { spawnSync } = require("child_process");
  const path = require("path");
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "postFreezeLayerApply.js"), ...args], { env: { PATH: process.env.PATH, W3_PG_NODE_MODULES: NO_DRIVER, ...env }, encoding: "utf8" });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) { /* */ }
  return { code: r.status, j, stderr: r.stderr };
}
const STG_URL = `postgres://postgres:x@db.${STAGING}.supabase.co:5432/postgres`;

test("no-registry (A): a local target passes the pre-connection gate; the database gate allows it only without a Supabase registry", async () => {
  for (const env of [{ PREFLIGHT_DATABASE_URL: "postgres://postgres@127.0.0.1:55450/lab1" }, { PGHOST: "localhost", PGDATABASE: "x" }, { PGHOST: "/tmp", PGDATABASE: "x" }, {}]) {
    const t = R.describeTarget(env);
    assert.equal(t.kind, "LOCAL", JSON.stringify(env)); assert.equal(R.checkNoRegistryTarget(t), null);
  }
  const db = (present) => ({ query: async (sql) => { assert.match(sql, /to_regclass\('supabase_migrations\.schema_migrations'\)/); return { rows: [{ present }] }; } });
  assert.equal(await R.checkNoRegistryDatabase(db(false)), null);
  assert.equal((await R.checkNoRegistryDatabase(db(true))).result, "REFUSED_NO_REGISTRY_REGISTRY_PRESENT");
});

test("no-registry (A): apply / preflight / status / rollback refuse on a database WITH a registry before any other statement", async () => {
  const seen = [];
  const client = { query: async (sql) => { seen.push(sql); if (/supabase_migrations\.schema_migrations'\) IS NOT NULL AS present/.test(sql)) return { rows: [{ present: true }] }; throw new Error("unexpected statement: " + sql.slice(0, 60)); } };
  const rs = [await R.apply(client, 170, { noRegistry: true, log: () => {} }), await R.preflight(client, 170, { noRegistry: true }), await R.status(client, { noRegistry: true }),
    await R.rollback(client, 170, { noRegistry: true, ack: l170.rollback.ack, log: () => {} })];
  for (const r of rs) assert.equal(r.result, "REFUSED_NO_REGISTRY_REGISTRY_PRESENT");
  assert.equal(seen.length, 4, "one read-only probe per command, nothing else (no lock, no BEGIN, no write)");
});

test("no-registry (B): STAGING is refused before connecting, for every command, even with --target and the remote acknowledgement", () => {
  const t = R.describeTarget({ PREFLIGHT_DATABASE_URL: STG_URL });
  assert.equal(R.checkNoRegistryTarget(t).result, "REFUSED_NO_REGISTRY_NOT_LOCAL");
  const id = `supabase:${STAGING}`;
  for (const args of [["apply", "--layer", "170", "--target", id, "--no-registry"], ["rollback", "--layer", "170", "--target", id, "--ack", l170.rollback.ack, "--no-registry"],
    ["preflight", "--layer", "170", "--no-registry"], ["status", "--no-registry"], ["apply", "--no-registry", "--layer", "170"]]) {
    const r = runCli(args, { PREFLIGHT_DATABASE_URL: STG_URL, [R.REMOTE_ACK_ENV]: id });
    assert.equal(r.code, 2, args.join(" ")); assert.equal(r.j && r.j.result, "REFUSED_NO_REGISTRY_NOT_LOCAL", args.join(" ") + " " + r.stderr);
  }
  // the same project reached through the session pooler user, through PG* variables, or through a host-less URL + PGHOST
  for (const env of [{ PREFLIGHT_DATABASE_URL: `postgres://postgres.${STAGING}:x@aws-0-eu-west-3.pooler.supabase.com:5432/postgres` },
    { PGHOST: `db.${STAGING}.supabase.co`, PGUSER: "postgres", PGDATABASE: "postgres" }, { PGHOST: "127.0.0.1", PGUSER: `postgres.${STAGING}` },
    { PREFLIGHT_DATABASE_URL: "postgres:///postgres", PGHOST: `db.${STAGING}.supabase.co` }]) {
    const r = runCli(["apply", "--layer", "170", "--target", id, "--no-registry"], { ...env, [R.REMOTE_ACK_ENV]: id });
    assert.equal(r.j && r.j.result, "REFUSED_NO_REGISTRY_NOT_LOCAL", JSON.stringify(env) + " " + r.stderr);
  }
});

test("no-registry (C): LIVE is refused (the LIVE refusal comes first, unchanged)", () => {
  for (const env of [{ PREFLIGHT_DATABASE_URL: `postgres://postgres:x@db.${LIVE}.supabase.co:5432/postgres` }, { PGHOST: `db.${LIVE}.supabase.co` },
    { PREFLIGHT_DATABASE_URL: `postgres://postgres@127.0.0.1:5432/postgres?host=db.${LIVE}.supabase.co` }]) {
    for (const args of [["apply", "--layer", "170", "--target", `supabase:${LIVE}`, "--no-registry"], ["status", "--no-registry"]]) {
      const r = runCli(args, { ...env, [R.REMOTE_ACK_ENV]: `supabase:${LIVE}` });
      assert.equal(r.code, 2); assert.equal(r.j && r.j.result, "REFUSED_TARGET"); assert.match(r.j.detail, /refused/);
    }
  }
  assert.equal(R.checkNoRegistryTarget(R.describeTarget({ PGHOST: `db.${LIVE}.supabase.co` })).result, "REFUSED_TARGET");
});

test("no-registry (D): any other remote target is refused; a URL that hides its real host is not classified at all", () => {
  const rem = "remote:10.0.0.5:5432/db";
  for (const env of [{ PREFLIGHT_DATABASE_URL: "postgres://u@10.0.0.5:5432/db" }, { PGHOST: "10.0.0.5", PGDATABASE: "db" }, { PREFLIGHT_DATABASE_URL: "postgres:///db", PGHOST: "10.0.0.5" }]) {
    assert.equal(R.describeTarget(env).id, rem, JSON.stringify(env));
    for (const args of [["apply", "--layer", "170", "--target", rem, "--no-registry"], ["apply", "--layer", "170", "--no-registry"], ["preflight", "--layer", "170", "--no-registry"], ["status", "--no-registry"]]) {
      const r = runCli(args, { ...env, [R.REMOTE_ACK_ENV]: rem });
      assert.equal(r.code, 2); assert.equal(r.j && r.j.result, "REFUSED_NO_REGISTRY_NOT_LOCAL", args.join(" ") + " " + r.stderr);
    }
  }
  // the pg driver honours ?host= / ?port= over the URL authority: before this fix these read as local:127.0.0.1
  for (const url of [`postgres://postgres@127.0.0.1:5432/postgres?host=db.${STAGING}.supabase.co`, "postgres://u@localhost/db?host=10.0.0.5",
    "postgres://u@localhost/db?hostaddr=10.0.0.5", "postgres://u@127.0.0.1/db?port=6543"]) {
    const t = R.describeTarget({ PREFLIGHT_DATABASE_URL: url });
    assert.equal(t.ok, false, url); assert.match(t.reason, /query string/);
    const r = runCli(["apply", "--layer", "170", "--target", "local:127.0.0.1:5432/postgres", "--no-registry"], { PREFLIGHT_DATABASE_URL: url });
    assert.equal(r.code, 2); assert.equal(r.j && r.j.result, "REFUSED_TARGET", url);
  }
  // a host-less URL resolves to PGHOST / PGPORT exactly as the driver does
  assert.equal(R.describeTarget({ PREFLIGHT_DATABASE_URL: "postgres:///db", PGHOST: "127.0.0.1", PGPORT: "55450" }).id, "local:127.0.0.1:55450/db");
  assert.equal(R.describeTarget({ PREFLIGHT_DATABASE_URL: "postgres://u@/db", PGHOST: "10.0.0.5" }).ok, false, "not a WHATWG URL: refused");
});

test("no-registry (E/F): without the flag, local and (acknowledged) STAGING targets pass every target gate unchanged", () => {
  // local: exact --target, no acknowledgement needed; the CLI reaches the connection stage (driver missing here -> connection error)
  const loc = runCli(["apply", "--layer", "170", "--target", "local:127.0.0.1:1/nowhere"], { PREFLIGHT_DATABASE_URL: "postgres://postgres@127.0.0.1:1/nowhere" });
  assert.equal(loc.code, 2); assert.equal(loc.j, null); assert.match(loc.stderr, /^connection error: Cannot find module/);
  // STAGING, registry-backed: structurally usable when named and acknowledged (target gates return null). NOT contacted: checked on the
  // pure functions only; the CLI is not spawned against the staging host.
  const env = { PREFLIGHT_DATABASE_URL: STG_URL, [R.REMOTE_ACK_ENV]: `supabase:${STAGING}` };
  const stg = R.describeTarget(env);
  assert.equal(stg.ok, true); assert.equal(stg.known, "STAGING");
  assert.equal(R.checkMutationTarget(stg, `supabase:${STAGING}`, env), null);
});
