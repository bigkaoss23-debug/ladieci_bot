"use strict";
// ===============================================================
// DELIVERY x ECONOMY DECOUPLING V1 (migration 139) — backend contract, offline.
//
// THE RULE UNDER TEST. A rider trip is a DELIVERY fact, never an economic blocker:
//   * an ACTIVE trip does not stop Finalizar (manual close, stale auto-recovery, the pre-close scan);
//   * whatever is still owed / still to be delivered stays recoverable (recorded as incidents, never lost);
//   * the departed trip stays visible to the rider and to the operator after its economic service was closed,
//     WITHOUT widening any read to "everything of the old closed service";
//   * the operator's delivery confirmation is a separate, typed, identity-checked action.
//
// This REPLACES the old tests/activeRiderTripServiceCloseGuard.test.js, which asserted the opposite product rule
// against a module (activeRiderTripBlocker.js) that no longer exists. The real close engine, close-authority facade,
// stale-recovery module, pre-close scan, trip reader, residue reader and operator wrapper run here; only I/O is faked.
// The database behaviour is proven on real PostgreSQL by ci/giro-authority-certification/harness/runDeliveryEconomyDecoupling.js.
// No database, no network, no business write.
// ===============================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createServiceLifecycleEngine } = require("../src/serviceSessions/serviceLifecycleEngine");
const { closeoutFieldsFromArgs, rawCloseout } = require("./helpers/v3EvidenceTerminalFake");
const { createServiceCloseAuthority } = require("../src/serviceSessions/serviceCloseAuthority");
const { createStaleServiceRecovery, RECOVERY_CODE } = require("../src/serviceSessions/staleServiceRecovery");
const { createServiceLifecycleV3Transition } = require("../src/serviceSessions/serviceLifecycleV3Transition");
const { readTripProjection, readResidualServiceScope, RESIDUAL_REASON } = require("../src/core/delivery/tripProjectionReader");
const { activeTripFacts } = require("../src/core/delivery/tripProjectionPort");
const { readDepartedTripResidueOrders, mergeOrdersById } = require("../src/core/delivery/departedTripResidue");
const operatorDelivery = require("../src/agents/operatorDelivery");
const legacyActionRoles = require("../src/auth/legacyActionRoles");
const { getResourcePolicy } = require("../src/utils/supabaseResourcePolicy");
// language-guard: allow-legacy scanServizio is the module's existing export name under test, aliased so the rest of this file uses Spanish, not new vocabulary
const scanPreClose = require("../src/utils/servizio").scanServizio;

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const TARGET = "svc-target";
const TODAY = "2026-09-19";
const STALE_DAY = "2026-09-18";

const ORDER = (o = {}) => ({
  id: "#016", orden_id: "#016", order_uid: "uid-016", service_session_id: TARGET, estado: "RETIRADO",
  totale: 15.5, hora: "21:11", cobrado: true, ya_pagado: true, metodo_pago: "efectivo",
  // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, reproduced verbatim in these fixtures, not new vocabulary
  tipo_consegna: "DOMICILIO", ...o,
});
const PAYMENT = (o = {}) => ({
  order_id: "#016", service_session_id: TARGET, type: "payment", amount: 15.5,
  payment_method: "efectivo", created_at: "2026-09-19T09:43:52Z", ...o,
});
const UNPAID_DELIVERY = (o = {}) => ORDER({ estado: "EN_ENTREGA", cobrado: false, ya_pagado: false, metodo_pago: "", ...o });

