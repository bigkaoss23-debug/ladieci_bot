// tests/lifecycleReset.test.js — S2-1E lifecycle idle reset.
// Proves the end-of-service reset is transactional (begin_service_close_if_idle), refuses to
// erase an active trip, preserves trip_seq/last_closed_trip, and that servizio routes through
// it with no direct write and no fallback on conflict. Offline (sbRpc + supabase stubbed).
// Run: node tests/lifecycleReset.test.js
const fs = require("fs");
const path = require("path");

// ── static SQL contract ──
const rpc = fs.readFileSync(path.join(__dirname, "..", "migrations", "2026-07-20_rider_trip_rpcs.sql"), "utf8").replace(/--.*$/gm, "");
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const resetBody = rpc.slice(rpc.indexOf("FUNCTION public.begin_service_close_if_idle"), rpc.indexOf("FUNCTION public.end_service_close"));

check("reset takes the shared advisory lock", /pg_advisory_xact_lock\(hashtext\('LA_DIECI_DRIVER_STATO'\)\)/.test(resetBody));
check("reset bootstraps missing row", /INSERT INTO public\.config\(chiave, valore\)[\s\S]*ON CONFLICT/.test(resetBody));
check("reset REFUSES an active trip (conflict)", /\(v_active->>'status'\) = 'ACTIVE'[\s\S]*ACTIVE_TRIP_CONFLICT/.test(resetBody));
check("reset sets only idle fields (stato LIBERO, active_trip null)", /'stato',\s*'LIBERO'[\s\S]*'active_trip',\s*'null'::jsonb/.test(resetBody));
check("reset PRESERVES trip_seq (only defaults if missing)", /IF NOT \(v_ds \? 'trip_seq'\) THEN/.test(resetBody));
check("reset does NOT null/delete last_closed_trip", !/last_closed_trip/.test(resetBody) && !/DELETE\s+FROM/i.test(resetBody));
check("reset is SECURITY INVOKER + fixed search_path", /SECURITY INVOKER/.test(resetBody) && /SET search_path = public, pg_temp/.test(resetBody));

// ── wrapper behaviour: riderTrip.resetIfIdle maps RPC codes ──
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let RPC_RESULT = { httpStatus: 200, ok: true, body: { ok: true, code: "OK", stato: "LIBERO" } };
require.cache[supaPath].exports = Object.assign({}, realSupa, { sbRpc: async (fn) => { RPC_RESULT._fn = fn; return RPC_RESULT; } });
const riderTrip = require("../src/agents/riderTrip");

(async () => {
  let r = await riderTrip.beginServiceCloseIfIdle();
  check("resetIfIdle -> begin_service_close_if_idle, 200 on OK", RPC_RESULT._fn === "begin_service_close_if_idle" && r.status === 200);
  RPC_RESULT = { httpStatus: 200, ok: true, body: { ok: false, code: "ACTIVE_TRIP_CONFLICT" } };
  r = await riderTrip.beginServiceCloseIfIdle();
  check("resetIfIdle -> 409 on active-trip conflict (never erases)", r.status === 409 && r.payload.error === "ACTIVE_TRIP_CONFLICT");

  // ── servizio routes through the RPC with no direct write / no fallback ──
  const servizio = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "servizio.js"), "utf8").replace(/\/\/.*$/gm, "");
  check("servizio gate calls beginServiceCloseIfIdle", /beginServiceCloseIfIdle\(\)/.test(servizio));
  check("servizio has no direct DRIVER_STATO sbUpsert", !/sbUpsert\("config", \{ chiave: "DRIVER_STATO"/.test(servizio));
  check("servizio DEFERS on active-trip conflict (no fallback write)",
    /ACTIVE_TRIP_CONFLICT[\s\S]{0,200}deferred: true/.test(servizio) &&
    !/resetIfIdle[\s\S]*sbUpsert\("config", \{ chiave: "DRIVER_STATO"/.test(servizio));
  check("servizio fails closed on gate error (no destructive continue)",
    /rider_state_gate_failed/.test(servizio));

  console.log(`\nlifecycleReset: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
