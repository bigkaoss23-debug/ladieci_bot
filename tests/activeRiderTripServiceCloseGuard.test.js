"use strict";
// ===============================================================
// ACTIVE RIDER TRIP / SERVICE CLOSE GUARD — regression contract.
//
// The state under test (observed on staging, service 4e2dd521…):
//   service = stale/open, order = RETIRADO + paid, unpaid = 0, overCollected = 0,
//   no open tables, blocking.orders = 0 — BUT the rider trip of that service is
//   still ACTIVE (rider_collect_and_complete_stop and close_rider_trip are two
//   separate calls; the second one can fail).
//
// Every scenario below runs the REAL close engine, the REAL close-authority
// facade, the REAL stale-recovery module, the REAL pre-close scan and the REAL
// activeRiderTripBlocker. Only I/O is faked (database reads/writes and the
// trip projection). The trip projection fake mirrors public.trip_projection_v1
// exactly: it returns the ACTIVE trip whose service_session_id is IN the
// requested scope — nothing else — so attribution to the target service is a
// property of the data, not of the test.
//
// No database, no network, no business write.
// ===============================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createServiceLifecycleEngine } = require("../src/serviceSessions/serviceLifecycleEngine");
const { createServiceCloseAuthority } = require("../src/serviceSessions/serviceCloseAuthority");
const { createStaleServiceRecovery, RECOVERY_CODE } = require("../src/serviceSessions/staleServiceRecovery");
const { findActiveRiderTripForService, closeRefusalFromCheck, summarizeActiveTrip, ACTIVE_RIDER_TRIP_CODE } = require("../src/serviceSessions/activeRiderTripBlocker");
const { createServiceLifecycleV3Transition } = require("../src/serviceSessions/serviceLifecycleV3Transition");
const { mapResult, CODE_TO_HTTP } = require("../src/agents/riderTrip");
// language-guard: allow-legacy scanServizio is the module's existing export name under test, aliased so the rest of this file uses Spanish, not new vocabulary
const scanPreClose = require("../src/utils/servizio").scanServizio;

const TARGET = "svc-target";
const OTHER = "svc-other";
const TODAY = "2026-09-19";
const STALE_DAY = "2026-09-18";

const ORDER_PAID = (o = {}) => ({
  id: "#016", orden_id: "#016", order_uid: "uid-016", service_session_id: TARGET, estado: "RETIRADO",
  totale: 15.5, hora: "21:11", cobrado: true, ya_pagado: true, metodo_pago: "efectivo",
  // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, reproduced verbatim in this fixture, not new vocabulary
  tipo_consegna: "DOMICILIO", ...o,
});
const PAYMENT = (o = {}) => ({
  order_id: "#016", service_session_id: TARGET, type: "payment", amount: 15.5,
  payment_method: "efectivo", created_at: "2026-09-19T09:43:52Z", ...o,
});
const tripRow = (o = {}) => ({
  trip_id: "trip-1", service_session_id: TARGET, status: "ACTIVE", rider_actor: null,
  anchor_order_uid: "uid-016", giro_id: null, departed_at: "2026-09-18T18:59:35Z", members: [{ order_uid: "uid-016", stop_seq: 1 }], ...o,
});