// ── the world: DB rows + call recorders (the trip is deliberately NOT part of it: the close never reads one) ──
function makeWorld({
  session = { id: TARGET, status: "open", business_date: STALE_DAY, opened_at: "2026-09-18T18:38:48Z", service_kind: null },
  orders = [ORDER()], tables = [], events = [PAYMENT()],
} = {}) {
  const w = {
    session: { ...session }, orders, tables, events,
    attempts: new Map(), closeouts: new Map(), incidentsReported: [],
    calls: { acquire: 0, capture: 0, create: 0, persist: 0, close: 0, complete: 0, closeAuthority: 0 },
  };
  const parse = (q) => {
    const m = q.match(/service_session_id=eq\.([^&]+)/); const est = q.match(/estado=in\.\(([^)]*)\)/); const st = q.match(/status=eq\.([^&]+)/);
    return { sid: m && decodeURIComponent(m[1]), estados: est ? est[1].split(",") : null, status: st ? st[1] : null };
  };
  w.select = async (table, query = "") => {
    if (table === "service_sessions") { const id = decodeURIComponent((query.match(/id=eq\.([^&]+)/) || [])[1] || ""); return id === w.session.id ? [w.session] : []; }
    const { sid, estados, status } = parse(query);
    if (table === "ordenes") return w.orders.filter((o) => o.service_session_id === sid && (!estados || estados.includes(o.estado)));
    if (table === "table_sessions") return w.tables.filter((t) => t.service_session_id === sid && (!status || t.status === status));
    if (table === "order_financial_events") return w.events.filter((e) => e.service_session_id === sid);
    if (table === "order_obligations" || table === "conv" || table === "wa_msgs") return [];
    if (table === "payment_transactions") return []; // corrective slice 150: the receipts the reconciliation is built from
    throw new Error("unexpected table " + table);
  };
  const attempts = {
    async acquire({ serviceSessionId, actor }) {
      w.calls.acquire += 1;
      const ex = w.attempts.get(serviceSessionId);
      if (ex && ex.status === "active") return { success: true, created: false, code: "ALREADY_ACTIVE", attempt: ex };
      const row = { closeoutCorrelationId: "corr-" + (w.attempts.size + 1), serviceSessionId, status: "active", createdBy: actor };
      w.attempts.set(serviceSessionId, row);
      return { success: true, created: true, code: "ACQUIRED", attempt: row };
    },
    async complete({ closeoutCorrelationId }) {
      w.calls.complete += 1;
      for (const a of w.attempts.values()) if (a.closeoutCorrelationId === closeoutCorrelationId) a.status = "completed";
      return { success: true, code: "COMPLETED" };
    },
    async getByCorrelationId({ closeoutCorrelationId }) {
      for (const a of w.attempts.values()) if (a.closeoutCorrelationId === closeoutCorrelationId) return a;
      return null;
    },
  };
  const snapshots = { async capture({ serviceSessionId, closeoutCorrelationId }) { w.calls.capture += 1; return { success: true, created: true, code: "CAPTURED", snapshot: { id: "snap", serviceSessionId, closeoutCorrelationId } }; } };
  const closeoutCreation = {
    async create(fields) {
      w.calls.create += 1;
      const row = {
        id: "co-1", serviceSessionId: fields.serviceSessionId, closeoutCorrelationId: fields.closeoutCorrelationId,
        financial: { paidAmountCents: fields.paidAmountCents, unpaidExposureCents: fields.unpaidExposureCents, orderCount: fields.orderCount },
        operational: { openOrdersAtClose: fields.openOrdersAtClose, occupiedTablesAtClose: fields.occupiedTablesAtClose },
      };
      w.closeouts.set(fields.serviceSessionId, row);
      return { success: true, created: true, code: "CREATED", closeout: row };
    },
  };
  const closeouts = { async getBySessionId({ serviceSessionId }) { return w.closeouts.get(serviceSessionId) || null; } };
  // close_service_session_v3 as migration 139 defines it, reached through migration 149's terminal step (close + attempt
  // completion in one transaction), at the wire level: idempotent when already closed, otherwise it closes -- whatever trip
  // exists. (A rider trip is not an input of the close any more.)
  // Corrective slice 150: the terminal step is close_service_session_with_evidence_v1 -- the closeout and the reconciliation
  // are persisted by it, in the same transaction as the 149 close + completion (modelled here with the same recorders).
  w.dbRpc = async (name, args) => {
    assert.equal(name, "close_service_session_with_evidence_v1");
    let createdCloseout = null;
    if (args.p_closeout && !w.closeouts.get(args.p_service_session_id)) {
      createdCloseout = (await closeoutCreation.create(closeoutFieldsFromArgs(args.p_closeout))).closeout;
    }
    if (args.p_reconciliation) await reconciliation.persist({ closeoutCorrelationId: args.p_closeout_correlation_id });
    w.calls.close += 1;
    const att = [...w.attempts.values()].find((a) => a.closeoutCorrelationId === args.p_closeout_correlation_id);
    const wire = () => ({ closeout_correlation_id: att.closeoutCorrelationId, service_session_id: att.serviceSessionId, status: att.status });
    if (w.session.status === "closed") return { ok: true, body: { ok: true, code: "ALREADY_CLOSED", idempotent: true, session: w.session, attemptCompleted: true, attempt: wire() } };
    Object.assign(w.session, { status: "closed", closed_by: args.p_closed_by, close_source: args.p_source });
    att.status = "completed";
    return { ok: true, body: { ok: true, code: "V3_CLOSED", idempotent: false, session: w.session, attemptCompleted: true, attempt: wire(),
      closeout: rawCloseout(createdCloseout || w.closeouts.get(args.p_service_session_id)), reconciliation: { closeout_correlation_id: args.p_closeout_correlation_id } } };
  };
  const transition = createServiceLifecycleV3Transition({ rpc: w.dbRpc });
  const incidents = { async report(f) { w.incidentsReported.push(f); return { success: true, created: true, code: "RECORDED", incident: { id: "inc" + w.incidentsReported.length, ...f } }; }, async resolve() { return { success: true }; } };
  const reconciliation = { async persist({ closeoutCorrelationId }) { w.calls.persist += 1; return { success: true, created: true, reconciliation: { closeoutCorrelationId } }; },
    async buildRpcArgs({ serviceSessionId, closeoutCorrelationId }) { return { success: true, args: { p_service_session_id: serviceSessionId, p_closeout_correlation_id: closeoutCorrelationId } }; },
    async build() { return { ok: true, service: { unpaid: 0, overCollected: 0 } }; } };

  w.engine = createServiceLifecycleEngine({
    select: w.select, attempts, snapshots, closeoutCreation, closeouts, transition, incidents,
    releaseEmptyTable: async () => ({ ok: true }), reconciliation,
    // A guard that would throw if the engine EVER consulted a trip (the old injection point no longer exists; an
    // unknown option is ignored, which is exactly the property under test).
    activeRiderTrip: async () => { throw new Error("the close engine must never consult a rider trip"); },
  });
  const facade = createServiceCloseAuthority({ engine: w.engine });
  w.closeAuthority = async (args) => { w.calls.closeAuthority += 1; return facade(args); };
  w.recovery = (businessDate = TODAY) => createStaleServiceRecovery({
    sessionLifecycle: { async currentCloseout() { return w.session.status === "closed" ? { ok: true, code: "NO_SERVICE_SESSION", session: null } : { ok: true, code: "OK", session: w.session }; } },
    closeAuthority: w.closeAuthority,
    fetchIntakeContext: async () => ({ businessDate }),
    scan: (opts) => scanPreClose({ ...opts, select: w.select }),
    reconciliation,
  });
  return w;
}

