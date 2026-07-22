"use strict";
// S2-6A3B — regression suite for the forced-close path.
//
// Real staging incident it reproduces: a synthetic order kept a RESTRICT foreign key
// from order_financial_events, so PASSO 10's DELETE on ordenes was rejected. The old
// code ignored the response, declared the service closed, and the nightly job archived
// the very same order again — six CHIUSO_FORZATO rows in six nights, order still
// EN_COCINA. These tests pin the corrected contract.
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const SUPA = require.resolve("../src/utils/supabase");
const RIDER = require.resolve("../src/agents/riderTrip");
const LIFECYCLE = require.resolve("../src/serviceSessions/serviceSessionLifecycle");
const GIROS = require.resolve("../src/agents/manualGiros");
const SERVIZIO = require.resolve("../src/utils/servizio");

const SESSION_ID = "00000000-0000-4000-8000-0000000000fe";
const BUSINESS_DATE = "2026-07-22";

// A tiny in-memory Supabase whose ordenes DELETE can be made to behave like PostgREST
// under a RESTRICT foreign key: HTTP 409 body, rows untouched.
function makeStub({ restrictOrders = [], orders } = {}) {
  const state = {
    ordenes: orders || [{ id: "SYNTH_1", estado: "EN_COCINA", service_session_id: SESSION_ID, totale: 30, direccion: null }],
    storico: [],
    serata_summary: [],
    order_financial_events: [{ id: "ev1", order_id: "SYNTH_1", type: "refund", amount: 30 }],
    conv: [], wa_msgs: [], archivio_conv: [], backup_serata: [], config: [],
  };
  const log = { deletes: [], upserts: [] };
  const match = (table, query) => {
    const rows = state[table] || [];
    if (table !== "ordenes") return rows;
    let out = rows.filter(r => query.includes(`service_session_id=eq.${SESSION_ID}`) ? r.service_session_id === SESSION_ID : true);
    const term = ["RETIRADO", "COMPLETADO", "COMPLETATO"];
    if (/estado=in\.\(RETIRADO/.test(query)) out = out.filter(r => term.includes(r.estado));
    if (/estado=not\.in\.\(RETIRADO/.test(query)) out = out.filter(r => !term.includes(r.estado));
    return out;
  };
  const stub = {
    sbSelect: async (table, query = "") => match(table, query).map(r => ({ ...r })),
    sbInsert: async (table, data) => { state[table] = (state[table] || []).concat(data); return [data]; },
    sbUpsert: async (table, data, onConflict) => {
      log.upserts.push({ table, onConflict, key: data.orden_id });
      const rows = state[table] || (state[table] = []);
      if (table === "storico") {
        // Mirrors the storico_session_order_uq partial unique index created by the
        // service-session migration: an upsert on the same key rewrites, never appends.
        const i = rows.findIndex(r => r.orden_id === data.orden_id && r.service_session_id === data.service_session_id);
        if (i >= 0) rows[i] = { ...data }; else rows.push({ ...data });
      } else rows.push({ ...data });
      return [data];
    },
    sbUpdate: async () => [{}],
    sbDelete: async (table, query) => {
      log.deletes.push({ table, query });
      const victims = match(table, query);
      if (table === "ordenes" && victims.some(v => restrictOrders.includes(v.id))) {
        return { code: "23503", message: 'update or delete on table "ordenes" violates foreign key constraint "ofe_order_id_fk" on table "order_financial_events"' };
      }
      state[table] = (state[table] || []).filter(r => !victims.includes(r));
      return "";
    },
    getConfig: async () => ({}),
    sbRpc: async () => ({ ok: true }),
  };
  return { stub, state, log };
}

function loadServizio({ stub }) {
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
  return require(SERVIZIO);
}

test.afterEach(() => { for (const m of [SERVIZIO, SUPA, RIDER, LIFECYCLE, GIROS]) delete require.cache[m]; });

test("a RESTRICT foreign key rejecting the delete is a controlled, observable failure", async () => {
  const { stub, state } = makeStub({ restrictOrders: ["SYNTH_1"] });
  const { chiudiServizio } = loadServizio({ stub });
  const out = await chiudiServizio(true, "test", "owner");

  assert.equal(out.success, false, "close must not report success");
  assert.equal(out.error, "ordenes_delete_failed");
  assert.equal(out.service_session_id, SESSION_ID);
  const failure = out.details.failures[0];
  assert.equal(failure.scope, "attivi");
  assert.equal(failure.remaining, 1);
  assert.deepEqual(failure.ids, ["SYNTH_1"]);
  assert.match(failure.message, /ofe_order_id_fk/, "the underlying cause is surfaced, not swallowed");
  assert.equal(state.ordenes.length, 1, "the undeleted order is still there — reality is reported truthfully");
  assert.equal(state.order_financial_events.length, 1, "financial evidence is never deleted by the close");
});

test("the nightly retry adds no further storico rows and keeps failing loudly", async () => {
  const { stub, state } = makeStub({ restrictOrders: ["SYNTH_1"] });
  const { chiudiServizio } = loadServizio({ stub });

  const nights = [];
  for (let n = 0; n < 6; n++) nights.push(await chiudiServizio(true, "auto", "system"));

  assert.ok(nights.every(r => r.success === false && r.error === "ordenes_delete_failed"), "six nights, six controlled errors");
  const archived = state.storico.filter(r => r.orden_id === "SYNTH_1");
  assert.equal(archived.length, 1, "one archive row for the session, not one per night (the six-row incident)");
  assert.equal(archived[0].estado, "CHIUSO_FORZATO");
  assert.equal(state.ordenes.length, 1, "the order is never silently considered gone");
});

test("archiving is idempotent through the (service_session_id, orden_id) key", async () => {
  const { stub, log } = makeStub({ restrictOrders: ["SYNTH_1"] });
  const { chiudiServizio } = loadServizio({ stub });
  await chiudiServizio(true, "auto", "system");
  await chiudiServizio(true, "auto", "system");
  const storicoUpserts = log.upserts.filter(u => u.table === "storico");
  assert.equal(storicoUpserts.length, 2, "both attempts write");
  assert.ok(storicoUpserts.every(u => u.onConflict === "service_session_id,orden_id"), "keyed upsert, not blind insert");
});

test("a normal close deletes its orders and reports success", async () => {
  const { stub, state } = makeStub({
    orders: [
      { id: "DONE_1", estado: "COMPLETADO", service_session_id: SESSION_ID, totale: 20 },
      { id: "LEFT_1", estado: "EN_COCINA", service_session_id: SESSION_ID, totale: 10 },
    ],
  });
  const { chiudiServizio } = loadServizio({ stub });
  const out = await chiudiServizio(true, "manual", "owner");

  assert.equal(out.success, true);
  assert.equal(out.service_session_id, SESSION_ID);
  assert.equal(out.ordini_storico, 2);
  assert.equal(state.ordenes.length, 0, "both terminal and forced orders removed");
  assert.equal(state.storico.length, 2);
  assert.equal(state.storico.find(r => r.orden_id === "LEFT_1").estado, "CHIUSO_FORZATO");
  assert.equal(state.storico.find(r => r.orden_id === "DONE_1").estado, "COMPLETADO",
    "a genuinely terminal order keeps its own final state");
});

test("a duplicate close call on an already-closed session is idempotent and non-destructive", async () => {
  const { stub, state } = makeStub({});
  const svc = loadServizio({ stub });
  const first = await svc.chiudiServizio(true, "manual", "owner");
  assert.equal(first.success, true);

  // Second call: the lifecycle now reports the session as closed.
  require.cache[LIFECYCLE].exports.lifecycle.currentCloseout = async () => ({
    ok: true, code: "OK", session: { id: SESSION_ID, business_date: BUSINESS_DATE, status: "closed" },
  });
  const storicoBefore = state.storico.length;
  const second = await svc.chiudiServizio(true, "manual", "owner");

  assert.equal(second.skipped, true);
  assert.equal(second.reason, "already_closed_session");
  assert.equal(second.service_session_id, SESSION_ID);
  assert.equal(state.storico.length, storicoBefore, "no second archive pass");
});

test("terminal orders of other sessions are never touched", async () => {
  const { stub, state } = makeStub({
    orders: [
      { id: "MINE", estado: "COMPLETADO", service_session_id: SESSION_ID, totale: 5 },
      { id: "OTHER", estado: "COMPLETADO", service_session_id: "00000000-0000-4000-8000-0000000000ff", totale: 5 },
    ],
  });
  const { chiudiServizio } = loadServizio({ stub });
  const out = await chiudiServizio(true, "manual", "owner");
  assert.equal(out.success, true);
  assert.deepEqual(state.ordenes.map(r => r.id), ["OTHER"], "another session's data is out of scope");
});
