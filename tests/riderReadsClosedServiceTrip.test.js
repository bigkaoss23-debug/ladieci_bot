// tests/riderReadsClosedServiceTrip.test.js -- DELIVERY x ECONOMY DECOUPLING (migration 139).
// A trip that already departed may outlive the close of its economic service. The rider must STILL see the members of
// that trip (and only them) so they can complete Entregado / payment; and the fail-closed contract for "no scope and no
// residual trip" is unchanged. Offline: the trip reader is stubbed through require.cache exactly like riderReads.test.js
// (the giro projection too, so the DTO enrichment stays independent of this scenario).
"use strict";

let STUB_TRIP = null;
const readerPath = require.resolve("../src/core/delivery/giroProjectionReader");
require(readerPath);
require.cache[readerPath].exports.readGiroProjection = async () => null; // giro enrichment degrades to null (documented, non-fatal)
const tripReaderPath = require.resolve("../src/core/delivery/tripProjectionReader");
require(tripReaderPath);
require.cache[tripReaderPath].exports.readTripProjection = async () => STUB_TRIP;

const riderReads = require("../src/agents/riderReads");

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); } };

// language-guard: allow-legacy tipo_consegna is the existing ordenes field name, reproduced verbatim in these fixtures
const ORDER = { id: "#017", order_uid: "u-017", num: 17, estado: "EN_ENTREGA", tipo_consegna: "DOMICILIO", zona: "Q1", nombre: "X", tel: "1", direccion: "d", items: [], totale: 12.5, ts: 1, wa_id: "secret", conversacion: "secret", cobrado: false };
// language-guard: allow-legacy tipo_consegna is the existing ordenes field name, reproduced verbatim in these fixtures
const OTHER_CLOSED_SERVICE_ORDER = { id: "#009", order_uid: "u-009", estado: "RETIRADO", tipo_consegna: "DOMICILIO", ts: 0 };

const queries = [];
const deps = (rows, scope) => ({
  sbSelect: async (table, q) => { queries.push({ table, q }); return rows.filter((r) => q.includes(r.order_uid)); },
  getOperationalSessionIds: async () => scope,
  serviceSessionsQuery: (ids, rest) => `service_session_id=in.(${ids.join(",")})&${rest}`,
});

(async () => {
  console.log("── the service is CLOSED (no operational scope at all) and its trip is still ACTIVE ──");
  STUB_TRIP = { ok: true, active: true, trip_id: "t1", anchor_order_uid: "u-017", giro_id: null, departed_at: "2026-09-19T21:00:00Z", members: [{ order_uid: "u-017", stop_seq: 1 }] };
  const r = await riderReads.getRiderOrdenes(deps([ORDER, OTHER_CLOSED_SERVICE_ORDER], []));
  check("the rider DOES read (no 503) and sees exactly the trip's member", Array.isArray(r) && r.length === 1 && r[0].id === "#017", r);
  check("the read is bounded by the trip's FROZEN membership (order_uid), never by the closed service", queries.length === 1 && /^order_uid=in\.\(u-017\)/.test(queries[0].q) && !/service_session_id/.test(queries[0].q), queries);
  check("the DTO is still the minimal delivery projection (no conversation / WhatsApp fields)", r[0].wa_id === undefined && r[0].conversacion === undefined && r[0].nombre === "X", r[0]);
  check("the rider sees money/state facts needed to complete the stop (estado, totale, cobrado)", r[0].estado === "EN_ENTREGA" && r[0].totale === 12.5 && r[0].cobrado === false, r[0]);
  check("the older closed-service order is NOT brought back (no widening to the whole closed service)", !r.some((o) => o.id === "#009"), r);

  console.log("── a trip that is no longer ACTIVE and no scope at all: unchanged contract ──");
  STUB_TRIP = { ok: true, active: false };
  const none = await riderReads.getRiderOrdenes(deps([ORDER], []));
  check("pre-trip mode with NO operational scope stays an empty candidate list (never an unscoped scan)", Array.isArray(none) && none.length === 0, none);
  STUB_TRIP = null;
  const unavailable = await riderReads.getRiderOrdenes(deps([ORDER], []));
  check("an unreadable projection (no scope, no residual) is STILL fail-closed: rider_read_unavailable, never 'no trip'", unavailable && unavailable.error === "rider_read_unavailable", unavailable);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
})();