// ── A. Finalizar is not blocked by a delivery that is still out ─────────────────
test("A · manual Finalizar with a delivery EN_ENTREGA + unpaid (the trip is out): the service CLOSES; the pending is recorded, nothing is lost", async () => {
  const w = makeWorld({ session: { id: TARGET, status: "open", business_date: TODAY, opened_at: "2026-09-19T08:00:00Z" }, orders: [UNPAID_DELIVERY()], events: [] });
  const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.code, "V3_CLOSED");
  assert.equal(w.session.status, "closed");
  assert.equal(w.calls.acquire, 1);
  assert.equal(w.calls.create, 1, "exactly one closeout");
  assert.equal(w.closeouts.get(TARGET).financial.unpaidExposureCents, 1550, "the unpaid amount is carried into the closeout: the historical pending");
  const types = w.incidentsReported.map((i) => i.incidentType).sort();
  assert.deepEqual(types, ["DELIVERY_ACTIVE_AT_CLOSE", "UNPAID_BALANCE_AT_CLOSE"], "delivery-not-confirmed and money-owed are two facts, both recorded");
  const unpaid = w.incidentsReported.find((i) => i.incidentType === "UNPAID_BALANCE_AT_CLOSE");
  assert.equal(unpaid.financialExposureCents, 1550);
  assert.equal(require("../src/serviceSessions/v3IncidentPolicy").policyFor("DELIVERY_ACTIVE_AT_CLOSE").blocking, false, "an unconfirmed delivery never blocks (policy)");
});

test("A2 · the engine never consults a trip: an injected trip predicate that throws is never called; the source holds no trip policy", async () => {
  const w = makeWorld();
  const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(r.success, true);
  for (const f of ["serviceLifecycleEngine.js", "serviceLifecycleV3Transition.js", "staleServiceRecovery.js", "serviceCloseAuthority.js"]) {
    const src = read("src", "serviceSessions", f).replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /activeRiderTrip|activeTrip|V3_CLOSE_ACTIVE_RIDER_TRIP|V3_CLOSE_RIDER_TRIP_UNVERIFIABLE|trip_projection|findActiveRiderTrip/, f);
  }
  assert.equal(fs.existsSync(path.join(ROOT, "src", "serviceSessions", "activeRiderTripBlocker.js")), false, "the module that made a trip an economic blocker is gone");
});

// ── B. the old gap state: RETIRADO + paid + a trip still ACTIVE ──────────────────
test("B · stale service RETIRADO + paid + unpaid 0 + no tables (the trip is still ACTIVE): AUTO_RECOVERY_PERFORMED -- a departed trip no longer keeps a finished service open", async () => {
  const w = makeWorld();
  const r = await w.recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.equal(r.recovered, true);
  assert.equal(w.session.status, "closed");
  assert.equal(w.closeouts.size, 1);
});

test("B2 · a stale service that is NOT safe for an economic reason still reports PREVIOUS_SERVICE_PENDING with the economic blockers -- and never a trip blocker", async () => {
  const w = makeWorld({ orders: [UNPAID_DELIVERY()], events: [] });
  const r = await w.recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.blockers.orders, 1);
  assert.ok(!("activeTrip" in r.blockers), "no trip blocker is ever invented");
  assert.equal(w.calls.closeAuthority, 0, "the existing predicate decides; the close authority is not called");
});

// ── C. the DB wrapper is a transport: an old DB's trip refusal never becomes a JS policy ──
test("C · the transition wrapper passes only the RPC's typed code (an old DB answering with a `trip` payload does not create a trip-shaped refusal)", async () => {
  const t = createServiceLifecycleV3Transition({ rpc: async () => ({ ok: true, body: { ok: false, code: "V3_CLOSE_ACTIVE_RIDER_TRIP", trip: { trip_id: "t" } } }) });
  const r = await t.close({ serviceSessionId: TARGET, closeoutCorrelationId: "c", actor: "owner", source: "operator_finalizar_v3" });
  assert.equal(r.success, false);
  assert.equal(r.code, "V3_CLOSE_ACTIVE_RIDER_TRIP");
  assert.ok(!("trip" in r), "no trip payload is forwarded");
});

// ── D. retry / idempotency ───────────────────────────────────────────────────
test("D · a retry after the close (with the trip still out) is an idempotent success: ONE attempt, ONE closeout", async () => {
  const w = makeWorld({ orders: [UNPAID_DELIVERY()], events: [] });
  const first = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(first.success, true);
  const again = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(again.success, true);
  assert.equal(again.idempotent, true);
  assert.equal(w.calls.create, 1, "no second closeout");
  assert.equal(w.calls.acquire, 1, "no second attempt");
});

