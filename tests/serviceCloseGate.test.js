// tests/serviceCloseGate.test.js — S2-1F.
// Proves chiudiServizio(...) is gated by the transactional active-trip check BEFORE any
// destructive archival/deletion: an active trip defers the close (nothing deleted), an RPC
// failure fails closed, and an idle state proceeds normally. Offline: supabase + riderTrip
// stubbed via require.cache. Run: node tests/serviceCloseGate.test.js

const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let deletes = [], inserts = [], upserts = [];
let existingSummary = [];
let completedOrders = [];
let activeOrders = [];
let throwStorico = false;
let ordersDeleted = false;
let tableSessions = [];
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async (t, q) => {
    if (t === "serata_summary") return existingSummary;
    // S2-6A3B: the close now re-reads ordenes after deleting to prove the rows are gone,
    // so the stub must model deletion instead of always replaying the same rows.
    if (t === "ordenes") {
      if (/select=id,estado/.test(q || "")) return activeOrders;
      return ordersDeleted ? [] : completedOrders;
    }
    if (t === "table_sessions") return tableSessions;
    if (t === "storico" && /select=orden_id/.test(q || "")) return completedOrders.map(o => ({ orden_id: o.id }));
    return [];
  },
  sbInsert: async (t, d) => { inserts.push(t); return [{ ...d }]; }, // serata_summary lock OK
  sbUpsert: async (t) => { if (throwStorico && t === "storico") throw new Error("archive crash"); upserts.push(t); return [{}]; },
  sbUpdate: async () => [{}],
  sbDelete: async (t, q) => { deletes.push([t, q]); if (t === "ordenes") ordersDeleted = true; return []; },
});

const rtPath = require.resolve("../src/agents/riderTrip");
const realRt = require(rtPath);
let RESET;                       // programmable resetIfIdle result, or a thrower flag
let throwReset = false;
let endCalls = 0;
let beginCalls = 0;
let endIds = [];
require.cache[rtPath].exports = Object.assign({}, realRt, {
  beginServiceCloseIfIdle: async () => { beginCalls++; if (throwReset) throw new Error("rpc down"); return RESET; },
  endServiceClose: async (closeId) => { endCalls++; endIds.push(closeId); return { status: 200, payload: { ok: true, code: "OK" } }; },
  closeTrip: async () => ({ status: 200, payload: { ok: true, code: "NO_ACTIVE_TRIP" } }),
});

const ssPath = require.resolve("../src/serviceSessions/serviceSessionLifecycle");
const realSs = require(ssPath);
let SESSION_CURRENT, SESSION_BEGIN, sessionCompleteCalls = [];
const sessionLifecycle = {
  currentCloseout: async () => SESSION_CURRENT,
  beginClose: async () => SESSION_BEGIN,
  completeClose: async (args) => { sessionCompleteCalls.push(args); return { ok:true, code:"CLOSED", session:SESSION_BEGIN.session }; },
};
require.cache[ssPath].exports = Object.assign({}, realSs, { lifecycle: sessionLifecycle });

const { chiudiServizio } = require("../src/utils/servizio");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const session = { id:"00000000-0000-4000-8000-000000000001", business_date:"2026-07-22", status:"closing" };
const order = { id: "O1", service_session_id:session.id, wa_id: "wa1", tel: "wa1", estado: "RETIRADO", items: [], tipo_consegna: "DOMICILIO", totale: 10 };
const reset = () => {
  deletes = []; inserts = []; upserts = []; ordersDeleted = false; throwReset = false; endCalls = 0; beginCalls = 0; endIds = [];
  existingSummary = []; completedOrders = []; activeOrders = []; throwStorico = false;
  tableSessions = [];
  SESSION_CURRENT = { ok:true, code:"OK", session:{...session,status:"open"} };
  SESSION_BEGIN = { ok:true, code:"CLOSING", session }; sessionCompleteCalls=[];
};

