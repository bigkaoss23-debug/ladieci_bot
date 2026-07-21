// tests/driverTelemetrySecondGiro.test.js — DELIVERY-RIDER-SECOND-GIRO-01 (S2-1D update).
//
// Historically this exercised recordRiderOut per-giro idempotency and the final-delivery
// closing contract by inspecting direct DRIVER_STATO writes. Under S2-1D DRIVER_STATO/trip
// lifecycle — including second-giro separation — is owned EXCLUSIVELY by the transactional
// rider-trip RPCs (start_rider_trip / complete_rider_stop / close_rider_trip); the JS
// telemetry writers no longer mutate state. This test now proves that delegated contract:
//   • recordRiderOut is inert (no DRIVER_STATO write)
//   • closeGiroInternal delegates to close_rider_trip and never writes directly
//   • second-giro separation lives in the RPC (trip_seq increment), verified statically
// No real DB: riderTrip + supabase are stubbed via require.cache. Run: node tests/....test.js
const fs = require("fs");
const path = require("path");

const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let writes = [];
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async () => [],
  sbUpsert: async (...a) => { writes.push(a); return {}; },
  sbInsert: async (...a) => { writes.push(a); return {}; },
  sbUpdate: async (...a) => { writes.push(a); return {}; },
});
const rtPath = require.resolve("../src/agents/riderTrip");
const realRt = require(rtPath);
let closeCalls = 0;
require.cache[rtPath].exports = Object.assign({}, realRt, {
  closeTrip: async () => { closeCalls++; return { status: 200, payload: { ok: true, code: "OK", snapshot: { trip_id: "T2" } } }; },
});

const tele = require("../src/utils/driverTelemetry");
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

(async () => {
  // recordRiderOut: no fresh DRIVER_STATO write, ever (start is start_rider_trip only).
  writes = [];
  const r1 = await tele.recordRiderOut({ zona: "Q1", nOrdini: 2 });
  check("recordRiderOut inert on first giro (no write)", writes.length === 0 && r1.skipped === "obsolete_use_start_rider_trip");
  const r2 = await tele.recordRiderOut({ zona: "Q2", nOrdini: 1 });
  check("recordRiderOut inert on second giro (no write)", writes.length === 0 && r2.skipped === "obsolete_use_start_rider_trip");

  // closeGiroInternal delegates to the RPC and writes nothing directly.
  writes = []; closeCalls = 0;
  const c = await tele.closeGiroInternal();
  check("closeGiroInternal delegates to RPC", closeCalls === 1 && c.success === true);
  check("closeGiroInternal writes nothing directly", writes.length === 0);

  // Second-giro separation is owned by the RPC (trip_seq increment).
  const rpc = fs.readFileSync(path.join(__dirname, "..", "migrations", "2026-07-20_rider_trip_rpcs.sql"), "utf8").replace(/--.*$/gm, "");
  check("RPC increments trip_seq for the next giro", /v_trip_seq := COALESCE\(\(v_ds->>'trip_seq'\)::int, 0\) \+ 1/.test(rpc));
  check("RPC preserves prior trip via last_closed_trip", /'last_closed_trip', v_closed/.test(rpc));

  console.log(`\ndriverTelemetrySecondGiro: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
