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
const depsWith = (driverStato) => ({
  sbSelect: async (table, q) => {
    if (table === "config") return [{ chiave: "DRIVER_STATO", valore: JSON.stringify(driverStato) }];
    if (table === "ordenes") return ORDERS;
    if (table === "manual_giros") return GIROS;
    return [];
  },
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

  // ── Best-effort: broken DRIVER_STATO degrades to pre-trip ──
  const broken = { sbSelect: async (t) => t === "config" ? [{ chiave: "DRIVER_STATO", valore: "{bad json" }] : (t === "ordenes" ? ORDERS : GIROS) };
  const degraded = (await riderReads.getRiderOrdenes(broken)).map((o) => o.id).sort();
  check("broken snapshot -> pre-trip filter", JSON.stringify(degraded) === JSON.stringify(["A","B","E"]));

  console.log(`\nriderReads: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.message)); process.exit(1); });
