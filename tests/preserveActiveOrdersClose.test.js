"use strict";
// SERVICE LIFECYCLE RUNTIME AUTHORITY RECOVERY — regression suite for
// closeContext.preserveActiveOrders.
//
// Real staging incident it reproduces: the automatic rollover orchestrator
// called the close engine with deleteAttivi=true (meant only to stop a
// residual order from BLOCKING the close), which also, as an unintended side
// effect, archived that order to a terminal forced-close state and removed
// it from canonical storage — even for a deliberately-preserved synthetic
// test record explicitly marked "never remove". preserveActiveOrders=true
// decouples the two: a residual order still never blocks the close, but is
// no longer archived/deleted by it. These tests pin that contract directly
// (same in-memory-stub harness as tests/forcedCloseDeleteVerification.test.js).
const assert = require("node:assert/strict");
const test = require("node:test");

const SUPA = require.resolve("../src/utils/supabase");
const RIDER = require.resolve("../src/agents/riderTrip");
const LIFECYCLE = require.resolve("../src/serviceSessions/serviceSessionLifecycle");
const GIROS = require.resolve("../src/agents/manualGiros");
// language-guard: allow-legacy the required path/export name below is the real close-engine module this test exercises directly, not new vocabulary
const SERVIZIO = require.resolve("../src/utils/servizio");

const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const BUSINESS_DATE = "2026-08-12";

