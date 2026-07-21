// tests/telemetryReconciliation.test.js — S2-1D.
// Proves the operator/admin reconciliation path never writes DRIVER_STATO directly: it only
// requests close via the RPC, treats early-close/no-active-trip as a controlled no-op, and
// never falls back to a legacy direct write on RPC failure. Offline (riderTrip + supabase
// stubbed via require.cache). Run: node tests/telemetryReconciliation.test.js

// Stub supabase — record any write attempt (there must be none from telemetry).
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let writes = [];
let activeCount = 0;
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (table) => {
    if (table === "config") return [{ chiave: "DRIVER_STATO", valore: JSON.stringify({ stato: "IN_GIRO" }) }];
    if (table === "ordenes") return new Array(activeCount).fill({ id: "x" });
    return [];
  },
  sbUpsert: async (...a) => { writes.push(["upsert", ...a]); return {}; },
  sbInsert: async (...a) => { writes.push(["insert", ...a]); return {}; },
  sbUpdate: async (...a) => { writes.push(["update", ...a]); return {}; },
});

// Stub riderTrip — record close calls, return a programmable mapped result.
const rtPath = require.resolve("../src/agents/riderTrip");
const realRt = require(rtPath);
let closeCalls = 0;
let CLOSE_RESULT = { status: 200, payload: { ok: true, code: "OK", snapshot: { trip_id: "T1", closed_at: "2026-07-21T00:00:00Z" } } };
require.cache[rtPath].exports = Object.assign({}, realRt, {
  closeTrip: async () => { closeCalls++; return CLOSE_RESULT; },
});

const tele = require("../src/utils/driverTelemetry");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

(async () => {
  // recordRiderOut is inert (no write).
  writes = [];
  const rro = await tele.recordRiderOut({ zona: "Q1", nOrdini: 3 });
  check("recordRiderOut writes nothing", writes.length === 0 && rro.skipped === "obsolete_use_start_rider_trip");

  // writeDriverStato disabled.
  writes = [];
  const w = await tele.writeDriverStato({ stato: "IN_GIRO" });
  check("writeDriverStato disabled -> false, no write", w === false && writes.length === 0);

  // closeGiroInternal success maps to legacy shape, no direct write.
  writes = []; closeCalls = 0;
  const ok = await tele.closeGiroInternal();
  check("close success -> {success:true}, RPC called once, no direct write", ok.success === true && closeCalls === 1 && writes.length === 0);

  // Early close (409) -> controlled no-op success, no write.
  writes = []; closeCalls = 0;
  CLOSE_RESULT = { status: 409, payload: { ok: false, error: "EARLY_CLOSE" } };
  const early = await tele.closeGiroInternal();
  check("early close -> controlled no-op success", early.success === true && early.skipped === "EARLY_CLOSE" && writes.length === 0);

  // RPC transport failure (500) -> failure, NEVER a legacy direct write.
  writes = []; closeCalls = 0;
  CLOSE_RESULT = { status: 500, payload: { error: "internal_error" } };
  const boom = await tele.closeGiroInternal();
  check("RPC failure -> failure, no fallback write", boom.success === false && writes.length === 0);

  // recordDeliveryAndMaybeReturn: non-last member -> no close call.
  CLOSE_RESULT = { status: 200, payload: { ok: true, code: "OK", snapshot: {} } };
  writes = []; closeCalls = 0; activeCount = 2; // remaining > 0
  const notLast = await tele.recordDeliveryAndMaybeReturn({ id: "a", manual_giro_id: null });
  check("non-last delivery -> no close, no write", closeCalls === 0 && writes.length === 0 && notLast.skipped === "not_last");

  // Last member -> exactly one close call, no direct write.
  writes = []; closeCalls = 0; activeCount = 0; // remaining == 0
  await tele.recordDeliveryAndMaybeReturn({ id: "a", manual_giro_id: null });
  check("last delivery -> exactly one close RPC, no write", closeCalls === 1 && writes.length === 0);

  // Duplicate reconciliation (idempotent close) -> still no duplicate write.
  writes = []; closeCalls = 0; activeCount = 0;
  CLOSE_RESULT = { status: 200, payload: { ok: true, code: "IDEMPOTENT", snapshot: {} } };
  await tele.recordDeliveryAndMaybeReturn({ id: "a", manual_giro_id: null });
  check("duplicate reconciliation -> idempotent, no duplicate write", writes.length === 0);

  console.log(`\ntelemetryReconciliation: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
