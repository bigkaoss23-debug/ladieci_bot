// tests/riderReads.test.js — S2-1C rider-scoped read boundary. Offline (sbSelect injected).
const riderReads = require("../src/agents/riderReads");
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

const ORDERS = [
  { id: "A", num: 1, estado: "LISTO", tipo_consegna: "DOMICILIO", zona: "Q1", nombre: "X", tel: "1", direccion: "d", items: [], totale: 10, ts: 1, wa_id: "secret", conversacion: "secret", ya_pagado: true, manual_giro_id: "G1", salida_ref: "18:00" },
  { id: "B", num: 2, estado: "EN_ENTREGA", tipo_consegna: "DOMICILIO", zona: "Q2", ts: 2, manual_giro_id: "G1" },
  { id: "C", num: 3, estado: "LISTO", tipo_consegna: "RITIRO", ts: 3 },           // pickup -> excluded pre-trip
  { id: "D", num: 4, estado: "RETIRADO", tipo_consegna: "DOMICILIO", ts: 4 },      // terminal -> excluded
  { id: "E", num: 5, estado: "LISTO", tipo_consegna: "DOMICILIO", ts: 5, manual_giro_id: "G9" }, // next-trip candidate
];
const GIROS = [
  { id: "G1", salida_ref: "18:00", hora_ref: "17:50", entrega_ref: "18:10", internal: "x" },
  { id: "G9", salida_ref: "19:00", dissolved: false },
  { id: "G0", salida_ref: "10:00", dissolved: true },  // dissolved -> excluded
];
// P0-C3 — the pre-trip branch now goes through getOperationalSessionIds()/
// serviceSessionsQuery() (business-date-scoped) instead of an unconditional
// full-table scan. This offline stub doesn't need real session/business-date
// logic: sbSelect below already ignores the query string entirely and
// returns the full ORDERS/GIROS fixtures by table name, so a single
// non-empty stub session id is enough to reach that branch's sbSelect call
// (matching the real deps shape index.js now injects for the rider path).
const depsWith = (driverStato) => ({
  sbSelect: async (table, q) => {
    if (table === "config") return [{ chiave: "DRIVER_STATO", valore: JSON.stringify(driverStato) }];
    if (table === "ordenes") return ORDERS;
    if (table === "manual_giros") return GIROS;
    return [];
  },
  getOperationalSessionIds: async () => ["stub-session"],
  serviceSessionsQuery: (ids, q) => `service_session_id=in.(${ids.join(",")})${q ? "&" + q : ""}`,
});

(async () => {
  // ── Pre-trip (no active trip) ──
  const noTrip = depsWith({ stato: "LIBERO", active_trip: null });
  const pre = await riderReads.getRiderOrdenes(noTrip);
  const preIds = pre.map((o) => o.id).sort();
  check("pre-trip: delivery LISTO/EN_ENTREGA only", JSON.stringify(preIds) === JSON.stringify(["A","B","E"]));
  check("pre-trip: excludes pickup (C)", !preIds.includes("C"));
  check("pre-trip: excludes terminal (D)", !preIds.includes("D"));
  check("projection excludes wa_id/conversacion/ya_pagado", pre.every((o) => !("wa_id" in o) && !("conversacion" in o) && !("ya_pagado" in o)));
  check("projection includes delivery fields", pre[0].nombre !== undefined && pre[0].direccion !== undefined && pre[0].totale !== undefined);

  // ── In-trip (snapshot membership) ──
  const trip = depsWith({ stato: "IN_GIRO", active_trip: { status: "ACTIVE", order_ids: ["A","B"], manual_giro_ids: ["G1"] } });
  const inTrip = await riderReads.getRiderOrdenes(trip);
  const inIds = inTrip.map((o) => o.id).sort();
  check("in-trip: only snapshot order_ids", JSON.stringify(inIds) === JSON.stringify(["A","B"]));
  check("in-trip: excludes next-trip order E", !inIds.includes("E"));

  // ── Manual giros ──
  const preGiros = (await riderReads.getRiderManualGiros(noTrip)).map((g) => g.id).sort();
  check("pre-trip giros: excludes dissolved G0", !preGiros.includes("G0") && preGiros.includes("G1"));
  const inGiros = (await riderReads.getRiderManualGiros(trip)).map((g) => g.id);
  check("in-trip giros: only snapshot manual_giro_ids", JSON.stringify(inGiros) === JSON.stringify(["G1"]));
  const g = (await riderReads.getRiderManualGiros(trip))[0];
  check("giro projection excludes internal field", !("internal" in g) && g.salida_ref !== undefined);

  // ── S2-1D fail-closed cases ──
  // Malformed JSON while (implicitly) present -> fail closed, NOT pre-trip broadening.
  const broken = { sbSelect: async (t) => t === "config" ? [{ chiave: "DRIVER_STATO", valore: "{bad json" }] : (t === "ordenes" ? ORDERS : GIROS) };
  const bres = await riderReads.getRiderOrdenes(broken);
  check("malformed snapshot -> fail closed (not a list)", !Array.isArray(bres) && bres.error === "rider_read_unavailable");

  // IN_GIRO but no ACTIVE snapshot -> fail closed.
  const inconsistent = depsWith({ stato: "IN_GIRO", active_trip: null });
  const ires = await riderReads.getRiderOrdenes(inconsistent);
  check("IN_GIRO without active snapshot -> fail closed", !Array.isArray(ires) && ires.reason === "in_giro_without_active_snapshot");

  // ACTIVE snapshot with missing order_ids array -> fail closed.
  const badSnap = depsWith({ stato: "IN_GIRO", active_trip: { status: "ACTIVE" } });
  const sres = await riderReads.getRiderOrdenes(badSnap);
  check("ACTIVE snapshot missing order_ids -> fail closed", !Array.isArray(sres) && sres.reason === "snapshot_missing_order_ids");

  // Config READ error -> fail closed.
  const readErr = { sbSelect: async (t) => { if (t === "config") throw new Error("db down"); return ORDERS; } };
  const eres = await riderReads.getRiderOrdenes(readErr);
  check("config read error -> fail closed", !Array.isArray(eres) && eres.reason === "config_read_error");

  // P0-C3 — a session-scope read error must fail closed to an EMPTY
  // pre-trip candidate list, never fall back to the old unscoped full-table
  // scan. In-trip mode is untouched by this (still its own precise
  // order_ids-bounded read) — proven separately by "in-trip: only snapshot
  // order_ids" above, which never even calls getOperationalSessionIds.
  const sessionScopeErr = {
    sbSelect: async (t) => (t === "config" ? [{ chiave: "DRIVER_STATO", valore: JSON.stringify({ stato: "LIBERO", active_trip: null }) }] : ORDERS),
    getOperationalSessionIds: async () => { throw new Error("db down"); },
    serviceSessionsQuery: () => "unused",
  };
  const sres2 = await riderReads.getRiderOrdenes(sessionScopeErr);
  check("session-scope read error -> fail closed to empty list, not the unscoped fallback", Array.isArray(sres2) && sres2.length === 0);

  // ACTIVE snapshot referencing a missing order -> returns only valid rows, never broadens.
  const missingMember = depsWith({ stato: "IN_GIRO", active_trip: { status: "ACTIVE", order_ids: ["A","ZZZ"], manual_giro_ids: [] } });
  const mm = (await riderReads.getRiderOrdenes(missingMember)).map((o) => o.id).sort();
  check("active snapshot missing order -> only valid rows, no broadening", JSON.stringify(mm) === JSON.stringify(["A"]));

  console.log(`\nriderReads: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.message)); process.exit(1); });
