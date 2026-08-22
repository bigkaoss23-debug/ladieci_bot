"use strict";
// J-2 — the DATABASE half of the stale-cash-count fix, asserted against the
// migration file's own bytes.
//
// The JS layer refuses to SEND a stale count; this migration makes the writer
// refuse to ACCEPT one. Two independent gates, for the same reason ledger 99
// gave for the window rule: the row is append-only, so a variance written from
// a count that no longer describes the economy can never afterwards be
// corrected -- and it reads, to whoever opens the closeout later, exactly like
// a report of missing money.
//
// CREATE OR REPLACE swaps the WHOLE function body, so the risk this file exists
// to catch is not the new check being wrong. It is one of ledger 99's checks
// being silently dropped while transcribing the body around it.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const MIGRATIONS = path.join(__dirname, "..", "migrations");
const FORWARD = "2026-08-22_j2_reconciliation_stale_cash_count_gate.sql";
const ROLLBACK = "2026-08-22_j2_reconciliation_stale_cash_count_gate.ROLLBACK.sql";
const read = (f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
const sql = read(FORWARD);
const rollback = read(ROLLBACK);

test("both files exist and are paired, as every migration in this project is", () => {
  assert.ok(sql.length > 0);
  assert.ok(rollback.length > 0);
});

test("the forward migration is one transaction", () => {
  assert.ok(/^BEGIN;$/m.test(sql), "BEGIN is required");
  assert.ok(/^COMMIT;$/m.test(sql), "COMMIT is required");
  assert.ok(!/^ROLLBACK;$/m.test(sql));
});

test("the staleness refusal exists, and refuses rather than writing", () => {
  assert.ok(sql.includes("RECONCILIATION_CASH_COUNT_STALE"),
    "the new refusal code must be present");
  assert.ok(/v_recorded_at_count IS DISTINCT FROM p_cash_receipts_cents/.test(sql),
    "the gate compares the count's OWN stored ledger figure against this reconciliation's");
  // IS DISTINCT FROM, not <>: a NULL recorded figure must fail the gate, not
  // silently evaluate to NULL and fall through into the INSERT.
  assert.ok(!/v_recorded_at_count <> p_cash_receipts_cents/.test(sql),
    "a plain <> would let a NULL stored figure through");
});

test("every ledger-99 refusal survived the CREATE OR REPLACE", () => {
  for (const code of [
    "RECONCILIATION_CLOSEOUT_NOT_FOUND",
    "RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH",
    "RECONCILIATION_COUNTED_CASH_REQUIRED",
  ]) {
    assert.ok(sql.includes(code), `${code} must not be lost while replacing the body`);
  }
  // The window rule is still all three fields, not a subset.
  for (const clause of [
    "c.window_from = p_window_from",
    "c.window_to = p_window_to",
    "c.window_timezone = p_window_timezone",
  ]) {
    assert.ok(sql.includes(clause), `the window rule lost: ${clause}`);
  }
  // Idempotency on the correlation id is what makes a Finalizar retry safe.
  assert.ok(/WHERE closeout_correlation_id = p_closeout_correlation_id/.test(sql));
});

test("no count still means no variance — closing without one stays permitted", () => {
  assert.ok(/ELSE\s*\n\s*v_variance := NULL;/.test(sql),
    "p_cash_count_id NULL must still produce a NULL variance, never a zero");
  assert.ok(!/RAISE EXCEPTION[^\n]*CASH_COUNT_REQUIRED/i.test(sql),
    "a cash count must not become a precondition for Finalizar");
});

test("it changes a function body and nothing else", () => {
  // The whole safety argument for shipping this alongside a release is that it
  // touches no data and no structure.
  for (const forbidden of [
    /\bALTER TABLE\b/i, /\bDROP TABLE\b/i, /\bCREATE TABLE\b/i,
    /\bDELETE FROM\b/i, /\bTRUNCATE\b/i, /\bDROP TRIGGER\b/i, /\bDROP FUNCTION\b/i,
  ]) {
    assert.ok(!forbidden.test(sql), `J-2 must not contain ${forbidden}`);
  }
  // The single INSERT is the writer's own, inside the function body.
  assert.strictEqual((sql.match(/INSERT INTO/g) || []).length, 1);
  assert.ok(sql.includes("INSERT INTO public.service_closeout_reconciliations"));
  // Exactly one UPDATE-free body: nothing here rewrites a cash count.
  assert.ok(!/\bUPDATE\s+public\.cash_counts\b/i.test(sql));
});

test("the signature is unchanged, so no caller and no dependent object moves", () => {
  const params = [
    "p_service_session_id      uuid", "p_closeout_correlation_id uuid",
    "p_window_from             timestamptz", "p_window_to               timestamptz",
    "p_window_timezone         text", "p_window_preset           text",
    "p_business_date           date", "p_cash_receipts_cents     integer",
    "p_cash_count_id           uuid    DEFAULT NULL",
    "p_counted_cash_cents      integer DEFAULT NULL",
  ];
  for (const p of params) assert.ok(sql.includes(p), `signature drifted: ${p}`);
});

test("privileges are restated, not assumed — the trap ledgers 98 and 99 both hit", () => {
  assert.ok(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated;/.test(sql));
  assert.ok(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role;/.test(sql));
  const revokeAt = sql.indexOf("REVOKE ALL ON FUNCTION");
  const grantAt = sql.indexOf("GRANT EXECUTE ON FUNCTION");
  assert.ok(revokeAt > 0 && grantAt > revokeAt, "the revoke must precede the grant");
  assert.ok(sql.includes("SECURITY DEFINER") && sql.includes("SET search_path = public, pg_temp"));
});

test("post-conditions check the real questions, not just that the file ran", () => {
  for (const assertion of [
    "the staleness refusal is not in the writer body",
    "a J-1 refusal was lost in the replace",
    "expected exactly 1 writer overload",
    "must not be executable by browser roles",
    "lost SECURITY DEFINER or its pinned search_path",
    "expected 24 columns",
    "the append-only trigger is missing",
    "cash_counts stopped being append-only",
    "close_service_session_v3 is missing",
    "open_operational_service_v1 is missing",
  ]) {
    assert.ok(sql.includes(assertion), `missing post-condition: ${assertion}`);
  }
});

test("the post-conditions are portable — no staging row ids are pinned", () => {
  // Ledgers 98 and 99 pinned live staging rows (480eca89, "exactly one cash
  // count at -750"), which makes those files unapplicable anywhere else. This
  // one must be applicable to any database carrying ledger 99.
  assert.ok(!sql.includes("480eca89"), "a specific staging service must not gate this migration");
  assert.ok(!/-750/.test(sql), "a specific staging cash count must not gate this migration");
  assert.ok(!/FROM public\.service_sessions\s+WHERE id=/.test(sql));
});

test("ledger registration is deliberately outside the file, as in ledgers 96-99", () => {
  assert.ok(!/INSERT INTO public\.ladieci_schema_migrations/.test(sql),
    "embedding the row here would make the checksum self-referential");
  assert.ok(sql.includes("apply_order 100"), "the intended ledger position is stated");
});

test("the rollback restores ledger 99 exactly, and says what it costs", () => {
  assert.ok(rollback.includes("CREATE OR REPLACE FUNCTION public.create_service_closeout_reconciliation_v1"));
  assert.ok(!rollback.includes("v_recorded_at_count"), "the gate must actually be gone");
  assert.ok(rollback.includes("RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH"),
    "but ledger 99's own rules must come back");
  assert.ok(rollback.includes("the staleness gate is still present"),
    "the rollback verifies itself too");
  assert.ok(/append-only/.test(rollback),
    "and states that a wrong variance written afterwards cannot be corrected");
});

console.log(`j2StaleCashCountGateMigration: ${passed} passed`);
