"use strict";
// ===============================================================
// f10ForgottenCloseRecovery.test.js — F-10.1B
//
// Covers the structured-error parser (E–K), the orchestrator itself, and the
// static containment/purity guarantees (Q/R). The creaOrdine wiring cases
// (L–P) live in f10CreaOrdineForgottenRetry.test.js; the single-V3-authority
// invariant (A–D) is enforced by lifecycleRuntimeAuthorityP0C1.static.test.js.
//
// Run: node tests/f10ForgottenCloseRecovery.test.js
// ===============================================================

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  FORGOTTEN_CLOSE_CODE,
  FORGOTTEN_CLOSE_SQLSTATE,
  FORGOTTEN_CLOSE_SOURCE,
  SYSTEM_ACTOR,
  parseForgottenCloseRequired,
  createForgottenCloseRecovery,
} = require("../src/serviceSessions/forgottenCloseRecovery");

const STALE_ID = "5d3173b6-e1cb-4ee0-840c-d28310e06401";
const OTHER_ID = "11111111-1111-4111-8111-111111111111";

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ── contract constants ────────────────────────────────────────────────────
test("constants are the exact frozen contract values", () => {
  assert.strictEqual(FORGOTTEN_CLOSE_CODE, "FORGOTTEN_CLOSE_REQUIRED");
  assert.strictEqual(FORGOTTEN_CLOSE_SQLSTATE, "P0001");
  assert.strictEqual(FORGOTTEN_CLOSE_SOURCE, "abandoned_forgotten_close");
  assert.strictEqual(SYSTEM_ACTOR, "system");
});

// ── E. the complete structured contract is accepted ───────────────────────
test("E — exact P0001 + FORGOTTEN_CLOSE_REQUIRED + valid DETAIL uuid parses", () => {
  const parsed = parseForgottenCloseRequired({
    code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: STALE_ID,
  });
  assert.deepStrictEqual(parsed, { staleServiceSessionId: STALE_ID });
});

test("E2 — surrounding whitespace in DETAIL is tolerated, value still exact", () => {
  const parsed = parseForgottenCloseRequired({
    code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: `  ${STALE_ID}\n`,
  });
  assert.deepStrictEqual(parsed, { staleServiceSessionId: STALE_ID });
});

// ── F. missing detail ⇒ NOT a recovery request ────────────────────────────
test("F — right code and message but NO detail is refused", () => {
  assert.strictEqual(parseForgottenCloseRequired({ code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED" }), null);
  assert.strictEqual(parseForgottenCloseRequired({ code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: null }), null);
  assert.strictEqual(parseForgottenCloseRequired({ code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: "" }), null);
});

// ── G. malformed uuid ⇒ refused ───────────────────────────────────────────
test("G — malformed DETAIL uuid is refused", () => {
  for (const bad of ["not-a-uuid", "5d3173b6", `${STALE_ID}x`, "5d3173b6-e1cb-4ee0-840c", 12345, { id: STALE_ID }]) {
    assert.strictEqual(
      parseForgottenCloseRequired({ code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: bad }),
      null,
      `detail ${JSON.stringify(bad)} must be refused`
    );
  }
});

// ── H/I. wrong code or message ⇒ refused ──────────────────────────────────
test("H — a different SQLSTATE is refused even with a perfect detail", () => {
  assert.strictEqual(parseForgottenCloseRequired({ code: "23505", message: "FORGOTTEN_CLOSE_REQUIRED", details: STALE_ID }), null);
  assert.strictEqual(parseForgottenCloseRequired({ code: "42501", message: "FORGOTTEN_CLOSE_REQUIRED", details: STALE_ID }), null);
});

test("I — a different resolver verdict is refused even with a perfect detail", () => {
  for (const msg of ["REOPEN_REQUIRED", "ORDER_INTAKE_CLOSED", "BUSINESS_DAY_UNRESOLVED", "forgotten_close_required"]) {
    assert.strictEqual(
      parseForgottenCloseRequired({ code: "P0001", message: msg, details: STALE_ID }), null,
      `message ${msg} must be refused`
    );
  }
});

test("I2 — no substring leniency on the message", () => {
  assert.strictEqual(
    parseForgottenCloseRequired({ code: "P0001", message: "x FORGOTTEN_CLOSE_REQUIRED y", details: STALE_ID }), null
  );
});

// ── J. a uuid hiding in the message is never harvested ────────────────────
test("J — a uuid present ONLY in the message text is ignored (no regex harvest)", () => {
  assert.strictEqual(
    parseForgottenCloseRequired({ code: "P0001", message: `FORGOTTEN_CLOSE_REQUIRED ${STALE_ID}` }), null
  );
  // message carries a uuid, DETAIL carries none → still refused
  assert.strictEqual(
    parseForgottenCloseRequired({ code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", hint: STALE_ID }), null
  );
});

test("J2 — non-objects and success arrays are refused", () => {
  for (const v of [null, undefined, "FORGOTTEN_CLOSE_REQUIRED", [{ id: "#001" }], 42]) {
    assert.strictEqual(parseForgottenCloseRequired(v), null);
  }
});

// ── orchestrator ──────────────────────────────────────────────────────────
test("recovery calls the close authority once with system + abandoned_forgotten_close", async () => {
  const calls = [];
  const recover = createForgottenCloseRecovery({
    closeService: async (a) => { calls.push(a); return { success: true, code: "V3_CLOSED", closeoutCorrelationId: "corr-1" }; },
  });
  const r = await recover({ staleServiceSessionId: STALE_ID });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.code, "FORGOTTEN_CLOSE_RECOVERED");
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], {
    serviceSessionId: STALE_ID,
    source: "abandoned_forgotten_close",
    actor: "system",
  });
});

test("M — idempotent convergence is success", async () => {
  const recover = createForgottenCloseRecovery({
    closeService: async () => ({ success: true, code: "V3_CLOSED", idempotent: true }),
  });
  const r = await recover({ staleServiceSessionId: STALE_ID });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.idempotent, true);
});

test("N — a V3 hard failure is surfaced, never masked", async () => {
  const recover = createForgottenCloseRecovery({
    closeService: async () => ({ success: false, code: "V3_CLOSE_RECONCILIATION_MISMATCH" }),
  });
  const r = await recover({ staleServiceSessionId: STALE_ID });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.code, "V3_CLOSE_FAILED");
  assert.strictEqual(r.v3Code, "V3_CLOSE_RECONCILIATION_MISMATCH");
});

