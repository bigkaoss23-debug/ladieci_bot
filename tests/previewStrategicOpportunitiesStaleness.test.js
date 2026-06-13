// tests/previewStrategicOpportunitiesStaleness.test.js
// ===============================================================
// PLANNER_STALENESS_BACKEND_FIX_01 — anti-staleness anchor filter +
// service-day/now derivation (Madrid).  Run: node tests/<this file>
//
// Boundary: read-only, pure. Nessun DB/rete/Date.now leak.
//   - servizio.serviceDateMadrid / nowMadridHHMM (boundary backend, ora Madrid).
//   - plannerSnapshot.buildOrdersQuery (finestra service-day, no full-scan).
//   - previewStrategicOpportunities.buildAnchorsFromSnapshot (filtro anti-stale).
//   - E2E: snapshot con anchor vecchio + now → niente proposta tossica (+150).
// ===============================================================
"use strict";

const {
  serviceDateMadrid,
  nowMadridHHMM,
} = require("../src/utils/servizio");
const {
  _internal: snapInternal,
} = require("../src/core/delivery/plannerSnapshot");
const {
  previewStrategicOpportunities,
  buildAnchorsFromSnapshot,
  isAnchorStale,
  toClockMin,
} = require("../src/agents/previewStrategicOpportunities");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

const CAPACITY = { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 };
const CURRENT_Q2 = { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "22:55", serviceMin: 2 };

// Snapshot helper: orders + now, shape plannerSnapshot.orders.
function snap(orders, now) {
  return { now, orders, manual_giros: [], driver: null, driver_events: [], driver_status: null };
}