// ── E. the pre-close scan reports delivery + money, never the driver ─────────────
// language-guard: allow-legacy scanServizio is the existing pre-close scan export name, cited in this test title, not new vocabulary
test("E · scanServizio: no trip anywhere (no blocking.trips, no trip row); a delivery EN_ENTREGA carries `entrega: SIN_CONFIRMAR` and its unpaid amount", async () => {
  const w = makeWorld({ session: { id: TARGET, status: "open", business_date: TODAY, opened_at: "2026-09-19T08:00:00Z" }, orders: [UNPAID_DELIVERY()], events: [] });
  const scan = await scanPreClose({ select: w.select, resolveCurrentService: async () => w.session });
  assert.deepEqual(Object.keys(scan.blocking).sort(), ["orders", "tables"], "the scan reports operational blockers only");
  assert.ok(!scan.attivi.some((a) => a.kind === "trip" || a.stato === "REPARTO_ACTIVO"));
  const row = scan.attivi.find((a) => a.kind === "order");
  assert.equal(row.entrega, "SIN_CONFIRMAR");
  assert.equal(row.unpaidAmount, 15.5);
  assert.equal(row.stato, "EN_ENTREGA");
});

test("E2 · the two facts are independent: a PAID delivery still out is 'entrega sin confirmar' with NO amount; an unpaid PICKUP has an amount and NO delivery fact", async () => {
  const paid = UNPAID_DELIVERY({ id: "#017", orden_id: "#017", order_uid: "uid-017", cobrado: true, ya_pagado: true, metodo_pago: "tarjeta" });
  // language-guard: allow-legacy tipo_consegna / RITIRO are the existing ordenes column name and enum value, reproduced verbatim in this fixture
  const pickup = ORDER({ id: "#018", orden_id: "#018", order_uid: "uid-018", estado: "LISTO", tipo_consegna: "RITIRO", cobrado: false, ya_pagado: false, metodo_pago: "", totale: 9 });
  const w = makeWorld({ session: { id: TARGET, status: "open", business_date: TODAY, opened_at: "2026-09-19T08:00:00Z" },
    orders: [paid, pickup], events: [PAYMENT({ order_id: "#017", amount: 15.5, payment_method: "tarjeta" })] });
  const scan = await scanPreClose({ select: w.select, resolveCurrentService: async () => w.session });
  const a = scan.attivi.find((r) => r.nombre === "#017");
  const b = scan.attivi.find((r) => r.nombre === "#018");
  assert.equal(a.entrega, "SIN_CONFIRMAR");
  assert.ok(!("unpaidAmount" in a), "a paid order shows no pending amount");
  assert.ok(!("entrega" in b), "a pickup has no delivery fact");
  assert.equal(b.unpaidAmount, 9);
});

test("E3 · best effort: if the ledger cannot be read the scan still succeeds and simply shows no amount (never an invented one)", async () => {
  const w = makeWorld({ session: { id: TARGET, status: "open", business_date: TODAY, opened_at: "2026-09-19T08:00:00Z" }, orders: [UNPAID_DELIVERY()], events: [] });
  const select = async (table, q) => { if (table === "order_financial_events") throw new Error("ledger read failed"); return w.select(table, q); };
  const scan = await scanPreClose({ select, resolveCurrentService: async () => w.session });
  const row = scan.attivi.find((a) => a.kind === "order");
  assert.equal(scan.ok, true);
  assert.equal(row.entrega, "SIN_CONFIRMAR");
  assert.ok(!("unpaidAmount" in row));
});

// ── F. read scope = operational ∪ residual ──────────────────────────────────
// A tiny in-memory model of the two RPCs the reader calls: trip_residual_scope_v1 (service ids of the ACTIVE trips) and
// trip_projection_v1 (the ACTIVE trip whose service is IN the scope; an empty scope is SCOPE_UNAVAILABLE).
function makeTripRpc({ trips = [], residualFails = false, residualMode = null, projectionFails = false } = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "trip_residual_scope_v1") {
      if (residualFails) throw new Error("boom");
      if (residualMode === "http_error") return { ok: false, httpStatus: 500, body: null };
      if (residualMode === "not_installed") return { ok: false, httpStatus: 404, body: { code: "PGRST202", message: "Could not find the function public.trip_residual_scope_v1" } };
      if (residualMode === "body_not_ok") return { ok: true, body: { ok: false } };
      if (residualMode === "no_body") return { ok: true, body: null };
      if (residualMode === "ids_not_array") return { ok: true, body: { ok: true, service_session_ids: "nope" } };
      if (residualMode === "bad_id") return { ok: true, body: { ok: true, service_session_ids: [TARGET, null] } };
      return { ok: true, body: { ok: true, service_session_ids: [...new Set(trips.filter((t) => t.status === "ACTIVE").map((t) => t.service_session_id))] } };
    }
    if (name === "trip_projection_v1") {
      if (projectionFails) return { ok: false, body: null };
      const ids = args.p_operational_session_ids;
      if (!Array.isArray(ids) || ids.length === 0) return { ok: true, body: { ok: false, code: "SCOPE_UNAVAILABLE" } };
      const t = trips.find((x) => x.status === "ACTIVE" && ids.includes(x.service_session_id));
      return { ok: true, body: t ? { ok: true, active: true, trip_id: t.trip_id, anchor_order_uid: t.members[0].order_uid, giro_id: null, departed_at: "2026-09-19T21:00:00Z", members: t.members } : { ok: true, active: false } };
    }
    throw new Error("unexpected rpc " + name);
  };
  return { rpc, calls };
}
const TRIP = (o = {}) => ({ trip_id: "trip-1", service_session_id: TARGET, status: "ACTIVE", members: [{ order_uid: "uid-016", stop_seq: 1 }], ...o });