// ── the world: DB rows + trips + call recorders ────────────────────────────
function makeWorld({
  session = { id: TARGET, status: "open", business_date: STALE_DAY, opened_at: "2026-09-18T18:38:48Z", service_kind: null },
  orders = [ORDER_PAID()],
  tables = [],
  events = [PAYMENT()],
  trips = [],
  projectionUnreadable = false,
  // Migration 138 — the JS preflight is not the authority. `preflightBlind` models a preflight that read
  // "no trip" and then LOST THE RACE (a trip started afterwards) or was bypassed altogether; `dbAuthority`
  // swaps the fake terminal transition for the REAL transition adapter over a fake close_service_session_v3
  // RPC that behaves like the migration-138 body (refuses V3_CLOSE_ACTIVE_RIDER_TRIP while a trip is ACTIVE).
  preflightBlind = false,
  dbAuthority = false,
} = {}) {
  const w = {
    session: { ...session },
    orders, tables, events, trips,
    attempts: new Map(), closeouts: new Map(),
    calls: { acquire: 0, capture: 0, create: 0, persist: 0, close: 0, complete: 0, tripReads: [], closeAuthority: 0 },
    projectionUnreadable,
  };

  // public.trip_projection_v1 semantics: ACTIVE trip whose service_session_id IN scope.
  w.readProjection = async ({ getOperationalSessionIds }) => {
    const ids = await getOperationalSessionIds({});
    w.calls.tripReads.push(ids);
    if (w.projectionUnreadable) return null;
    const t = w.trips.find((x) => x.status === "ACTIVE" && ids.includes(x.service_session_id));
    if (!t) return { ok: true, active: false };
    const { rider_actor, ...projected } = t; // the projection never exposes rider_actor
    return { ok: true, active: true, ...projected };
  };
  w.activeRiderTrip = ({ serviceSessionId }) => findActiveRiderTripForService({ serviceSessionId, readProjection: w.readProjection });
  if (preflightBlind) w.activeRiderTrip = async () => { w.calls.blindReads = (w.calls.blindReads || 0) + 1; return { ok: true, active: false }; };

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
  const fakeTransition = {
    async close({ serviceSessionId, actor, source }) {
      w.calls.close += 1;
      if (w.session.status === "closed") return { success: true, idempotent: true, code: "ALREADY_CLOSED", session: w.session };
      Object.assign(w.session, { status: "closed", closed_by: actor, close_source: source });
      return { success: true, idempotent: false, code: "V3_CLOSED", session: w.session };
    },
  };
  // close_service_session_v3 as migration 138 defines it, at the wire level: idempotent when already closed,
  // otherwise refused while a trip is ACTIVE for the service (carrying the projection's own fields under `trip`).
  w.dbRpc = async (name, args) => {
    assert.equal(name, "close_service_session_v3");
    w.calls.close += 1;
    if (w.session.status === "closed") return { ok: true, body: { ok: true, code: "ALREADY_CLOSED", idempotent: true, session: w.session } };
    const t = w.trips.find((x) => x.status === "ACTIVE" && x.service_session_id === args.p_service_session_id);
    if (t) {
      return { ok: true, body: { ok: false, code: "V3_CLOSE_ACTIVE_RIDER_TRIP", service_session_id: args.p_service_session_id,
        trip: { trip_id: t.trip_id, anchor_order_uid: t.anchor_order_uid, giro_id: t.giro_id, departed_at: t.departed_at, members: t.members } } };
    }
    Object.assign(w.session, { status: "closed", closed_by: args.p_closed_by, close_source: args.p_source });
    return { ok: true, body: { ok: true, code: "V3_CLOSED", idempotent: false, session: w.session } };
  };
  const transition = dbAuthority ? createServiceLifecycleV3Transition({ rpc: w.dbRpc }) : fakeTransition;
  const incidents = { async report(f) { return { success: true, created: true, code: "RECORDED", incident: { id: "inc", ...f } }; }, async resolve() { return { success: true }; } };
  const reconciliation = { async persist({ closeoutCorrelationId }) { w.calls.persist += 1; return { success: true, created: true, reconciliation: { closeoutCorrelationId } }; },
    async build() { return { ok: true, service: { unpaid: 0, overCollected: 0 } }; } };

  w.engine = createServiceLifecycleEngine({
    activeRiderTrip: w.activeRiderTrip, select: w.select, attempts, snapshots, closeoutCreation, closeouts,
    transition, incidents, releaseEmptyTable: async () => ({ ok: true }), reconciliation,
  });
  // The REAL facade, wrapping the real engine — the same shape index.js and the stale module import.
  const facade = createServiceCloseAuthority({ engine: w.engine });
  w.closeAuthority = async (args) => { w.calls.closeAuthority += 1; return facade(args); };

  w.recovery = (businessDate = TODAY) => createStaleServiceRecovery({
    sessionLifecycle: { async currentCloseout() { return w.session.status === "closed" ? { ok: true, code: "NO_SERVICE_SESSION", session: null } : { ok: true, code: "OK", session: w.session }; } },
    closeAuthority: w.closeAuthority,
    fetchIntakeContext: async () => ({ businessDate }),
    // The REAL pre-close scan (with its own seams), exactly as index.js feeds the recovery module.
    scan: (opts) => scanPreClose({ ...opts, select: w.select, activeRiderTrip: w.activeRiderTrip }),
    reconciliation,
  });
  w.nothingDurableWritten = () => w.calls.acquire === 0 && w.calls.capture === 0 && w.calls.create === 0 && w.calls.persist === 0 && w.calls.close === 0;
  return w;
}

