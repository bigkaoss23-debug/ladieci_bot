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
    ["NO_ACTIVE_TRIP", 409], ["BAD_REQUEST", 400],
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

  // completeStop forwards ONLY id/cobrado/metodo_pago — financial whitelist
  await riderTrip.completeStop("ORD2", true, "efectivo");
  const a = lastRpc.args;
  check("completeStop -> complete_rider_stop", lastRpc.fn === "complete_rider_stop");
  check("completeStop whitelist keys exact", JSON.stringify(Object.keys(a).sort()) === JSON.stringify(["p_cobrado","p_metodo_pago","p_order_id"]));
  check("completeStop forbids financial fields",
    !("descuento_tipo" in a) && !("descuento_valor" in a) && !("total" in a) && !("totale" in a) && !("pagado" in a) && !("ya_pagado" in a) && !("estado" in a));
  check("completeStop coerces cobrado to boolean", a.p_cobrado === true);

  // closeTrip forwards no args
  await riderTrip.closeTrip();
  check("closeTrip -> close_rider_trip() no args", lastRpc.fn === "close_rider_trip" && Object.keys(lastRpc.args).length === 0);

  console.log(`\nriderTripWrapper: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.message)); process.exit(1); });