test("F1 · NO service open at all + a departed trip of a CLOSED service: the reader is no longer fail-closed for it -- the trip is visible", async () => {
  const { rpc, calls } = makeTripRpc({ trips: [TRIP()] });
  const body = await readTripProjection({ getOperationalSessionIds: async () => [], rpc });
  assert.equal(body.ok, true);
  assert.equal(body.active, true);
  assert.deepEqual(calls.find((c) => c.name === "trip_projection_v1").args.p_operational_session_ids, [TARGET]);
  const facts = activeTripFacts({ projection: body });
  assert.equal(facts.available, true);
  assert.equal(facts.active, true);
  assert.deepEqual(facts.trip.frozen_member_order_uids, ["uid-016"]);
});

test("F2 · another service is open: the scope is the UNION (deduplicated); the residual adds only the departed trip's own service", async () => {
  const { rpc, calls } = makeTripRpc({ trips: [TRIP()] });
  const body = await readTripProjection({ getOperationalSessionIds: async () => ["svc-open"], rpc });
  assert.equal(body.active, true);
  assert.deepEqual(calls.find((c) => c.name === "trip_projection_v1").args.p_operational_session_ids.sort(), ["svc-open", TARGET].sort());
  const same = makeTripRpc({ trips: [TRIP({ service_session_id: "svc-open" })] });
  await readTripProjection({ getOperationalSessionIds: async () => ["svc-open"], rpc: same.rpc });
  assert.deepEqual(same.calls.find((c) => c.name === "trip_projection_v1").args.p_operational_session_ids, ["svc-open"], "no duplicate id");
});

test("F3 · fail-closed semantics are unchanged when there is NO trip: no operational scope and no residual = null (never a silent 'no trip')", async () => {
  const { rpc, calls } = makeTripRpc({ trips: [] });
  assert.equal(await readTripProjection({ getOperationalSessionIds: async () => [], rpc }), null);
  assert.ok(!calls.some((c) => c.name === "trip_projection_v1"), "an empty scope is never sent to the projection");
  const none = await readTripProjection({ getOperationalSessionIds: async () => ["svc-open"], rpc: makeTripRpc({ trips: [] }).rpc });
  assert.deepEqual(none, { ok: true, active: false });
});

test("F4 · FAIL-CLOSED: an UNREADABLE residual is never 'no departed trip' -- null (unavailable), with or without an operational scope", async () => {
  // every way the residual can be unreadable, against BOTH an empty and a non-empty operational scope
  const modes = [
    ["transport throw", { residualFails: true }],
    ["HTTP/RPC failure", { residualMode: "http_error" }],
    ["function not installed (DB migration 139 not applied yet)", { residualMode: "not_installed" }],
    ["body says ok:false", { residualMode: "body_not_ok" }],
    ["no body", { residualMode: "no_body" }],
    ["ids is not an array", { residualMode: "ids_not_array" }],
    ["an id that is not a non-empty string", { residualMode: "bad_id" }],
  ];
  for (const [label, opts] of modes) {
    for (const operational of [[], ["svc-open"]]) {
      const w = makeTripRpc({ trips: [TRIP()], ...opts });
      const body = await readTripProjection({ getOperationalSessionIds: async () => operational, rpc: w.rpc });
      assert.equal(body, null, `${label} / operational=${JSON.stringify(operational)}: must be null (unavailable), never { ok:true, active:false }`);
      assert.ok(!w.calls.some((c) => c.name === "trip_projection_v1"), `${label}: the projection is not even asked with a scope we cannot trust`);
    }
  }
  // the reader itself reports WHY, and never throws
  const r = await readResidualServiceScope({ rpc: async () => { throw new Error("x"); } });
  assert.deepEqual(r, { ok: false, ids: [], reason: RESIDUAL_REASON.UNREADABLE });
  assert.deepEqual(await readResidualServiceScope({ rpc: async () => ({ ok: false, body: null }) }), { ok: false, ids: [], reason: RESIDUAL_REASON.UNREADABLE });
  assert.deepEqual(await readResidualServiceScope({ rpc: async () => ({ ok: true, body: { ok: true, service_session_ids: "nope" } }) }), { ok: false, ids: [], reason: RESIDUAL_REASON.MALFORMED });
  assert.deepEqual(await readResidualServiceScope({ rpc: async () => ({ ok: true, body: { ok: true, service_session_ids: [] } }) }), { ok: true, ids: [], reason: null }, "an EMPTY readable residual is the only 'none'");
  // an injected residual reader that throws is unreadable too
  assert.equal(await readTripProjection({ getOperationalSessionIds: async () => ["svc-open"], rpc: makeTripRpc({ trips: [] }).rpc, residualScope: async () => { throw new Error("x"); } }), null);
  // the other failure paths stay fail-closed exactly as before
  assert.equal(await readTripProjection({ getOperationalSessionIds: async () => { throw new Error("x"); }, rpc: makeTripRpc({ trips: [TRIP()] }).rpc }), null);
  assert.equal(await readTripProjection({ getOperationalSessionIds: async () => ["svc-open"], rpc: makeTripRpc({ trips: [TRIP()], projectionFails: true }).rpc }), null);
});

