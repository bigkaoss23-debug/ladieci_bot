// tests/serviceCloseGate.test.js — S2-1F.
// Proves chiudiServizio(...) is gated by the transactional active-trip check BEFORE any
// destructive archival/deletion: an active trip defers the close (nothing deleted), an RPC
// failure fails closed, and an idle state proceeds normally. Offline: supabase + riderTrip
// stubbed via require.cache. Run: node tests/serviceCloseGate.test.js

const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let deletes = [], inserts = [], upserts = [];
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (t) => (t === "serata_summary" ? [] : []),         // not closed today; no orders
  sbInsert: async (t, d) => { inserts.push(t); return [{ ...d }]; }, // serata_summary lock OK
  sbUpsert: async (t) => { upserts.push(t); return [{}]; },
  sbUpdate: async () => [{}],
  sbDelete: async (t, q) => { deletes.push([t, q]); return []; },
});

const rtPath = require.resolve("../src/agents/riderTrip");
const realRt = require(rtPath);
let RESET;                       // programmable resetIfIdle result, or a thrower flag
let throwReset = false;
require.cache[rtPath].exports = Object.assign({}, realRt, {
  resetIfIdle: async () => { if (throwReset) throw new Error("rpc down"); return RESET; },
  closeTrip: async () => ({ status: 200, payload: { ok: true, code: "NO_ACTIVE_TRIP" } }),
});

const { chiudiServizio } = require("../src/utils/servizio");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const reset = () => { deletes = []; inserts = []; upserts = []; throwReset = false; };

(async () => {
  // ── Active trip -> DEFERRED, no destructive work ──
  reset();
  RESET = { status: 409, payload: { ok: false, error: "ACTIVE_TRIP_CONFLICT" } };
  let r = await chiudiServizio(true, "cron2350");
  check("active trip -> deferred skipped result", r.skipped === true && r.deferred === true && r.reason === "active_rider_trip");
  check("active trip -> NO ordenes deletion", !deletes.some(([t]) => t === "ordenes"));
  check("active trip -> NO serata_summary lock insert", !inserts.includes("serata_summary"));
  check("active trip -> NO config write", upserts.length === 0);

  // ── RPC failure -> fail closed, no destructive work ──
  reset();
  throwReset = true;
  r = await chiudiServizio(true, "external");
  check("RPC failure -> fail closed", r.success === false && r.error === "rider_state_gate_failed");
  check("RPC failure -> NO ordenes deletion", !deletes.some(([t]) => t === "ordenes"));

  // ── Gate not-ok (unexpected) -> fail closed ──
  reset();
  RESET = { status: 500, payload: { error: "internal_error" } };
  r = await chiudiServizio(true, "manual");
  check("gate not-ok -> fail closed", r.success === false && r.error === "rider_state_gate_failed");
  check("gate not-ok -> NO deletion", deletes.length === 0);

  // ── No active trip -> proceeds through the destructive/reset steps ──
  reset();
  RESET = { status: 200, payload: { ok: true, code: "OK", stato: "LIBERO" } };
  r = await chiudiServizio(true, "manual");
  check("idle -> service close proceeds (reaches cleanup)", deletes.some(([t]) => t === "ordenes"));
  check("idle -> serata_summary lock taken", inserts.includes("serata_summary"));
  check("idle -> NO direct DRIVER_STATO config write", !upserts.includes("DRIVER_STATO"));

  console.log(`\nserviceCloseGate: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
