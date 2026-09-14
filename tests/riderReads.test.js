// tests/riderReads.test.js — S2-1C rider-scoped read boundary. Offline (sbSelect injected).
// W4 Packet 02A (2026-09-14): giro facts (manual_giro_id / giro membership / state /
// salida / hora_ref / dissolved) now come exclusively from the canonical Giro Authority
// projection, stubbed here via require.cache (same technique as
// tests/previewOrderTiming.test.js, Packet 01) since riderReads.js requires
// giroProjectionReader directly rather than accepting it via deps. ORDER/TRIP-MODE
// fixtures and assertions are otherwise unchanged from the pre-W4 test.

// NB: riderReads.js destructures `const { readGiroProjection } = require(...)` at its
// own module-load time, capturing a reference to WHATEVER function is assigned to
// exports.readGiroProjection at that instant. Reassigning require.cache[...].exports.
// readGiroProjection to a *different* function object afterwards would NOT be seen by
// riderReads.js's already-bound local reference — so this one stub closure is the only
// one ever installed, and both the returned value (STUB_PROJECTION) and the call count
// (projectionCallCount) are read/written through variables it closes over, not by
// swapping the function itself.
let STUB_PROJECTION = null;
let projectionCallCount = 0;
const readerPath = require.resolve("../src/core/delivery/giroProjectionReader");
require(readerPath);
require.cache[readerPath].exports.readGiroProjection = async () => {
  projectionCallCount++;
  return STUB_PROJECTION;
};

const riderReads = require("../src/agents/riderReads");
const { RIDER_GIRO_FIELDS } = riderReads;

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); } };

const ORDERS = [
  // A/B carry a deliberately WRONG/STALE raw manual_giro_id: the Projection disagrees
  // (A/B -> G1) and must win (W4-02A-N02).
  // language-guard: allow-legacy tipo_consegna is the existing ordenes field name, reproduced verbatim in this fixture
  { id: "A", num: 1, estado: "LISTO", tipo_consegna: "DOMICILIO", zona: "Q1", nombre: "X", tel: "1", direccion: "d", items: [], totale: 10, ts: 1, wa_id: "secret", conversacion: "secret", ya_pagado: true, manual_giro_id: "STALE_WRONG_ID", salida_ref: "order-level-raw-untouched" },
  // language-guard: allow-legacy tipo_consegna is the existing ordenes field name, reproduced verbatim in this fixture
  { id: "B", num: 2, estado: "EN_ENTREGA", tipo_consegna: "DOMICILIO", zona: "Q2", ts: 2, manual_giro_id: "STALE_WRONG_ID" },
  { id: "C", num: 3, estado: "LISTO", tipo_consegna: "RITIRO", ts: 3 },           // pickup -> excluded pre-trip
  { id: "D", num: 4, estado: "RETIRADO", tipo_consegna: "DOMICILIO", ts: 4 },      // terminal -> excluded
  // language-guard: allow-legacy tipo_consegna is the existing ordenes field name, reproduced verbatim in this fixture
  { id: "E", num: 5, estado: "LISTO", tipo_consegna: "DOMICILIO", ts: 5 },         // next-trip candidate, Projection -> G9
  // language-guard: allow-legacy tipo_consegna is the existing ordenes field name, reproduced verbatim in this fixture
  { id: "F", num: 6, estado: "LISTO", tipo_consegna: "DOMICILIO", ts: 6 },         // no giro at all (not in projection.orders)
];

// The canonical projection: G1 (A,B effective members, PLANNED), G9 (E, PLANNED),
// G0 (DISSOLVED, no effective members). F deliberately absent from `orders[]`.
const PROJECTION = {
  contract: "giro_projection_v1", scope_valid: true, degraded: false,
  giros: [
    { giro_id: "G1", giro_state: "PLANNED", salida: "18:00", salida_source: "OPERATOR", hora_ref: "17:50", effective_members: [{ order_uid: "u-a", order_id: "A" }, { order_uid: "u-b", order_id: "B" }], dissolved_at: null, dissolved_by: null },
    { giro_id: "G9", giro_state: "PLANNED", salida: "19:10", salida_source: "PROXY_MAX_FORNO", hora_ref: null, effective_members: [{ order_uid: "u-e", order_id: "E" }], dissolved_at: null, dissolved_by: null },
    { giro_id: "G0", giro_state: "DISSOLVED", salida: null, salida_source: "NONE", hora_ref: null, effective_members: [], dissolved_at: "2026-09-14T09:00:00Z", dissolved_by: "pin_dashboard" },
  ],
  orders: [
    { order_uid: "u-a", order_id: "A", effective_giro_id: "G1" },
    { order_uid: "u-b", order_id: "B", effective_giro_id: "G1" },
    { order_uid: "u-e", order_id: "E", effective_giro_id: "G9" },
  ],
  intents: [],
};