test("F5 · an unreadable residual reaches every consumer as UNAVAILABLE, never as 'rider free' (rider / Planner / trip state)", async () => {
  const w = makeTripRpc({ trips: [TRIP()], residualMode: "http_error" });
  const projection = await readTripProjection({ getOperationalSessionIds: async () => ["svc-open"], rpc: w.rpc });
  const facts = activeTripFacts({ projection });
  assert.equal(facts.available, false, "the shared read model says unavailable");
  assert.equal(facts.active, false);
  assert.notEqual(facts.reason, null);
  const { getTripOperationalState } = require("../src/core/delivery/tripOperationalState");
  const dto = await getTripOperationalState({
    readProjection: () => readTripProjection({ getOperationalSessionIds: async () => ["svc-open"], rpc: w.rpc }),
    readGiro: async () => ({ scope_valid: true, degraded: false, giros: [], orders: [] }),
  });
  assert.equal(dto.available, false);
  assert.equal(dto.has_active_trip, null, "unknown (null), never false -- false would tell the operator the rider is free");
});

// ── G. the operator's board keeps ONLY the departed trip's orders ───────────────
test("G1 · common path: the departed trip's service is already operational (or there is none): ONE light RPC, no projection, no query", async () => {
  let selects = 0;
  const { rpc, calls } = makeTripRpc({ trips: [TRIP({ service_session_id: "svc-open" })] });
  const rows = await readDepartedTripResidueOrders({
    select: async () => { selects += 1; return []; }, operationalSessionIds: ["svc-open"],
    residualScope: () => readResidualServiceScope({ rpc }),
    readProjection: async () => { throw new Error("must not be read"); },
  });
  assert.deepEqual(rows, []);
  assert.equal(selects, 0);
  assert.equal(calls.length, 1);
  const none = await readDepartedTripResidueOrders({ select: async () => { throw new Error("no"); }, operationalSessionIds: [], residualScope: async () => ({ ok: true, ids: [] }), readProjection: async () => { throw new Error("no"); } });
  assert.deepEqual(none, []);
});

test("G2 · residue: the closed service's departed trip is returned by ITS MEMBERS only -- never a service-wide query", async () => {
  const queries = [];
  const { rpc } = makeTripRpc({ trips: [TRIP({ members: [{ order_uid: "uid-016", stop_seq: 1 }, { order_uid: "uid-017", stop_seq: 2 }] })] });
  const rows = await readDepartedTripResidueOrders({
    select: async (table, q) => { queries.push({ table, q }); return [UNPAID_DELIVERY()]; },
    operationalSessionIds: [],
    residualScope: () => readResidualServiceScope({ rpc }),
    readProjection: (deps) => readTripProjection({ ...deps, rpc }),
  });
  assert.equal(rows.length, 1);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, "ordenes");
  assert.match(queries[0].q, /^order_uid=in\.\(uid-016,uid-017\)&estado=in\.\(POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA\)/);
  assert.doesNotMatch(queries[0].q, /service_session_id/, "the board is NEVER widened to the closed service as a whole");
});

test("G3 · an inactive/unreadable projection yields no residue; the merge is by display id and never duplicates a row", async () => {
  const off = await readDepartedTripResidueOrders({ select: async () => { throw new Error("no"); }, operationalSessionIds: [], residualScope: async () => ({ ok: true, ids: [TARGET] }), readProjection: async () => ({ ok: true, active: false }) });
  assert.deepEqual(off, []);
  assert.deepEqual(await readDepartedTripResidueOrders({ select: async () => { throw new Error("no"); }, operationalSessionIds: [], residualScope: async () => ({ ok: true, ids: [TARGET] }), readProjection: async () => null }), []);
  const merged = mergeOrdersById([{ id: "#1" }, { id: "#2" }], [{ id: "#2" }, { id: "#3" }, null]);
  assert.deepEqual(merged.map((o) => o.id), ["#1", "#2", "#3"]);
  assert.deepEqual(mergeOrdersById(undefined, [{ id: "#9" }]).map((o) => o.id), ["#9"]);
});

test("G5 · an UNREADABLE residual is reported (the board caller logs it), never silently answered as 'no residue'", async () => {
  await assert.rejects(
    readDepartedTripResidueOrders({ select: async () => { throw new Error("no"); }, operationalSessionIds: [], residualScope: async () => ({ ok: false, ids: [], reason: RESIDUAL_REASON.UNREADABLE }), readProjection: async () => { throw new Error("no"); } }),
    /RESIDUAL_SCOPE_UNAVAILABLE/,
  );
});

test("B3 · a trip whose stops are ALL delivered is still ACTIVE on the wire (has_active_trip:true, 0 remaining): delivery is not the driver's return", async () => {
  const { getTripOperationalState } = require("../src/core/delivery/tripOperationalState");
  const projection = { ok: true, active: true, trip_id: "trip-1", giro_id: null, anchor_order_uid: "uid-016", departed_at: "2026-09-19T21:00:00Z",
    members: [{ order_uid: "uid-016", stop_seq: 1 }, { order_uid: "uid-017", stop_seq: 2 }] };
  const rows = [{ order_uid: "uid-016", id: "#016", estado: "RETIRADO" }, { order_uid: "uid-017", id: "#017", estado: "RETIRADO" }];
  const dto = await getTripOperationalState({
    readProjection: async () => projection,
    readGiro: async () => ({ scope_valid: true, degraded: false, giros: [], orders: [] }),
    select: async () => rows,
    now: () => "2026-09-19T21:30:00Z",
  });
  assert.equal(dto.available, true);
  assert.equal(dto.has_active_trip, true, "the trip is closed ONLY by close_rider_trip, never by the last delivery");
  assert.equal(dto.stops_total, 2);
  assert.equal(dto.stops_completed, 2);
  assert.equal(dto.stops_remaining, 0);
});