test("N2 — a throwing authority fails closed", async () => {
  const recover = createForgottenCloseRecovery({
    closeService: async () => { throw new Error("boom"); },
  });
  const r = await recover({ staleServiceSessionId: STALE_ID });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.code, "V3_CLOSE_THREW");
});

test("identity is mandatory — missing/invalid uuid closes nothing", async () => {
  let called = false;
  const recover = createForgottenCloseRecovery({
    closeService: async () => { called = true; return { success: true }; },
  });
  for (const bad of [undefined, null, "", "not-a-uuid", 123, { id: STALE_ID }]) {
    const r = await recover({ staleServiceSessionId: bad });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, "INVALID_STALE_SERVICE_IDENTITY");
  }
  assert.strictEqual(called, false, "must never reach the close authority without a valid uuid");
});

test("the orchestrator closes exactly the uuid it was given, nothing else", async () => {
  const calls = [];
  const recover = createForgottenCloseRecovery({
    closeService: async (a) => { calls.push(a.serviceSessionId); return { success: true }; },
  });
  await recover({ staleServiceSessionId: OTHER_ID });
  assert.deepStrictEqual(calls, [OTHER_ID]);
});

// ── Q/R. static purity guarantees ─────────────────────────────────────────
const SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "serviceSessions", "forgottenCloseRecovery.js"), "utf8"
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("Q — zero Business Day / date / clock logic in the JS F-10 path", () => {
  for (const f of [
    "CURRENT_DATE", "business_date", "businessDate", "business_day", "businessDay",
    "Europe/Madrid", "getHours", "toISOString", "Date.now", "new Date", "clock_timestamp",
  ]) {
    assert.ok(!CODE.includes(f), `forgottenCloseRecovery must not contain "${f}"`);
  }
});

test("R — zero legacy lifecycle writer references", () => {
  for (const f of [
    "rolled_over", "performIncidentSafeRollover", "incidentSafeRollover", "rolloverClassifier",
    "rollEconomicPeriod", "roll_service_session_economic_v1", "scheduleDeferredCloseRetry",
    "ensure_next_service_session_v3", "chiudiServizio", // language-guard: allow-legacy chiudiServizio is the existing legacy close function name, asserted ABSENT here, not new vocabulary
    "PRANZO", "SERA", // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, asserted ABSENT here, not new vocabulary
  ]) {
    assert.ok(!CODE.includes(f), `forgottenCloseRecovery must not reference "${f}"`);
  }
});

test("R2 — it never rediscovers the stale service and never mutates children", () => {
  for (const f of [
    "sbSelect", "sbUpdate", "sbInsert", "sbDelete", "sbUpsert", "sbRpc",
    "service_sessions", "table_sessions", "ordenes", // language-guard: allow-legacy ordenes is the existing orders table name, asserted ABSENT here, not new vocabulary
    "RETIRADO", "rider", "payment",
  ]) {
    assert.ok(!CODE.includes(f), `forgottenCloseRecovery must not reference "${f}"`);
  }
});

test("R3 — it does not import the V3 engine directly, only the close authority", () => {
  assert.ok(!CODE.includes("serviceLifecycleEngine"), "must not import the engine directly");
  assert.ok(CODE.includes("serviceCloseAuthority"), "must import the canonical close authority");
});

test("R4 — it opens no successor service", () => {
  for (const f of ["open_operational_service_v1", "first_open_of_business_day", "explicit_reopen"]) {
    assert.ok(!CODE.includes(f), `forgottenCloseRecovery must not reference "${f}"`);
  }
});

// ── the authority facade is transparent ───────────────────────────────────
test("the close authority forwards args and result untouched", async () => {
  const { createServiceCloseAuthority } = require("../src/serviceSessions/serviceCloseAuthority");
  const seen = [];
  const sentinel = { success: true, code: "V3_CLOSED", extra: Symbol("passthrough") };
  const authority = createServiceCloseAuthority({ engine: async (a) => { seen.push(a); return sentinel; } });
  const args = { serviceSessionId: STALE_ID, source: "operator_finalizar_v3", actor: "owner" };
  const out = await authority(args);
  assert.strictEqual(out, sentinel, "result must be the engine's own object, unwrapped");
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0], args, "arguments must be forwarded by reference, unreshaped");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
  }
  console.log(`\nf10ForgottenCloseRecovery: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