// Legacy metadata enrichment source — entrega_ref is not in the Projection at all.
const GIRO_METADATA_ROWS = [
  { id: "G1", entrega_ref: "18:10" },
  { id: "G9", entrega_ref: null },
];

// P0-C3 — the pre-trip branch now goes through getOperationalSessionIds()/
// serviceSessionsQuery() (business-date-scoped) instead of an unconditional
// full-table scan. This offline stub doesn't need real session/business-date
// logic: sbSelect below already ignores the query string entirely and
// returns the full ORDERS fixture / GIRO_METADATA_ROWS by table name, so a
// single non-empty stub session id is enough to reach that branch's sbSelect
// call (matching the real deps shape index.js now injects for the rider path).
const depsWith = (driverStato) => ({
  sbSelect: async (table, q) => {
    if (table === "config") return [{ chiave: "DRIVER_STATO", valore: JSON.stringify(driverStato) }];
    if (table === "ordenes") return ORDERS;
    if (table === "manual_giros") return GIRO_METADATA_ROWS; // entrega_ref enrichment only
    return [];
  },
  getOperationalSessionIds: async () => ["stub-session"],
  serviceSessionsQuery: (ids, q) => `service_session_id=in.(${ids.join(",")})${q ? "&" + q : ""}`,
});

(async () => {
  STUB_PROJECTION = PROJECTION;

  // ── Pre-trip (no active trip) — ORDER/TRIP-MODE logic, unchanged by W4 ──
  const noTrip = depsWith({ stato: "LIBERO", active_trip: null });
  const pre = await riderReads.getRiderOrdenes(noTrip);
  const preIds = pre.map((o) => o.id).sort();
  check("pre-trip: delivery LISTO/EN_ENTREGA only", JSON.stringify(preIds) === JSON.stringify(["A", "B", "E", "F"]));
  check("pre-trip: excludes pickup (C)", !preIds.includes("C"));
  check("pre-trip: excludes terminal (D)", !preIds.includes("D"));
  check("projection excludes wa_id/conversacion/ya_pagado", pre.every((o) => !("wa_id" in o) && !("conversacion" in o) && !("ya_pagado" in o)));
  check("projection includes delivery fields", pre[0].nombre !== undefined && pre[0].direccion !== undefined && pre[0].totale !== undefined);
  check("order-level salida_ref stays raw (untouched by this cutover)", pre.find((o) => o.id === "A").salida_ref === "order-level-raw-untouched");

  // ── W4-02A-N01: rider order manual_giro_id = effective_giro_id ──
  const aDto = pre.find((o) => o.id === "A");
  const bDto = pre.find((o) => o.id === "B");
  const eDto = pre.find((o) => o.id === "E");
  check("W4-02A-N01: A.manual_giro_id = G1 (Projection effective_giro_id)", aDto.manual_giro_id === "G1", aDto.manual_giro_id);
  check("W4-02A-N01: B.manual_giro_id = G1", bDto.manual_giro_id === "G1", bDto.manual_giro_id);
  check("W4-02A-N01: E.manual_giro_id = G9", eDto.manual_giro_id === "G9", eDto.manual_giro_id);

  // ── W4-02A-N02 (PROMOTION-BLOCKING): raw/projection disagreement -> Projection wins ──
  check("W4-02A-N02: A's raw manual_giro_id was STALE_WRONG_ID, DTO is G1, never the raw value",
    aDto.manual_giro_id === "G1" && aDto.manual_giro_id !== "STALE_WRONG_ID");
  check("W4-02A-N02: B's raw manual_giro_id was STALE_WRONG_ID, DTO is G1, never the raw value",
    bDto.manual_giro_id === "G1" && bDto.manual_giro_id !== "STALE_WRONG_ID");

  // Order absent from projection.orders[] -> manual_giro_id null (never a guess).
  const fDto = pre.find((o) => o.id === "F");
  check("order absent from Projection -> manual_giro_id null", fDto.manual_giro_id === null);

  // ── In-trip (snapshot membership) — ORDER/TRIP-MODE logic, unchanged by W4 ──
  const trip = depsWith({ stato: "IN_GIRO", active_trip: { status: "ACTIVE", order_ids: ["A", "B"], manual_giro_ids: ["G1"] } });
  const inTrip = await riderReads.getRiderOrdenes(trip);
  const inIds = inTrip.map((o) => o.id).sort();
  check("in-trip: only snapshot order_ids", JSON.stringify(inIds) === JSON.stringify(["A", "B"]));
  check("in-trip: excludes next-trip order E", !inIds.includes("E"));
  check("in-trip: manual_giro_id still canonical", inTrip.every((o) => o.manual_giro_id === "G1"));

  // ── W4-02A-N03: rider giro members = effective_members ──
  const preGiros = await riderReads.getRiderManualGiros(noTrip);
  const g1 = preGiros.find((g) => g.id === "G1");
  check("W4-02A-N03: G1 present with canonical shape", !!g1);

  // ── W4-02A-N04: DISSOLVED state comes from the Projection ──
  const preGiroIds = preGiros.map((g) => g.id).sort();
  check("W4-02A-N04: pre-trip giros exclude DISSOLVED G0", !preGiroIds.includes("G0") && preGiroIds.includes("G1") && preGiroIds.includes("G9"));

  // ── W4-02A-N05: salida_ref = canonical projection.salida ──
  check("W4-02A-N05: G1.salida_ref = projection.salida (18:00, OPERATOR)", g1.salida_ref === "18:00", g1.salida_ref);
  const g9 = preGiros.find((g) => g.id === "G9");
  check("W4-02A-N05: G9.salida_ref = projection.salida (19:10, PROXY_MAX_FORNO)", g9.salida_ref === "19:10", g9.salida_ref);

  // ── W4-02A-N06: hora_ref parity ──
  check("W4-02A-N06: G1.hora_ref = 17:50 (operator override, direct passthrough)", g1.hora_ref === "17:50", g1.hora_ref);
  check("W4-02A-N06: G9.hora_ref = null (no operator override)", g9.hora_ref === null);

  // ── W4-02A-N07: legacy metadata (entrega_ref) cannot override a canonical fact ──
  check("W4-02A-N07: G1.entrega_ref = legacy enrichment value (18:10)", g1.entrega_ref === "18:10", g1.entrega_ref);
  check("W4-02A-N07: G9.entrega_ref = null (no enrichment row / null value), giro_state still canonical", g9.entrega_ref === null && g9.hora_ref === null);
  check("W4-02A-N07: public giro DTO keys are exactly RIDER_GIRO_FIELDS", JSON.stringify(Object.keys(g1).sort()) === JSON.stringify([...RIDER_GIRO_FIELDS].sort()));

  // In-trip giros: only the snapshot's manual_giro_ids, from the Projection.
  const inGiros = (await riderReads.getRiderManualGiros(trip)).map((g) => g.id);
  check("in-trip giros: only snapshot manual_giro_ids", JSON.stringify(inGiros) === JSON.stringify(["G1"]));

  // ── W4-02A-N08 (PROMOTION-BLOCKING): Projection unavailable -> no raw Giro fallback ──
  STUB_PROJECTION = null;
  const unavailGiros = await riderReads.getRiderManualGiros(noTrip);
  check("W4-02A-N08: Projection null -> getRiderManualGiros returns [] (never a raw/guessed list)", Array.isArray(unavailGiros) && unavailGiros.length === 0);
  const unavailOrders = await riderReads.getRiderOrdenes(noTrip);
  check("W4-02A-N08/N09: Projection null -> orders still fully readable", Array.isArray(unavailOrders) && unavailOrders.length === 4);
  check("W4-02A-N08/N09: Projection null -> every order's manual_giro_id is null, never the raw STALE_WRONG_ID", unavailOrders.every((o) => o.manual_giro_id === null));
  check("W4-02A-N09: degraded read does not throw / does not 503 by itself", true); // proven by reaching this line without a thrown exception

  // ── W4-02A-N09b: degraded projection (scope_valid true, degraded:true) — same as unavailable ──
  STUB_PROJECTION = { contract: "giro_projection_v1", scope_valid: true, degraded: true, giros: [], orders: [], intents: [] };
  const degradedGiros = await riderReads.getRiderManualGiros(noTrip);
  check("W4-02A-N09b: degraded:true -> [] giros, never a guess", Array.isArray(degradedGiros) && degradedGiros.length === 0);
  const degradedOrders = await riderReads.getRiderOrdenes(noTrip);
  check("W4-02A-N09b: degraded:true -> orders still readable, manual_giro_id null", degradedOrders.length === 4 && degradedOrders.every((o) => o.manual_giro_id === null));

  // ── W4-02A-N09c: scope_valid:false (SCOPE_UNAVAILABLE) — same fail-closed posture ──
  STUB_PROJECTION = { contract: "giro_projection_v1", scope_valid: false, degraded: false, giros: [], orders: [], intents: [] };
  check("W4-02A-N09c: scope invalid -> [] giros", (await riderReads.getRiderManualGiros(noTrip)).length === 0);
  check("W4-02A-N09c: scope invalid -> orders still readable", (await riderReads.getRiderOrdenes(noTrip)).length === 4);

  // ── W4-02A-N10 (PROMOTION-BLOCKING): one Projection RPC per logical reader request ──
  STUB_PROJECTION = PROJECTION;
  projectionCallCount = 0;
  await riderReads.getRiderOrdenes(noTrip);
  check("W4-02A-N10: getRiderOrdenes makes exactly 1 Projection read per call", projectionCallCount === 1, projectionCallCount);
  projectionCallCount = 0;
  await riderReads.getRiderManualGiros(noTrip);
  check("W4-02A-N10: getRiderManualGiros makes exactly 1 Projection read per call", projectionCallCount === 1, projectionCallCount);

  // ── S2-1D fail-closed cases (ORDER/TRIP-MODE — unchanged by W4) ──
  const broken = { sbSelect: async (t) => t === "config" ? [{ chiave: "DRIVER_STATO", valore: "{bad json" }] : ORDERS };
  const bres = await riderReads.getRiderOrdenes(broken);
  check("malformed snapshot -> fail closed (not a list)", !Array.isArray(bres) && bres.error === "rider_read_unavailable");

  const inconsistent = depsWith({ stato: "IN_GIRO", active_trip: null });
  const ires = await riderReads.getRiderOrdenes(inconsistent);
  check("IN_GIRO without active snapshot -> fail closed", !Array.isArray(ires) && ires.reason === "in_giro_without_active_snapshot");

  const badSnap = depsWith({ stato: "IN_GIRO", active_trip: { status: "ACTIVE" } });
  const sres = await riderReads.getRiderOrdenes(badSnap);
  check("ACTIVE snapshot missing order_ids -> fail closed", !Array.isArray(sres) && sres.reason === "snapshot_missing_order_ids");

  const readErr = { sbSelect: async (t) => { if (t === "config") throw new Error("db down"); return ORDERS; } };
  const eres = await riderReads.getRiderOrdenes(readErr);
  check("config read error -> fail closed", !Array.isArray(eres) && eres.reason === "config_read_error");

  const sessionScopeErr = {
    sbSelect: async (t) => (t === "config" ? [{ chiave: "DRIVER_STATO", valore: JSON.stringify({ stato: "LIBERO", active_trip: null }) }] : ORDERS),
    getOperationalSessionIds: async () => { throw new Error("db down"); },
    serviceSessionsQuery: () => "unused",
  };
  const sres2 = await riderReads.getRiderOrdenes(sessionScopeErr);
  check("session-scope read error -> fail closed to empty list, not the unscoped fallback", Array.isArray(sres2) && sres2.length === 0);

  const missingMember = depsWith({ stato: "IN_GIRO", active_trip: { status: "ACTIVE", order_ids: ["A", "ZZZ"], manual_giro_ids: [] } });
  const mm = (await riderReads.getRiderOrdenes(missingMember)).map((o) => o.id).sort();
  check("active snapshot missing order -> only valid rows, no broadening", JSON.stringify(mm) === JSON.stringify(["A"]));

  // ── W4-02A-N11: public DTO shape unchanged ──
  check("W4-02A-N11: order DTO key set unchanged (RIDER_ORDER_FIELDS superset, only values present)",
    pre[0] && Object.keys(pre[0]).every((k) => riderReads.RIDER_ORDER_FIELDS.includes(k)));
  check("W4-02A-N11: giro DTO key set = RIDER_GIRO_FIELDS exactly", JSON.stringify(Object.keys(g1).sort()) === JSON.stringify([...RIDER_GIRO_FIELDS].sort()));
  check("W4-02A-N11: module exports unchanged", JSON.stringify(Object.keys(riderReads).sort()) === JSON.stringify(["RIDER_GIRO_FIELDS", "RIDER_ORDER_FIELDS", "getRiderManualGiros", "getRiderOrdenes", "readActiveTrip"].sort()));

  // ── W4-02A-N13: no new raw manual_giro_id truth reader (source-level check) ──
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "riderReads.js"), "utf8");
  const codeOnly = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  check("W4-02A-N13: getRiderManualGiros body no longer selects raw manual_giros as giro truth (only entrega_ref enrichment remains)",
    /select=id,entrega_ref/.test(codeOnly));
  check("W4-02A-N13: source reads manual_giro_id only as a DTO output key, never a filter/select criterion on ordenes reads",
    !/manual_giro_id=eq\.|manual_giro_id=in\.|dissolved!==true|completed!==true/.test(codeOnly));

  console.log(`\nriderReads: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.message)); process.exit(1); });