async function main() {
  // ── 1. serviceDateMadrid: after-midnight → giorno di servizio precedente ─────
  console.log("\n══ 1+9. service-day Madrid (after-midnight) ══");
  {
    // 22:55 Madrid (CEST +02:00) → stesso giorno.
    check("serviceDate 22:55 = stesso giorno",
      serviceDateMadrid(new Date("2026-06-13T22:55:00+02:00")) === "2026-06-13",
      serviceDateMadrid(new Date("2026-06-13T22:55:00+02:00")));
    // 00:30 Madrid del 14 → servizio ancora del 13 (rollover 06:00).
    check("serviceDate 00:30 (dopo mezzanotte) = giorno prima",
      serviceDateMadrid(new Date("2026-06-14T00:30:00+02:00")) === "2026-06-13",
      serviceDateMadrid(new Date("2026-06-14T00:30:00+02:00")));
    // 05:30 Madrid del 14 → ancora servizio del 13.
    check("serviceDate 05:30 = giorno prima",
      serviceDateMadrid(new Date("2026-06-14T05:30:00+02:00")) === "2026-06-13",
      serviceDateMadrid(new Date("2026-06-14T05:30:00+02:00")));
  }

  // ── 2. nowMadridHHMM ────────────────────────────────────────────────────────
  console.log("\n══ 2. nowMadridHHMM ══");
  {
    check("now 22:55 → '22:55'",
      nowMadridHHMM(new Date("2026-06-13T22:55:00+02:00")) === "22:55",
      String(nowMadridHHMM(new Date("2026-06-13T22:55:00+02:00"))));
    check("now 00:05 → '00:05' (h23, niente 24:00)",
      nowMadridHHMM(new Date("2026-06-14T00:05:00+02:00")) === "00:05",
      String(nowMadridHHMM(new Date("2026-06-14T00:05:00+02:00"))));
  }

  // ── 3+9. buildOrdersQuery: bounded (no full-scan) + copre after-midnight ─────
  console.log("\n══ 3+9. buildOrdersQuery service-day window ══");
  {
    const q = snapInternal.buildOrdersQuery({ date: "2026-06-13" });
    check("query con date ha lower bound gte 2026-06-13",
      /created_at=gte\.2026-06-13T00%3A00%3A00/.test(q), q);
    check("query con date ha upper bound lt 2026-06-15 (date+2, copre 00:00–06:00 del 14)",
      /created_at=lt\.2026-06-15T00%3A00%3A00/.test(q), q);
    const qNoDate = snapInternal.buildOrdersQuery({});
    check("senza date → nessun filtro created_at (default full-scan evitato dal dispatcher)",
      !/created_at=/.test(qNoDate), qNoDate);
    check("runtime con date NON è full-scan (created_at presente)",
      /created_at=gte/.test(q) && /created_at=lt/.test(q), q);
  }

  // ── toClockMin / isAnchorStale unit ─────────────────────────────────────────
  console.log("\n══ toClockMin + isAnchorStale ══");
  {
    check("toClockMin 22:55 = 1375", toClockMin("22:55") === 1375);
    check("toClockMin 00:30 night-norm = 1470", toClockMin("00:30") === 1470);
    check("isAnchorStale: now null → mai stale", isAnchorStale({ hora: "20:00" }, null) === false);
    check("isAnchorStale: ref mancante → mai stale", isAnchorStale({}, 1375) === false);
  }

  // ── 4. EN_COCINA futuro → tenuto ────────────────────────────────────────────
  console.log("\n══ 4+11. EN_COCINA futuro → anchor tenuta ══");
  {
    const anchors = buildAnchorsFromSnapshot(
      snap([{ id: "a-q5", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "23:30", n_pizze: 2 }], "22:55"),
      { currentOrderZone: "Q2", now: "22:55" });
    check("EN_COCINA Q5 23:30 (futuro) tenuto", anchors.length === 1 && anchors[0].zone === "Q5",
      JSON.stringify(anchors));
  }

  // ── 5. EN_COCINA vecchio oltre soglia → escluso ─────────────────────────────
  console.log("\n══ 5. EN_COCINA vecchio → escluso ══");
  {
    const anchors = buildAnchorsFromSnapshot(
      snap([{ id: "a-q5", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "20:25", n_pizze: 2 }], "22:55"),
      { currentOrderZone: "Q2", now: "22:55" });
    check("EN_COCINA Q5 20:25 (vs now 22:55) escluso", anchors.length === 0, JSON.stringify(anchors));
  }

  // ── 6. LISTO fresco → tenuto ────────────────────────────────────────────────
  console.log("\n══ 6. LISTO fresco → tenuto ══");
  {
    const anchors = buildAnchorsFromSnapshot(
      // LISTO con hora 22:40, entro grazia 30' rispetto a now 22:55.
      snap([{ id: "a-q5", tipo_consegna: "DOMICILIO", estado: "LISTO", zona: "Q5", hora: "22:40", n_pizze: 1 }], "22:55"),
      { currentOrderZone: "Q2", now: "22:55" });
    check("LISTO Q5 22:40 (fresco, entro grazia) tenuto", anchors.length === 1, JSON.stringify(anchors));
  }

  // ── 7. LISTO troppo vecchio → escluso ───────────────────────────────────────
  console.log("\n══ 7. LISTO vecchio → escluso ══");
  {
    const anchors = buildAnchorsFromSnapshot(
      snap([{ id: "a-q5", tipo_consegna: "DOMICILIO", estado: "LISTO", zona: "Q5", hora: "21:00", n_pizze: 1 }], "22:55"),
      { currentOrderZone: "Q2", now: "22:55" });
    check("LISTO Q5 21:00 (vs now 22:55) escluso", anchors.length === 0, JSON.stringify(anchors));
  }

  // ── 7b. campo 'vivo' preferito a hora: entrega_estimada futura salva l'anchor ─
  console.log("\n══ 7b. riferimento 'vivo' (entrega_estimada) ══");
  {
    const anchors = buildAnchorsFromSnapshot(
      // hora 20:25 (passata) ma entrega_estimada 23:10 (futura) → tenuto.
      snap([{ id: "a-q5", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5",
        hora: "20:25", entrega_estimada: "23:10", n_pizze: 1 }], "22:55"),
      { currentOrderZone: "Q2", now: "22:55" });
    check("entrega_estimada 23:10 (futura) tiene l'anchor pur con hora 20:25",
      anchors.length === 1, JSON.stringify(anchors));
  }

  // ── 8. E2E: startTime 22:55 + anchor 20:25 vecchio → NESSUN +150 ────────────
  console.log("\n══ 8. E2E anti +150 ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT_Q2,
      startTime: "22:55",
      now: "22:55",
      capacity: CAPACITY,
      snapshot: snap([
        { id: "ghost-q5", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "20:25", n_pizze: 2 },
      ], "22:55"),
    });
    check("ok true", r.ok === true, JSON.stringify(r).slice(0, 200));
    check("nessun anchor stantio nella serviceLine", r.serviceLine.length === 0, JSON.stringify(r.serviceLine));
    check("warning no_anchors (anchor vecchio scartato)",
      r.warnings.some((w) => w.code === "no_anchors"), JSON.stringify(r.warnings));
    check("nessuna opportunity verso Q5 (anchor tossico filtrato)",
      !r.opportunities.some((o) => Array.isArray(o.routeZones) && o.routeZones.includes("Q5")),
      JSON.stringify(r.opportunities.map((o) => o.routeZones)));
  }

  // ── 10. regression: ghost POR_CONFIRMAR resta escluso (allowlist stati) ──────
  console.log("\n══ 10. regression ghost POR_CONFIRMAR ══");
  {
    const anchors = buildAnchorsFromSnapshot(
      // anche se "futuro", POR_CONFIRMAR non è in ANCHOR_ELIGIBLE_STATES.
      snap([{ id: "ghost", tipo_consegna: "DOMICILIO", estado: "POR_CONFIRMAR", zona: "Q5", hora: "23:30", n_pizze: 1 }], "22:55"),
      { currentOrderZone: "Q2", now: "22:55" });
    check("POR_CONFIRMAR mai anchor (anche se futuro)", anchors.length === 0, JSON.stringify(anchors));
  }

  // ── 11. anchor sano normale continua a produrre opportunity ─────────────────
  console.log("\n══ 11. anchor sano → opportunity prodotta ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "22:50", serviceMin: 2 },
      startTime: "22:35",
      now: "22:30",
      capacity: CAPACITY,
      snapshot: snap([
        { id: "ord-q5", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "23:00", n_pizze: 2 },
      ], "22:30"),
    });
    check("ok true", r.ok === true);
    check("opportunity Q2→Q5 prodotta (anchor sano futuro)",
      r.opportunities.some((o) => o.routeZones[0] === "Q2" && o.routeZones[1] === "Q5"),
      JSON.stringify(r.opportunities.map((o) => o.routeZones)));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
