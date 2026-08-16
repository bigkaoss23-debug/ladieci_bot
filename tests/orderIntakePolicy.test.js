"use strict";
// orderIntakePolicy.js — R-DAY3 RETARGET.
//
// This file replaces the pre-R-DAY3 suite (which tested Service-Period
// staleness/kind-mismatch gating and the fetchActiveServiceSessionSelfHealing
// self-heal chain — both retired from this module by R-DAY3, see the module's
// own header and R_DAY3_INTAKE_AUTHORITY_AMENDMENT_V1_2026-08-16.md §5/§20).
// Post-R-DAY3, this module is advisory-only: the canonical authority is
// public.resolve_order_intake_context_v1(), tested against real staging
// separately (see tests/rDay3BusinessDayIntakeAuthority.static.test.js for
// the SQL-side static proof, and the R-DAY3 certification report for live
// DB/concurrency evidence). This suite covers everything provable offline:
// the pure evaluate function, the RPC read wrapper's error handling, and the
// end-to-end gate's exact calling contract (unchanged, so agentOrdini.js
// needed no change).
const {
  INTAKE_CODE, evaluateNewOrderIntake, fetchOrderIntakeContext, createGateNewOrderIntake,
} = require("../src/serviceSessions/orderIntakePolicy");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

console.log("\n== A. evaluateNewOrderIntake — pure, given an already-resolved context ==");

assert("1a: canCreateNewOrder=true -> allowed",
  evaluateNewOrderIntake({ ctx: { canCreateNewOrder: true, businessDate: "2026-08-16", serviceKind: "PRANZO" } }).allowed === true);
assert("1b: allowed result carries code ALLOWED, no detail",
  (() => {
    const r = evaluateNewOrderIntake({ ctx: { canCreateNewOrder: true, businessDate: "2026-08-16", serviceKind: "SERA" } });
    return r.code === "ALLOWED" && r.detail === null;
  })());
assert("1c: allowed result surfaces the DB-resolved businessDate/serviceKind",
  (() => {
    const r = evaluateNewOrderIntake({ ctx: { canCreateNewOrder: true, businessDate: "2026-08-16", serviceKind: "SERA" } });
    return r.businessDate === "2026-08-16" && r.serviceKind === "SERA";
  })());
assert("1d: canCreateNewOrder=false -> rejected with ORDER_INTAKE_CLOSED",
  (() => {
    const r = evaluateNewOrderIntake({ ctx: { canCreateNewOrder: false, businessDate: "2026-08-16", serviceKind: "SERA" } });
    return r.allowed === false && r.code === INTAKE_CODE.ORDER_INTAKE_CLOSED;
  })());
assert("1e: rejection carries a non-empty human-readable Spanish detail message",
  typeof evaluateNewOrderIntake({ ctx: { canCreateNewOrder: false } }).detail === "string"
  && evaluateNewOrderIntake({ ctx: { canCreateNewOrder: false } }).detail.length > 0);
assert("1f: null ctx (preflight read failure) FAILS OPEN — allowed:true, never blocks on its own transport error",
  evaluateNewOrderIntake({ ctx: null }).allowed === true);
assert("1g: sourceChannel is threaded through on both allow and reject paths",
  evaluateNewOrderIntake({ ctx: { canCreateNewOrder: true }, sourceChannel: "whatsapp" }).sourceChannel === "whatsapp"
  && evaluateNewOrderIntake({ ctx: { canCreateNewOrder: false }, sourceChannel: "operator" }).sourceChannel === "operator");
assert("1h: no Service-Period field (session/activeSession/status) appears anywhere on the result shape",
  (() => {
    const r = evaluateNewOrderIntake({ ctx: { canCreateNewOrder: true, businessDate: "2026-08-16", serviceKind: "PRANZO" } });
    return !("session" in r) && !("activeSession" in r) && !("status" in r);
  })());
assert("1i: retired codes are not exported (NO_OPEN_SERVICE_SESSION / STALE_SERVICE_SESSION / SERVICE_KIND_MISMATCH)",
  !("NO_OPEN_SERVICE_SESSION" in INTAKE_CODE)
  && !("STALE_SERVICE_SESSION" in INTAKE_CODE)
  && !("SERVICE_KIND_MISMATCH" in INTAKE_CODE)
  && !("SERVICE_SESSION_NOT_ORDERABLE" in INTAKE_CODE));

console.log("\n== B. fetchOrderIntakeContext — RPC read wrapper ==");

async function run() {
assert("2a: httpStatus-ok response with a jsonb body is returned as-is",
  await (async () => {
    const rpc = async () => ({ ok: true, body: { canCreateNewOrder: true, businessDate: "2026-08-16", serviceKind: "PRANZO" } });
    const ctx = await fetchOrderIntakeContext({ rpc });
    return ctx && ctx.canCreateNewOrder === true && ctx.businessDate === "2026-08-16";
  })());
assert("2b: HTTP-level failure (ok:false) resolves to null, not a throw",
  await (async () => {
    const rpc = async () => ({ ok: false, body: null });
    return (await fetchOrderIntakeContext({ rpc })) === null;
  })());
assert("2c: a thrown transport error resolves to null, not a propagated exception",
  await (async () => {
    const rpc = async () => { throw new Error("network down"); };
    return (await fetchOrderIntakeContext({ rpc })) === null;
  })());
assert("2d: a non-object body resolves to null",
  await (async () => {
    const rpc = async () => ({ ok: true, body: "not-an-object" });
    return (await fetchOrderIntakeContext({ rpc })) === null;
  })());
assert("2e: calls the RPC by its exact registered name with no arguments",
  await (async () => {
    let calledWith = null;
    const rpc = async (name, args) => { calledWith = { name, args }; return { ok: true, body: { canCreateNewOrder: true } }; };
    await fetchOrderIntakeContext({ rpc });
    return calledWith.name === "get_order_intake_context_v1" && JSON.stringify(calledWith.args) === "{}";
  })());

console.log("\n== C. createGateNewOrderIntake — end-to-end, unchanged calling contract ==");

assert("3a: gateNewOrderIntake({ sourceChannel }) resolves allowed:true when the injected context allows",
  await (async () => {
    const gate = createGateNewOrderIntake({ fetchContext: async () => ({ canCreateNewOrder: true, businessDate: "2026-08-16", serviceKind: "PRANZO" }) });
    const r = await gate({ sourceChannel: "whatsapp" });
    return r.allowed === true && r.sourceChannel === "whatsapp";
  })());
assert("3b: gateNewOrderIntake resolves allowed:false with ORDER_INTAKE_CLOSED when the context is closed",
  await (async () => {
    const gate = createGateNewOrderIntake({ fetchContext: async () => ({ canCreateNewOrder: false, businessDate: "2026-08-16", serviceKind: "SERA" }) });
    const r = await gate({ sourceChannel: "operator" });
    return r.allowed === false && r.code === "ORDER_INTAKE_CLOSED";
  })());
assert("3c: gateNewOrderIntake fails open when the context fetch itself resolves null",
  await (async () => {
    const gate = createGateNewOrderIntake({ fetchContext: async () => null });
    const r = await gate({});
    return r.allowed === true;
  })());
assert("3d: default export gateNewOrderIntake exists and is callable with zero args",
  typeof require("../src/serviceSessions/orderIntakePolicy").gateNewOrderIntake === "function");

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
}

run();