// ── A. stale + EN_ENTREGA: already blocked by blocking.orders — UNCHANGED ──
test("A · stale + EN_ENTREGA (+ its live trip): blocked by blocking.orders exactly as before; the close authority is never even called", async () => {
  const w = makeWorld({ orders: [ORDER_PAID({ estado: "EN_ENTREGA", cobrado: false, ya_pagado: false })], events: [], trips: [tripRow()] });
  const r = await w.recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.blockers.orders, 1, "the order-based blocker still decides this case");
  assert.equal(r.blockers.activeTrip, undefined, "no trip blocker is needed — and none is invented — on this path");
  assert.equal(w.calls.closeAuthority, 0);
  assert.ok(w.nothingDurableWritten());
});

// ── B. THE GAP: stale + RETIRADO paid + trip ACTIVE ──────────────────────────
test("B · stale + RETIRADO paid + unpaid 0 + no tables + trip ACTIVE: PREVIOUS_SERVICE_PENDING with an explicit trip blocker, NEVER AUTO_RECOVERY_PERFORMED", async () => {
  const w = makeWorld({ trips: [tripRow()] });
  const r = await w.recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.notEqual(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.notEqual(r.recovered, true);
  // The predicate facts are all green — the trip is the ONLY reason, and it is visible:
  assert.equal(r.blockers.orders, 0);
  assert.equal(r.blockers.tables, 0);
  assert.equal(r.blockers.unpaid, 0);
  assert.equal(r.blockers.overCollected, 0);
  assert.equal(r.blockers.autoCloseError, ACTIVE_RIDER_TRIP_CODE.ACTIVE_RIDER_TRIP);
  assert.equal(r.blockers.activeTrip.tripId, "trip-1");
  assert.equal(r.staleServiceSessionId, TARGET);
  // …and the refusal wrote NOTHING durable: the service is exactly as it was.
  assert.ok(w.nothingDurableWritten());
  assert.equal(w.session.status, "open");
  assert.equal(w.closeouts.size, 0);
});

// ── C. manual Finalizar: same state, same canonical authority ────────────────
test("C · manual Finalizar (operator_finalizar_v3) + RETIRADO paid + trip ACTIVE: the SAME authority refuses with a typed, machine-readable code; nothing is written", async () => {
  const w = makeWorld({ trips: [tripRow()] });
  const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(r.success, false);
  assert.equal(r.code, "V3_CLOSE_ACTIVE_RIDER_TRIP");
  assert.equal(r.activeTrip.tripId, "trip-1");
  assert.equal(r.activeTrip.memberCount, 1);
  assert.ok(w.nothingDurableWritten());
  assert.equal(w.session.status, "open");
  // index.js forwards the refusal untouched to the FE ({ success:false, error: code, ...v3Result }).
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(idx, /error: v3Result\.code \|\| "V3_CLOSE_FAILED", \.\.\.v3Result/);
});

test("C2 · the stale path and the manual path reach the SAME single enforcement point (no second implementation)", async () => {
  const w = makeWorld({ trips: [tripRow()] });
  await w.recovery().recoverStaleService({ actor: "owner" });                                   // stale
  await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" }); // manual
  // Both resolved the trip through the one blocker, each scoped to exactly [target].
  assert.ok(w.calls.tripReads.length >= 2);
  for (const ids of w.calls.tripReads) assert.deepEqual(ids, [TARGET]);
  // Static pins: the enforcement lives in the engine; the facade and the stale module hold no trip policy.
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "serviceSessions", f), "utf8").replace(/\/\/.*$/gm, "");
  assert.match(read("serviceLifecycleEngine.js"), /refuseWhileRiderTripActive/);
  assert.doesNotMatch(read("serviceCloseAuthority.js"), /trip/i, "the facade stays boring: no policy");
  assert.doesNotMatch(read("staleServiceRecovery.js"), /activeRiderTripBlocker|trip_projection|findActiveRiderTrip/, "stale recovery must not re-implement the predicate");
  assert.doesNotMatch(read("staleServiceRecovery.js").split("function evaluateAutoCloseSafe")[1].split("function createStaleServiceRecovery")[0], /trip/i);
});

