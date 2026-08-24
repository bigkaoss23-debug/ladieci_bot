// tests/riderTripWrapper.test.js — S2-1B rider trip wrapper.
// Proves the structured RPC code -> HTTP mapping, idempotency contract, and the financial
// whitelist (wrapper forwards ONLY id/cobrado/metodo_pago; never pagado/descuento/total).
// Run: node tests/riderTripWrapper.test.js  — offline (sbRpc is stubbed via require.cache).

const assert = require("assert");
const path = require("path");

// Stub src/utils/supabase.sbRpc before requiring riderTrip.
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let lastRpc = null;
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbRpc: async (fn, args) => { lastRpc = { fn, args }; return STUB(fn, args); },
});
let STUB = () => ({ httpStatus: 200, ok: true, body: { ok: true, code: "OK" } });

const riderTrip = require("../src/agents/riderTrip");

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label); } }

(async () => {
  // Code -> HTTP mapping via mapResult
  const cases = [
    ["OK", 200], ["IDEMPOTENT", 200], ["NON_MEMBER", 403], ["NOT_FOUND", 404],
    ["INVALID_STATE", 409], ["ACTIVE_TRIP_CONFLICT", 409], ["EARLY_CLOSE", 409],
    ["NO_ACTIVE_TRIP", 409], ["INVALID_TRIP_SNAPSHOT", 409], ["MISSING_TRIP_MEMBER", 409],
    ["SERVICE_CLOSING", 409], ["SERVICE_CLOSE_ID_MISMATCH", 409], ["BAD_REQUEST", 400],
    ["ACTIVE_TRIP_MEMBER_CONFLICT", 409],
    // M-1 — a financially-evidenced order refuses hard-delete the same way an
    // active-trip member already did: a structured 409, never a generic 500.
    ["ORDER_HAS_FINANCIAL_EVIDENCE", 409],
    // N-1 — same contract for the conversation-bulk-delete path.
    ["INVALID_WA_ID", 400],
    ["CONVERSATION_HAS_FINANCIAL_EVIDENCE", 409],
  ];
  for (const [code, http] of cases) {
    const ok = ["OK", "IDEMPOTENT"].includes(code);
    const r = riderTrip.mapResult({ httpStatus: 200, ok: true, body: { ok, code } });
    check(`code ${code} -> ${http}`, r.status === http);
    if (!ok) check(`code ${code} payload hides internals`, r.payload.error === code && !("snapshot" in r.payload && r.payload.snapshot === undefined));
  }

  // Transport failure -> generic 500, no leakage
  check("transport failure -> 500", riderTrip.mapResult({ ok: false, httpStatus: 500, body: null }).status === 500);
  check("500 payload generic", riderTrip.mapResult({ ok: false, httpStatus: 500, body: null }).payload.error === "internal_error");

  // startTrip forwards only anchor
  STUB = () => ({ httpStatus: 200, ok: true, body: { ok: true, code: "OK", snapshot: {} } });
  await riderTrip.startTrip("ORD1");
  check("startTrip -> start_rider_trip(p_anchor_order_id)", lastRpc.fn === "start_rider_trip" && lastRpc.args.p_anchor_order_id === "ORD1" && Object.keys(lastRpc.args).length === 1);

  // S2-7D6E2 — completeStop now targets the DEDICATED rider collection contract. The old
  // `p_cobrado` boolean is GONE: it came from the client and the RPC wrote it straight onto
  // `ordenes` with no ledger event. The wrapper forwards the VERIFIED session identity and
  // the method; the amount is derived server-side and never crosses this boundary.
  await riderTrip.completeStop("ORD2", "efectivo", {
    byActor: "rider", sessionVersion: 4, ipHash: "iphash",
    meta: { source: "rider_delivery" }, idemScopeKey: "pay-order-ORD2",
  });
  const a = lastRpc.args;
  check("completeStop -> rider_collect_and_complete_stop", lastRpc.fn === "rider_collect_and_complete_stop");
  check("completeStop whitelist keys exact", JSON.stringify(Object.keys(a).sort()) === JSON.stringify(
    ["p_by_actor","p_idem_scope_key","p_ip_hash","p_meta","p_metodo_pago","p_order_id","p_session_version"]));
  check("completeStop forbids financial fields",
    !("descuento_tipo" in a) && !("descuento_valor" in a) && !("total" in a) && !("totale" in a) && !("pagado" in a) && !("ya_pagado" in a) && !("estado" in a));
  check("completeStop no longer carries a client-asserted cobrado", !("p_cobrado" in a) && !("cobrado" in a));
  check("completeStop never forwards an amount — SQL derives it", !("p_amount" in a) && !("amount" in a));
  check("completeStop forwards the verified actor + session_version",
    a.p_by_actor === "rider" && a.p_session_version === 4);
  check("completeStop forwards the deterministic idempotency key", a.p_idem_scope_key === "pay-order-ORD2");

  // A stop with no collection (prepaid order, or the operator "driver volvió" override)
  // must still complete — with an EMPTY method, so the RPC writes no financial event.
  await riderTrip.completeStop("ORD3", "", { byActor: "rider", sessionVersion: 4, ipHash: "iphash", idemScopeKey: "pay-order-ORD3" });
  check("completeStop supports a no-collection stop", lastRpc.args.p_metodo_pago === "");
  await riderTrip.completeStop("ORD4", null, { byActor: "rider", sessionVersion: 4, ipHash: "iphash", idemScopeKey: "pay-order-ORD4" });
  check("completeStop null method becomes empty string, never a default", lastRpc.args.p_metodo_pago === "");

  // closeTrip forwards no args
  await riderTrip.closeTrip();
  check("closeTrip -> close_rider_trip() no args", lastRpc.fn === "close_rider_trip" && Object.keys(lastRpc.args).length === 0);

  await riderTrip.beginServiceCloseIfIdle({ serviceDate: "2026-07-21", source: "manual" });
  check("beginServiceCloseIfIdle forwards service date/source", lastRpc.fn === "begin_service_close_if_idle" && lastRpc.args.p_service_date === "2026-07-21" && lastRpc.args.p_source === "manual");

  await riderTrip.endServiceClose("close-1");
  check("endServiceClose forwards close_id", lastRpc.fn === "end_service_close" && lastRpc.args.p_close_id === "close-1");

  await riderTrip.deleteOrder("#042");
  check("deleteOrder -> delete_order_if_not_active(p_order_id)", lastRpc.fn === "delete_order_if_not_active" && lastRpc.args.p_order_id === "#042" && Object.keys(lastRpc.args).length === 1);

  // M-1 — the new refusal code maps through mapResult exactly like the
  // pre-existing active-trip refusal: 409, error body carries only the code.
  STUB = () => ({ httpStatus: 200, ok: true, body: { ok: false, code: "ORDER_HAS_FINANCIAL_EVIDENCE" } });
  const evidenceResult = await riderTrip.deleteOrder("#042");
  check("deleteOrder financial-evidence refusal -> 409", evidenceResult.status === 409);
  check("deleteOrder financial-evidence refusal payload", evidenceResult.payload.error === "ORDER_HAS_FINANCIAL_EVIDENCE");
  STUB = () => ({ httpStatus: 200, ok: true, body: { ok: true, code: "OK" } });

  await riderTrip.deleteConversation("wa-1");
  check("deleteConversation -> delete_conversation_if_not_active(wa_id)", lastRpc.fn === "delete_conversation_if_not_active" && lastRpc.args.p_wa_id === "wa-1");

  // N-1 — the financial-evidence refusal maps through mapResult exactly like
  // M-1's order-level refusal: 409, error body carries only the code.
  STUB = () => ({ httpStatus: 200, ok: true, body: { ok: false, code: "CONVERSATION_HAS_FINANCIAL_EVIDENCE" } });
  const convEvidenceResult = await riderTrip.deleteConversation("wa-protected");
  check("deleteConversation financial-evidence refusal -> 409", convEvidenceResult.status === 409);
  check("deleteConversation financial-evidence refusal payload", convEvidenceResult.payload.error === "CONVERSATION_HAS_FINANCIAL_EVIDENCE");
  STUB = () => ({ httpStatus: 200, ok: true, body: { ok: true, code: "OK" } });

  // N-1 — application-layer wa_id validation short-circuits BEFORE the RPC is
  // ever called: a null/blank/whitespace-only wa_id never reaches the network.
  for (const bad of [null, undefined, "", "   ", "\t\n"]) {
    lastRpc = null;
    const r = await riderTrip.deleteConversation(bad);
    check(`deleteConversation(${JSON.stringify(bad)}) rejected without calling the RPC`, lastRpc === null);
    check(`deleteConversation(${JSON.stringify(bad)}) -> 400 INVALID_WA_ID`, r.status === 400 && r.payload.error === "INVALID_WA_ID");
  }
  // A real wa_id still reaches the RPC exactly as before (regression guard for the loop above).
  lastRpc = null;
  await riderTrip.deleteConversation("wa-1");
  check("deleteConversation(real wa_id) still calls the RPC", lastRpc !== null && lastRpc.fn === "delete_conversation_if_not_active");

  console.log(`\nriderTripWrapper: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.message)); process.exit(1); });