function makeStub({ orders } = {}) {
  const state = {
    ordenes: orders || [],
    storico: [], // language-guard: allow-legacy storico/serata_summary are the existing archive tables this in-memory stub mirrors, not new vocabulary
    serata_summary: [],
    order_financial_events: [],
    // language-guard: allow-legacy archivio_conv/backup_serata are the existing table names this stub mirrors, not new vocabulary
    conv: [], wa_msgs: [], archivio_conv: [], backup_serata: [], config: [],
    table_sessions: [],
  };
  const match = (table, query) => {
    const rows = state[table] || [];
    if (table !== "ordenes") return rows;
    let out = rows.filter(r => query.includes(`service_session_id=eq.${SESSION_ID}`) ? r.service_session_id === SESSION_ID : true);
    // language-guard: allow-legacy COMPLETATO is the existing terminal-estado literal this stub's filter must match, not new vocabulary
    const term = ["RETIRADO", "COMPLETADO", "COMPLETATO"];
    if (/estado=in\.\(RETIRADO/.test(query)) out = out.filter(r => term.includes(r.estado));
    if (/estado=not\.in\.\(RETIRADO/.test(query)) out = out.filter(r => !term.includes(r.estado));
    return out;
  };
  const stub = {
    sbSelect: async (table, query = "") => match(table, query).map(r => ({ ...r })),
    sbInsert: async (table, data) => { state[table] = (state[table] || []).concat(data); return [data]; },
    sbUpsert: async (table, data, onConflict) => {
      const rows = state[table] || (state[table] = []);
      // language-guard: allow-legacy storico is the existing archive table this stub's upsert key logic mirrors, not new vocabulary
      if (table === "storico") {
        const i = rows.findIndex(r => r.orden_id === data.orden_id && r.service_session_id === data.service_session_id);
        if (i >= 0) rows[i] = { ...data }; else rows.push({ ...data });
      } else rows.push({ ...data });
      return [data];
    },
    sbUpdate: async () => [{}],
    sbDelete: async (table, query) => {
      const victims = match(table, query);
      state[table] = (state[table] || []).filter(r => !victims.includes(r));
      return "";
    },
    getConfig: async () => ({}),
    sbRpc: async () => ({ ok: true }),
  };
  return { stub, state };
}

function loadServizio({ stub }) { // language-guard: allow-legacy loadServizio/SERVIZIO name the existing close-engine module this helper loads, not new vocabulary
  for (const m of [SERVIZIO, SUPA, RIDER, LIFECYCLE, GIROS]) delete require.cache[m];
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: stub };
  require.cache[RIDER] = {
    id: RIDER, filename: RIDER, loaded: true,
    exports: {
      beginServiceCloseIfIdle: async () => ({ payload: { ok: true, close_id: "close-1" } }),
      endServiceClose: async () => ({ ok: true }),
    },
  };
  require.cache[LIFECYCLE] = {
    id: LIFECYCLE, filename: LIFECYCLE, loaded: true,
    exports: {
      lifecycle: {
        currentCloseout: async () => ({ ok: true, code: "OK", session: { id: SESSION_ID, business_date: BUSINESS_DATE, status: "open" } }),
        beginClose: async () => ({ ok: true, code: "CLOSING", session: { id: SESSION_ID, business_date: BUSINESS_DATE, status: "closing" } }),
        completeClose: async () => ({ ok: true, code: "CLOSED" }),
      },
    },
  };
  require.cache[GIROS] = {
    id: GIROS, filename: GIROS, loaded: true,
    exports: { softDissolveActiveManualGirosForClose: async () => ({ dissolved_count: 0, detached_count: 0, errors: [] }) },
  };
  return require(SERVIZIO); // language-guard: allow-legacy SERVIZIO names the existing close-engine module this helper loads, not new vocabulary
}

test.afterEach(() => { for (const m of [SERVIZIO, SUPA, RIDER, LIFECYCLE, GIROS]) delete require.cache[m]; }); // language-guard: allow-legacy SERVIZIO names the existing close-engine module this helper loads, not new vocabulary

test("preserveActiveOrders:true closes successfully and leaves a residual active order completely untouched", async () => {
  const { stub, state } = makeStub({
    orders: [
      { id: "DONE_1", estado: "COMPLETADO", service_session_id: SESSION_ID, totale: 20 },
      { id: "LIVE_1", estado: "EN_COCINA", service_session_id: SESSION_ID, totale: 15 },
    ],
  });
  const { chiudiServizio } = loadServizio({ stub }); // language-guard: allow-legacy chiudiServizio is the existing close-engine export this test exercises directly, not new vocabulary
  const out = await chiudiServizio(true, "auto", "system", { preserveActiveOrders: true });

  assert.equal(out.success, true, "the close must not be blocked by the residual active order");
  assert.deepEqual(state.ordenes.map(r => r.id), ["LIVE_1"], "the active order is never deleted from canonical storage");
  const live = state.ordenes.find(r => r.id === "LIVE_1");
  assert.equal(live.estado, "EN_COCINA", "its estado is never rewritten to a terminal/forced state");
  // language-guard: allow-legacy storico is the existing archive table this assertion checks, not new vocabulary
  assert.equal(state.storico.find(r => r.orden_id === "LIVE_1"), undefined, "it is never archived either — no phantom storico row");
});

test("preserveActiveOrders:true still archives and removes a genuinely terminal order normally", async () => {
  const { stub, state } = makeStub({
    orders: [
      { id: "DONE_1", estado: "COMPLETADO", service_session_id: SESSION_ID, totale: 20 },
      { id: "LIVE_1", estado: "EN_COCINA", service_session_id: SESSION_ID, totale: 15 },
    ],
  });
  const { chiudiServizio } = loadServizio({ stub }); // language-guard: allow-legacy chiudiServizio is the existing close-engine export this test exercises directly, not new vocabulary
  await chiudiServizio(true, "auto", "system", { preserveActiveOrders: true });

  // language-guard: allow-legacy storico is the existing archive table this assertion checks, not new vocabulary
  assert.equal(state.storico.find(r => r.orden_id === "DONE_1")?.estado, "COMPLETADO", "a real terminal order is archived with its own final state");
  assert.equal(state.ordenes.find(r => r.id === "DONE_1"), undefined, "and removed from canonical storage, exactly as before this flag existed");
});

test("preserveActiveOrders:true skips the active-order block gate even when deleteAttivi is false", async () => {
  const { stub, state } = makeStub({
    orders: [{ id: "LIVE_1", estado: "EN_COCINA", service_session_id: SESSION_ID, totale: 15 }],
  });
  const { chiudiServizio } = loadServizio({ stub }); // language-guard: allow-legacy chiudiServizio is the existing close-engine export this test exercises directly, not new vocabulary
  const out = await chiudiServizio(false, "auto", "system", { preserveActiveOrders: true });

  assert.equal(out.success, true, "preserveActiveOrders alone must still bypass the block-on-active-orders gate");
  assert.notEqual(out.error, "service_active_orders_not_resolved");
  assert.deepEqual(state.ordenes.map(r => r.id), ["LIVE_1"], "and still never deletes the untouched active order");
});

test("without preserveActiveOrders, deleteAttivi:true keeps its original archive-and-delete behavior (regression guard)", async () => {
  const { stub, state } = makeStub({
    orders: [{ id: "LIVE_1", estado: "EN_COCINA", service_session_id: SESSION_ID, totale: 15 }],
  });
  const { chiudiServizio } = loadServizio({ stub }); // language-guard: allow-legacy chiudiServizio is the existing close-engine export this test exercises directly, not new vocabulary
  const out = await chiudiServizio(true, "manual", "owner");

  assert.equal(out.success, true);
  assert.equal(state.ordenes.length, 0, "deleteAttivi alone still removes the active order — unchanged for the manual force-close action");
  // language-guard: allow-legacy storico/CHIUSO_FORZATO are the existing archive table and terminal-estado literal this regression guard checks, not new vocabulary
  assert.equal(state.storico.find(r => r.orden_id === "LIVE_1")?.estado, "CHIUSO_FORZATO", "and still archives it as force-closed, unchanged");
});

test("preserveActiveOrders:false (the default) behaves identically to omitting closeContext entirely", async () => {
  const { stub, state } = makeStub({
    orders: [{ id: "LIVE_1", estado: "EN_COCINA", service_session_id: SESSION_ID, totale: 15 }],
  });
  const { chiudiServizio } = loadServizio({ stub }); // language-guard: allow-legacy chiudiServizio is the existing close-engine export this test exercises directly, not new vocabulary
  const out = await chiudiServizio(true, "manual", "owner", { preserveActiveOrders: false });

  assert.equal(out.success, true);
  assert.equal(state.ordenes.length, 0, "an explicit false is not a magic override — same archive-and-delete outcome as the default");
  // language-guard: allow-legacy storico/CHIUSO_FORZATO are the existing archive table and terminal-estado literal this assertion checks, not new vocabulary
  assert.equal(state.storico.find(r => r.orden_id === "LIVE_1")?.estado, "CHIUSO_FORZATO");
});
