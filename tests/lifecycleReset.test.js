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

  // language-guard: allow-legacy servizio.js/chiudiServizio are the existing module path and deleted function name this section header cites, not new vocabulary
  // ── servizio.js's own rider-trip gate (chiudiServizio's PASSO 1b) is gone ──
  // language-guard: allow-legacy chiudiServizio is the same existing deleted function name, not new vocabulary
  // N-2 — the application-wide legacy/dead-code purge deleted chiudiServizio
  // in its entirety (zero reachable callers, proven end-to-end): the manual
  // HTTP action's legacy branch is structurally unreachable (every session is
  // now lifecycle_semantics='operational_service_v1'), and its only other
  // caller, incidentSafeRollover.js, was itself unreachable and deleted too.
  // The gate this section used to certify (beginServiceCloseIfIdle call,
  // ACTIVE_TRIP_CONFLICT deferral, rider_state_gate_failed fail-closed path)
  // language-guard: allow-legacy chiudiServizio is the same existing deleted function name cited on the next line, not new vocabulary
  // lived exclusively inside chiudiServizio and went with it. The RPC-level
  // contract above (begin_service_close_if_idle itself) is untouched and
  // still fully covered by this file's first section.
  // language-guard: allow-legacy servizio.js is the existing module path this local variable name and the checks below cite, not new vocabulary
  const servizio = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "servizio.js"), "utf8").replace(/\/\/.*$/gm, "");
  // language-guard: allow-legacy servizio.js/chiudiServizio are the existing module path and deleted function name cited in this assertion label, not new vocabulary
  check("servizio.js no longer references chiudiServizio at all (deleted, not just this gate)", !/chiudiServizio/.test(servizio));
  // language-guard: allow-legacy servizio.js is the existing module path cited in this assertion label, not new vocabulary
  check("servizio.js has no direct DRIVER_STATO sbUpsert", !/sbUpsert\("config", \{ chiave: "DRIVER_STATO"/.test(servizio));

  console.log(`\nlifecycleReset: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