// ── D. trip CLOSED: auto-close still allowed ─────────────────────────────────
test("D · stale + RETIRADO paid + trip CLOSED + no tables + unpaid 0 + overCollected 0: auto-close STILL happens", async () => {
  const w = makeWorld({ trips: [tripRow({ status: "CLOSED" })] });
  const r = await w.recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.equal(r.recovered, true);
  assert.equal(w.session.status, "closed");
  assert.equal(w.closeouts.size, 1);
  assert.equal(w.calls.close, 1);
});

// ── E. current (non-stale) service + no trip: unchanged ──────────────────────
test("E · a current (non-stale) service is never touched by recovery; a manual close with no active trip succeeds as before", async () => {
  const cur = makeWorld({ session: { id: TARGET, status: "open", business_date: TODAY, opened_at: "2026-09-19T08:00:00Z" } });
  const r = await cur.recovery(TODAY).recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.NO_STALE_SERVICE);
  assert.equal(cur.calls.closeAuthority, 0);
  assert.equal(cur.calls.tripReads.length, 0, "no stale service -> the trip is not even read");

  const w = makeWorld();
  const c = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(c.success, true);
  assert.equal(c.code, "V3_CLOSED");
  assert.equal(w.session.status, "closed");
});

// ── F. rider_actor NULL ──────────────────────────────────────────────────────
test("F · a dispatcher-started trip (rider_actor NULL) blocks exactly like a rider-started one: the guard never reads rider_actor", async () => {
  for (const rider_actor of [null, "rider"]) {
    const w = makeWorld({ trips: [tripRow({ rider_actor })] });
    const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
    assert.equal(r.code, "V3_CLOSE_ACTIVE_RIDER_TRIP", `rider_actor=${rider_actor}`);
  }
  // The real projection never carries rider_actor at all — the blocker works from the bare shape:
  const bare = await findActiveRiderTripForService({ serviceSessionId: TARGET, readProjection: async () => ({ ok: true, active: true, trip_id: "t", members: [] }) });
  assert.equal(bare.active, true);
});

// ── G. another service's trip ────────────────────────────────────────────────
test("G · an ACTIVE trip that belongs to ANOTHER service does NOT block the target service", async () => {
  const w = makeWorld({ trips: [tripRow({ service_session_id: OTHER, trip_id: "trip-other" })] });
  const c = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(c.success, true, "not a global 'any ACTIVE trip' check");
  assert.deepEqual(w.calls.tripReads[0], [TARGET], "attribution is by the target service id, resolved in the projection scope");
  const r = await makeWorld({ trips: [tripRow({ service_session_id: OTHER })] }).recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
});