test("G4 · index.js: the residue is best-effort on the operator board (never fails the read) and is merged BEFORE the financial projection", () => {
  const idx = read("index.js");
  const i = idx.indexOf("readDepartedTripResidueOrders({ select: sbSelect, operationalSessionIds: sessionIds })");
  assert.ok(i > 0);
  const around = idx.slice(i - 300, i + 700);
  assert.match(around, /try \{[\s\S]*mergeOrdersById\(ordenesRows, residueRows\)[\s\S]*\} catch \(e\)/);
  assert.match(idx, /result = await attachOrderFinancial\(boardRows, \{ select: sbSelect \}\);/);
});

// ── H. the operator's delivery confirmation ─────────────────────────────────
const CTX = { byActor: "operator_primary", sessionVersion: 3, sid: "sid-abc" };
const PAY = (o = {}) => ({ method: "efectivo", clientRequestId: "req_0123456789", ...o });

test("H1 · identity and request shape fail closed BEFORE any database call", async () => {
  let called = 0;
  const rpc = async () => { called += 1; return { ok: true, body: { ok: true, code: "OK" } }; };
  const bad = [
    [operatorDelivery.confirmDelivery("#1", {}, null, { rpc }), 401, "OPERATOR_DELIVERY_CONTEXT_UNAVAILABLE"],
    [operatorDelivery.confirmDelivery("#1", { byActor: "op", sessionVersion: 0 }, null, { rpc }), 401, "OPERATOR_DELIVERY_CONTEXT_UNAVAILABLE"],
    [operatorDelivery.confirmDelivery("  ", CTX, null, { rpc }), 400, "BAD_REQUEST"],
    [operatorDelivery.confirmDelivery("#1", CTX, "efectivo", { rpc }), 400, "INVALID_INPUT"],
    [operatorDelivery.confirmDelivery("#1", CTX, PAY({ method: "paypal" }), { rpc }), 400, "AUTH_METHOD_INVALID"],
    [operatorDelivery.confirmDelivery("#1", CTX, PAY({ mode: "equal_split" }), { rpc }), 400, "INVALID_INPUT"],
    [operatorDelivery.confirmDelivery("#1", CTX, PAY({ mode: "custom_amount" }), { rpc }), 400, "INVALID_INPUT"],
    [operatorDelivery.confirmDelivery("#1", CTX, PAY({ mode: "custom_amount", amount: "-3" }), { rpc }), 400, "INVALID_INPUT"],
    [operatorDelivery.confirmDelivery("#1", CTX, PAY({ clientRequestId: "short" }), { rpc }), 400, "CASH_CLIENT_REQUEST_ID_INVALID"],
    [operatorDelivery.confirmDelivery("#1", CTX, PAY({ confirmDuplicate: "yes" }), { rpc }), 400, "INVALID_INPUT"],
    [operatorDelivery.confirmDelivery("#1", { ...CTX, sid: null }, PAY(), { rpc }), 401, "CASH_RELOGIN_REQUIRED"],
  ];
  for (const [p, status, error] of bad) {
    const r = await p;
    assert.equal(r.status, status, error);
    assert.equal(r.payload.error, error);
  }
  assert.equal(called, 0, "no RPC was reached by any malformed request");
});

test("H2 · delivery only: p_payment is null; the RPC receives exactly the verified identity", async () => {
  let args;
  const r = await operatorDelivery.confirmDelivery(" #016 ", CTX, undefined, { rpc: async (name, a) => { assert.equal(name, "operator_confirm_delivery_v1"); args = a; return { ok: true, body: { ok: true, code: "OK", order_id: "#016", payment: null, payment_note: null } }; } });
  assert.equal(r.status, 200);
  assert.deepEqual(args, { p_order_id: "#016", p_by_actor: "operator_primary", p_session_version: 3, p_payment: null });
});

test("H3 · with payment: the client sends NO amount in `full` mode; the hashes are server-built and deterministic; nothing else leaks in", async () => {
  const seen = [];
  const rpc = async (name, a) => { seen.push(a); return { ok: true, body: { ok: true, code: "OK", payment: { ok: true } } }; };
  const hashSid = (sid) => (sid === "sid-abc" ? "a".repeat(64) : null);
  await operatorDelivery.confirmDelivery("#016", CTX, PAY({ amount: "999", extra: "x", by_sid_hash: "forged" }), { rpc, hashSid });
  await operatorDelivery.confirmDelivery("#016", CTX, PAY({ amount: "1" }), { rpc, hashSid });
  const [a, b] = seen.map((x) => x.p_payment);
  assert.deepEqual(Object.keys(a).sort(), ["by_sid_hash", "client_request_id", "confirm_duplicate", "method", "mode", "request_hash"], "exactly the writer's proofs");
  assert.ok(!("amount" in a), "an amount smuggled into a `full` payment is dropped: SQL derives it from the canonical obligation");
  assert.equal(a.by_sid_hash, "a".repeat(64), "the session-id hash is derived from the VERIFIED sid, never taken from the body");
  assert.match(a.request_hash, /^[0-9a-f]{64}$/);
  assert.equal(a.request_hash, b.request_hash, "same semantic request => same hash (an honest retry is a replay)");
  const partial = [];
  await operatorDelivery.confirmDelivery("#016", CTX, PAY({ mode: "custom_amount", amount: "8" }), { rpc: async (n, x) => { partial.push(x.p_payment); return { ok: true, body: { ok: true, code: "OK" } }; }, hashSid });
  assert.equal(partial[0].amount, "8.00");
  assert.notEqual(partial[0].request_hash, a.request_hash, "a different semantic request => a different hash");
});