(async () => {
  // ── Active order + "leave messages" -> refuse before close starts ──
  reset();
  activeOrders = [{ id: "O-live", estado: "EN_COCINA" }];
  let r = await chiudiServizio(false, "manual");
  check("active order + non-forced close -> close is refused", r.success === false && r.error === "service_active_orders_not_resolved");
  check("active order refusal exposes the blocking order", r.details?.orders?.[0]?.id === "O-live");
  check("active order refusal is read-only", beginCalls === 0 && deletes.length === 0 && inserts.length === 0);

  // ── Missing/unknown states are unresolved too (SQL not.in would miss NULL) ──
  reset();
  activeOrders = [{ id: "O-null", estado: null }, { id: "O-unknown", estado: "CUSTOM_STATE" }];
  r = await chiudiServizio(false, "manual");
  check("null/unknown order states -> close is refused", r.success === false && r.error === "service_active_orders_not_resolved");
  check("null/unknown refusal reports both blockers", r.details?.count === 2);
  check("null/unknown refusal remains read-only", beginCalls === 0 && deletes.length === 0 && inserts.length === 0);

  // ── Every supported terminal spelling/state is allowed ──
  reset();
  activeOrders = [
    { id: "O-ret", estado: "RETIRADO" },
    { id: "O-es", estado: "COMPLETADO" },
    { id: "O-it", estado: "COMPLETATO" },
    { id: "O-ca", estado: "CANCELADO" },
    { id: "O-cx", estado: "CANCELLED" },
    { id: "O-an", estado: "ANULADO" },
    { id: "O-force", estado: "CHIUSO_FORZATO" },
  ];
  RESET = { status: 200, payload: { ok: true, code: "OK", close_id: "terminal-ok", marker: { close_id: "terminal-ok" }, resumed: false } };
  r = await chiudiServizio(false, "manual");
  check("supported terminal states do not block close", r.success === true);

  // ── Open Mesa -> fail closed before every destructive gate ──
  reset();
  tableSessions = [{ id: "table-session-1", table_ref: "Mesa 3", status: "open" }];
  r = await chiudiServizio(true, "manual");
  check("open Mesa -> close is refused", r.success === false && r.error === "messa_tables_not_released");
  check("open Mesa -> rider gate never opens", beginCalls === 0);
  check("open Mesa -> no destructive work", deletes.length === 0 && inserts.length === 0);

  // ── Active trip -> DEFERRED, no destructive work ──
  reset();
  RESET = { status: 409, payload: { ok: false, error: "ACTIVE_TRIP_CONFLICT" } };
  r = await chiudiServizio(true, "cron2350");
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
  RESET = { status: 200, payload: { ok: true, code: "OK", stato: "LIBERO", close_id: "close-ok", marker: { close_id: "close-ok" }, resumed: false } };
  r = await chiudiServizio(true, "manual");
  check("idle -> service close proceeds (reaches cleanup)", deletes.some(([t]) => t === "ordenes"));
  check("idle -> serata_summary lock taken", inserts.includes("serata_summary"));
  check("idle -> NO direct DRIVER_STATO config write", !upserts.includes("DRIVER_STATO"));
  check("idle -> service_closing marker released after cleanup (endServiceClose)", endCalls === 1);
  check("idle -> releases matching close_id", endIds[0] === "close-ok");

  // ── Duplicate close is identified by the explicit lifecycle pointer ──
  reset();
  SESSION_CURRENT = { ok:true, code:"OK", session:{...session,status:"closed"} };
  r = await chiudiServizio(false, "manual");
  check("already closed session -> idempotent skip", r.skipped === true && r.reason === "already_closed_session");
  check("already closed session -> rider close gate not opened", beginCalls === 0 && endCalls === 0);

  // ── Crash after archival begins -> marker is NOT released ──
  reset();
  completedOrders = [order];
  throwStorico = true;
  RESET = { status: 200, payload: { ok: true, code: "OK", close_id: "close-crash", marker: { close_id: "close-crash" }, resumed: false } };
  let threw = false;
  try { await chiudiServizio(false, "manual"); } catch (_) { threw = true; }
  check("archive crash propagates for retry/recovery", threw === true);
  check("archive crash after destructive start keeps marker", endCalls === 0);

  // ── Recovery resumes same close_id and concludes without taking a new summary lock ──
  reset();
  existingSummary = [{ service_session_id: session.id }];
  completedOrders = [order];
  RESET = { status: 200, payload: { ok: true, code: "OK", close_id: "close-crash", marker: { close_id: "close-crash" }, resumed: true } };
  r = await chiudiServizio(false, "startup_recovery");
  check("recovery resumed close succeeds", r.success === true && endIds[0] === "close-crash");
  check("recovery does not create overlapping serata_summary lock", !inserts.includes("serata_summary"));
  check("overlapping retry uses one begin call / same marker", beginCalls === 1 && RESET.payload.close_id === "close-crash");
  check("successful close completes exact service session", sessionCompleteCalls[0]?.sessionId === session.id);

  console.log(`\nserviceCloseGate: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