// ── H. retry / idempotency ───────────────────────────────────────────────────
test("H1 · refusal, then the trip closes, then a retry: exactly ONE attempt and ONE closeout — no duplicate, no regression", async () => {
  const w = makeWorld({ trips: [tripRow()] });
  const first = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(first.code, "V3_CLOSE_ACTIVE_RIDER_TRIP");
  assert.equal(w.calls.acquire, 0);
  w.trips[0].status = "CLOSED"; // the operator's "Driver volvió" (close_rider_trip) landed
  const second = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(second.success, true);
  assert.equal(w.calls.acquire, 1);
  assert.equal(w.calls.create, 1);
  assert.equal(w.closeouts.size, 1);
});

test("H2 · a retry of an ALREADY-CLOSED service stays an idempotent success and is never re-judged against the trip", async () => {
  const w = makeWorld();
  const ok = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(ok.success, true);
  w.trips.push(tripRow()); // an ACTIVE trip appears AFTER the close — irrelevant to an idempotent retry
  const readsBefore = w.calls.tripReads.length;
  const again = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(again.success, true);
  assert.equal(again.idempotent, true);
  assert.equal(w.calls.create, 1, "no second closeout");
  assert.equal(w.calls.tripReads.length, readsBefore, "already-closed retry does not consult the trip");
});

test("H3 · resume of a crashed close (closeout persisted, terminal transition pending): refused while a trip is ACTIVE, without touching the transition", async () => {
  const w = makeWorld();
  // Simulate a crash after Phase D: attempt active + closeout persisted, service still open.
  w.attempts.set(TARGET, { closeoutCorrelationId: "corr-1", serviceSessionId: TARGET, status: "active" });
  w.closeouts.set(TARGET, { id: "co-1", serviceSessionId: TARGET, closeoutCorrelationId: "corr-1", financial: {}, operational: { occupiedTablesAtClose: 0 } });
  w.trips.push(tripRow());
  const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(r.success, false);
  assert.equal(r.code, "V3_CLOSE_ACTIVE_RIDER_TRIP");
  assert.equal(r.closeoutCorrelationId, "corr-1");
  assert.equal(w.calls.close, 0);
  assert.equal(w.calls.persist, 0);
  assert.equal(w.session.status, "open");
  w.trips[0].status = "CLOSED";
  const done = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(done.success, true);
  assert.equal(w.calls.create, 0, "the resume never creates a second closeout");
});