test("H4 · every RPC outcome maps to a typed status; a payment refusal is a 409 (never a 500); the lost race is a 409; a transport failure is the only 500", () => {
  const m = (body) => operatorDelivery.mapResult({ ok: true, body });
  assert.equal(m({ ok: true, code: "OK" }).status, 200);
  assert.equal(m({ ok: true, code: "IDEMPOTENT", payment_note: "ORDER_PAYMENT_ALREADY_SETTLED" }).status, 200);
  assert.deepEqual(m({ ok: false, code: "NOT_FOUND" }), { status: 404, payload: { error: "NOT_FOUND" } });
  assert.equal(m({ ok: false, code: "INVALID_STATE", estado: "LISTO" }).status, 409);
  assert.equal(m({ ok: false, code: "ORDER_NOT_ELIGIBLE", reason: "NOT_DOMICILIO" }).status, 400);
  assert.equal(m({ ok: false, code: "AUTH_FORBIDDEN_ROLE" }).status, 403);
  assert.equal(m({ ok: false, code: "AUTH_SESSION_STALE" }).status, 401);
  assert.deepEqual(m({ ok: false, code: "PAYMENT_REFUSED", payment_code: "ORDER_PAYMENT_NO_OPEN_SERVICE" }), { status: 409, payload: { error: "PAYMENT_REFUSED", payment_code: "ORDER_PAYMENT_NO_OPEN_SERVICE" } });
  assert.equal(m({ ok: false, code: "PAYMENT_REFUSED", payment_code: "ORDER_PAYMENT_POSSIBLE_DUPLICATE" }).status, 409);
  assert.equal(m({ ok: false, code: "PAYMENT_REFUSED", payment_code: "ORDER_PAYMENT_AMOUNT_INVALID" }).status, 400);
  assert.equal(m({ ok: false, code: "SOMETHING_NEW" }).status, 500, "an unknown code is a server-side surprise, never a silent success");
  assert.deepEqual(operatorDelivery.mapResult({ ok: false, httpStatus: 409, body: { code: "40001", message: "OPERATOR_DELIVERY_LOST_RACE" } }), { status: 409, payload: { error: "DELIVERY_LOST_RACE" } });
  assert.deepEqual(operatorDelivery.mapResult({ ok: false, body: null }), { status: 500, payload: { error: "internal_error" } });
  assert.deepEqual(operatorDelivery.mapResult(null), { status: 500, payload: { error: "internal_error" } });
});

test("H5 · registries: admin + operator ONLY (never rider, never a trip primitive); the rider keeps its own rider-exclusive action; both RPCs are H1B-registered", () => {
  assert.equal(legacyActionRoles.isKnownAction("confirmarEntregaOperador"), true);
  for (const role of ["admin", "operator"]) assert.equal(legacyActionRoles.isAllowed(role, "confirmarEntregaOperador"), true, role);
  assert.equal(legacyActionRoles.isAllowed("rider", "confirmarEntregaOperador"), false);
  const rule = legacyActionRoles.getActionRule("confirmarEntregaOperador");
  assert.equal(rule.tripPrimitive, false, "not routed through the rider trip primitives");
  assert.equal(rule.rider, false);
  assert.equal(legacyActionRoles.isAllowed("rider", "marcarEntregado"), true, "the rider's own delivery action is untouched");
  for (const r of ["rpc/operator_confirm_delivery_v1", "rpc/trip_residual_scope_v1"]) {
    const p = getResourcePolicy(r);
    assert.ok(p, r + " is registered");
    assert.deepEqual([...p.allowedMethods], ["POST"]);
  }
});

test("H6 · index.js: the identity comes ONLY from the verified authCtx (fail closed when absent); the rider routing is not widened", () => {
  const idx = read("index.js");
  const i = idx.indexOf('} else if (action === "confirmarEntregaOperador") {');
  assert.ok(i > 0);
  const block = idx.slice(i, idx.indexOf("} else if (req.authCtx && req.authCtx.rule && req.authCtx.rule.tripPrimitive) {", i));
  assert.match(block, /const ctx = req\.authCtx;/);
  assert.match(block, /return res\.status\(401\)\.json\(\{ error: "OPERATOR_DELIVERY_CONTEXT_UNAVAILABLE" \}\)/);
  assert.match(block, /\{ byActor: ctx\.actor, sessionVersion: ctx\.sv, sid: ctx\.sid \}/);
  assert.doesNotMatch(block, /req\.body\.(actor|role|sv|sid|__authCtx)/, "no identity is ever read from the body");
  const rider = idx.slice(idx.indexOf("async function routeRiderTripAction"), idx.indexOf("const WA_VERIFY_TOKEN"));
  assert.doesNotMatch(rider, /confirmarEntregaOperador|operatorDelivery/, "the rider path is not the operator path");
  assert.ok(!/operator_confirm_delivery_v1|order_post_payment_v1/.test(read("src", "agents", "riderTrip.js")), "the rider module knows nothing of the operator confirmation");
});