// ── I. fail closed ───────────────────────────────────────────────────────────
test("I · an unreadable trip projection is NOT 'no trip': the close is refused (typed) and nothing is written", async () => {
  const w = makeWorld({ projectionUnreadable: true });
  const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(r.success, false);
  assert.equal(r.code, "V3_CLOSE_RIDER_TRIP_UNVERIFIABLE");
  assert.ok(w.nothingDurableWritten());
  const rec = await makeWorld({ projectionUnreadable: true }).recovery().recoverStaleService({ actor: "owner" });
  assert.equal(rec.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(rec.blockers.autoCloseError, "V3_CLOSE_RIDER_TRIP_UNVERIFIABLE");
  // malformed shapes are unverifiable too
  for (const body of [null, {}, { ok: false, code: "SCOPE_UNAVAILABLE" }, { ok: true }, { ok: true, active: "yes" }]) {
    const c = await findActiveRiderTripForService({ serviceSessionId: TARGET, readProjection: async () => body });
    assert.equal(c.ok, false);
    assert.equal(closeRefusalFromCheck(c).code, "V3_CLOSE_RIDER_TRIP_UNVERIFIABLE");
  }
  assert.equal((await findActiveRiderTripForService({ serviceSessionId: "" })).ok, false);
  assert.equal((await findActiveRiderTripForService({ serviceSessionId: TARGET, readProjection: async () => { throw new Error("boom"); } })).ok, false);
});

// ── J. the pre-close scan REPORTS the same fact (operator visibility) ────────
test("J · the pre-close scan reports blocking.trips + a 'trip' row from the same single definition (1 / 0 / null — never 'none' when unreadable)", async () => {
  const active = makeWorld({ trips: [tripRow()] });
  const a = await scanPreClose({ select: active.select, resolveCurrentService: async () => active.session, activeRiderTrip: active.activeRiderTrip });
  assert.equal(a.blocking.trips, 1);
  const row = a.attivi.find((x) => x.kind === "trip");
  assert.ok(row);
  assert.equal(row.tripId, "trip-1");
  assert.equal(row.stato, "REPARTO_ACTIVO");
  assert.equal(row.memberCount, 1);

  const none = makeWorld();
  const n = await scanPreClose({ select: none.select, resolveCurrentService: async () => none.session, activeRiderTrip: none.activeRiderTrip });
  assert.equal(n.blocking.trips, 0);
  assert.equal(n.attivi.filter((x) => x.kind === "trip").length, 0);

  const unread = makeWorld({ projectionUnreadable: true });
  const u = await scanPreClose({ select: unread.select, resolveCurrentService: async () => unread.session, activeRiderTrip: unread.activeRiderTrip });
  assert.equal(u.blocking.trips, null);
  assert.equal(u.attivi.filter((x) => x.kind === "trip").length, 0);
  // existing blocking fields are unchanged
  assert.equal(a.blocking.orders, 0);
  assert.equal(a.blocking.tables, 0);
});

// ── K. dead / legacy pins ────────────────────────────────────────────────────
test("K · begin_service_close_if_idle stays DEAD: no runtime caller (it is NOT the guard, and it is not reactivated)", () => {
  const root = path.join(__dirname, "..");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = [...walk(path.join(root, "src")), path.join(root, "index.js")].filter((f) => f.endsWith(".js"));
  const callers = files.filter((f) => /beginServiceCloseIfIdle|begin_service_close_if_idle/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")));
  const rel = callers.map((f) => path.relative(root, f)).sort();
  // Only its definition (riderTrip.js) and the read-only resource-policy registry mention it.
  assert.deepEqual(rel, ["src/agents/riderTrip.js", "src/utils/supabaseResourcePolicy.js"]);
  const engine = fs.readFileSync(path.join(root, "src/serviceSessions/serviceLifecycleEngine.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(engine, /beginServiceCloseIfIdle|begin_service_close_if_idle|service_closing/);
});

// ════════════════════════════════════════════════════════════════════════════
// MIGRATION 138 — the JS preflight is NOT the authority: the DATABASE refuses.
//
// close_service_session_v3 now takes the dispatch lock (L0) that start_rider_trip_v2 also takes first, and
// refuses V3_CLOSE_ACTIVE_RIDER_TRIP itself while a trip is ACTIVE for the service (proven on real PostgreSQL by
// ci/giro-authority-certification/harness/runActiveTripCloseExclusion.js). These tests fix the JS side of that
// contract: a refusal that comes back FROM THE RPC (the preflight read "no trip", then a trip started, or the
// preflight was bypassed) surfaces exactly like the preflight's own refusal — same code, same `activeTrip` —
// so Finalizar, stale recovery and the FE keep ONE vocabulary. `preflightBlind` = the preflight said "no trip".
// ════════════════════════════════════════════════════════════════════════════
test("L1 · manual Finalizar with a BLIND JS preflight (the trip started after it read): the DATABASE refusal comes back as the same typed refusal, with the trip; the service stays open", async () => {
  const w = makeWorld({ trips: [tripRow()], preflightBlind: true, dbAuthority: true });
  const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(r.success, false);
  assert.equal(r.code, "V3_CLOSE_ACTIVE_RIDER_TRIP", "same code the preflight uses: ONE vocabulary");
  assert.equal(r.activeTrip.tripId, "trip-1", "the RPC's `trip` is normalized into the same activeTrip shape as the preflight's");
  assert.equal(r.activeTrip.memberCount, 1);
  assert.equal(r.activeTrip.anchorOrderUid, "uid-016");
  assert.equal(w.calls.blindReads, 1, "the preflight ran and saw no trip…");
  assert.equal(w.calls.close, 1, "…so the RPC WAS reached, and it is the RPC that refused");
  assert.equal(w.session.status, "open", "the service is NOT closed");
  // The database refusal comes last, so Phase A-D artifacts exist: an ordinary CASE B resume state, no duplicate on retry.
  assert.equal(w.calls.acquire, 1);
  assert.equal(w.closeouts.size, 1);
  assert.equal(w.attempts.get(TARGET).status, "active", "the attempt stays active for the resume");
  // index.js forwards the refusal untouched ({ success:false, error: code, ...v3Result }).
  assert.equal(r.error, undefined, "the engine result itself; index.js adds `error` from `code`");
});

test("L1b · …then the trip is closed (Driver volvió after the rider's Entregado) and Finalizar is retried: it RESUMES — no second closeout — and closes", async () => {
  const w = makeWorld({ trips: [tripRow()], preflightBlind: true, dbAuthority: true });
  const first = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(first.code, "V3_CLOSE_ACTIVE_RIDER_TRIP");
  w.trips[0].status = "CLOSED";
  const second = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(second.success, true);
  assert.equal(second.code, "V3_CLOSED");
  assert.equal(w.session.status, "closed");
  assert.equal(w.calls.create, 1, "the resume never creates a second closeout");
  assert.equal(w.closeouts.size, 1);
  assert.equal(w.attempts.get(TARGET).status, "completed");
});

test("L2 · resume of a persisted closeout (CASE B) with a BLIND preflight: the RPC refusal carries the trip AND the correlation id; nothing else moves", async () => {
  const w = makeWorld({ preflightBlind: true, dbAuthority: true });
  w.attempts.set(TARGET, { closeoutCorrelationId: "corr-1", serviceSessionId: TARGET, status: "active" });
  w.closeouts.set(TARGET, { id: "co-1", serviceSessionId: TARGET, closeoutCorrelationId: "corr-1", financial: {}, operational: { occupiedTablesAtClose: 0 } });
  w.trips.push(tripRow());
  const r = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(r.success, false);
  assert.equal(r.code, "V3_CLOSE_ACTIVE_RIDER_TRIP");
  assert.equal(r.closeoutCorrelationId, "corr-1");
  assert.equal(r.activeTrip.tripId, "trip-1");
  assert.equal(w.session.status, "open");
  assert.equal(w.calls.create, 0);
});

test("L3 · stale + RETIRADO paid + a trip that ACTIVATED behind a blind preflight: PREVIOUS_SERVICE_PENDING carrying the DB's trip — NEVER AUTO_RECOVERY_PERFORMED", async () => {
  const w = makeWorld({ trips: [tripRow()], preflightBlind: true, dbAuthority: true });
  const r = await w.recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.notEqual(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.notEqual(r.recovered, true);
  assert.equal(r.blockers.autoCloseError, ACTIVE_RIDER_TRIP_CODE.ACTIVE_RIDER_TRIP);
  assert.equal(r.blockers.activeTrip.tripId, "trip-1", "the blocker carries the trip the DATABASE reported");
  assert.equal(r.blockers.orders, 0);
  assert.equal(r.blockers.unpaid, 0);
  assert.equal(w.session.status, "open");
});

test("L4 · stale + trip CLOSED, through the REAL transition adapter: auto-close still happens (the DB path does not over-block)", async () => {
  const w = makeWorld({ trips: [tripRow({ status: "CLOSED" })], dbAuthority: true });
  const r = await w.recovery().recoverStaleService({ actor: "owner" });
  assert.equal(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.equal(r.recovered, true);
  assert.equal(w.session.status, "closed");
});

test("L5 · trip of ANOTHER service, through the DB path: does not block the target (attribution is by service)", async () => {
  const w = makeWorld({ trips: [tripRow({ service_session_id: OTHER, trip_id: "trip-other" })], preflightBlind: true, dbAuthority: true });
  const c = await w.closeAuthority({ serviceSessionId: TARGET, source: "operator_finalizar_v3", actor: "owner" });
  assert.equal(c.success, true);
});

test("L6 · the transition adapter is still a thin transport: it passes the RPC's `trip` through, ignores a malformed one, and leaves the success path untouched", async () => {
  const mk = (body) => createServiceLifecycleV3Transition({ rpc: async () => ({ ok: true, body }) });
  const args = { serviceSessionId: "s", closeoutCorrelationId: "c", actor: "a", source: "x" };
  const refused = await mk({ ok: false, code: "V3_CLOSE_ACTIVE_RIDER_TRIP", trip: { trip_id: "t1", members: [{}, {}] } }).close(args);
  assert.deepEqual(refused, { success: false, code: "V3_CLOSE_ACTIVE_RIDER_TRIP", session: null, trip: { trip_id: "t1", members: [{}, {}] } });
  const noTrip = await mk({ ok: false, code: "CLOSEOUT_NOT_FOUND" }).close(args);
  assert.deepEqual(noTrip, { success: false, code: "CLOSEOUT_NOT_FOUND", session: null }, "a refusal without `trip` is byte-for-byte what it was before 138");
  const malformed = await mk({ ok: false, code: "V3_CLOSE_ACTIVE_RIDER_TRIP", trip: "nope" }).close(args);
  assert.equal("trip" in malformed, false);
  const ok = await mk({ ok: true, code: "V3_CLOSED", idempotent: false, session: { id: "s", status: "closed" } }).close(args);
  assert.equal(ok.success, true);
  assert.equal(ok.code, "V3_CLOSED");
  const transport = await createServiceLifecycleV3Transition({ rpc: async () => ({ ok: false }) }).close(args);
  assert.equal(transport.code, "SERVICE_LIFECYCLE_V3_TRANSITION_TRANSPORT_ERROR", "a transport failure is still a typed refusal, never a success");
});

test("L7 · ONE summary shape: the preflight's projection and the DB refusal's `trip` normalize to the same activeTrip", () => {
  const projection = { ok: true, active: true, trip_id: "t1", anchor_order_uid: "u1", giro_id: null, departed_at: "2026-09-19T10:00:00Z", members: [{ order_uid: "u1", stop_seq: 1 }] };
  const { ok, active, ...dbTrip } = projection; // what the migration-138 refusal puts under `trip`
  assert.deepEqual(summarizeActiveTrip(dbTrip), summarizeActiveTrip(projection));
  assert.deepEqual(summarizeActiveTrip(projection), { tripId: "t1", anchorOrderUid: "u1", giroId: null, departedAt: "2026-09-19T10:00:00Z", memberCount: 1 });
  assert.deepEqual(summarizeActiveTrip(null), { tripId: null, anchorOrderUid: null, giroId: null, departedAt: null, memberCount: null });
});

test("L8 · the departure side: SERVICE_NOT_OPEN is a 409 state conflict (never a 500), and the response leaks no service detail", () => {
  assert.equal(CODE_TO_HTTP.SERVICE_NOT_OPEN, 409);
  const r = mapResult({ ok: true, body: { ok: false, code: "SERVICE_NOT_OPEN", service_session_id: "svc-secret", status: "closed" } });
  assert.deepEqual(r, { status: 409, payload: { error: "SERVICE_NOT_OPEN" } });
  // an unmapped code would have fallen through to a generic 500 — the reason the mapping exists:
  assert.equal(mapResult({ ok: true, body: { ok: false, code: "SOME_UNMAPPED_CODE" } }).status, 500);
});
