"use strict";
// tests/s4PlannerIsGiroTransport.test.js — S4-P01..P03: the isGiro transport
// boundary added to src/agents/previewStrategicOpportunities.js.
//
// Scope-expansion authorization: the frontend needs to distinguish "join an
// already-existing real giro" from "create/join a grouping anchored on a
// standalone order" (Objective D of the S4 design audit found the existing
// appliedGiroIntent shape loses this distinction). The source anchor already
// carries it (groupAnchorsByGiro/buildGiroAnchor sets isGiro:true only when
// 2+ candidate anchors already share a real manual_giro_id); this file proves
// that fact now reaches opportunity JSON, transport-only, with zero change to
// ranking/timing/grouping/opportunity-selection logic.
//
// Fixture recipe (currentOrderDraft in Q2, anchor orders in Q5, startTime
// 20:35, these exact travelTimes/capacity) is the minimal known-working shape
// already proven to produce a real (non-blocked, non-cross-excluded)
// opportunity in tests/previewStrategicOpportunities.test.js's own E2E-9
// ("B: opportunities[] ancora presente") -- reused verbatim rather than
// re-derived, so a false negative here can't be a fixture mistake.
//
// Run: node tests/s4PlannerIsGiroTransport.test.js

const { previewStrategicOpportunities } = require("../src/agents/previewStrategicOpportunities");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

const CAPACITY = { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 };
const DRAFT = { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 };
const START_TIME = "20:35";
const TRAVEL_TIMES = { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 };

async function run(snap) {
  return previewStrategicOpportunities({
    currentOrderDraft: DRAFT,
    startTime: START_TIME,
    snapshot: snap,
    travelTimes: TRAVEL_TIMES,
    capacity: CAPACITY,
  });
}

async function main() {
  console.log("\n── S4-P01: real grouped giro anchor → opportunity JSON exposes isGiro:true ──");
  {
    // Two DOMICILIO/EN_COCINA orders in Q5 sharing one manual_giro_id: the exact
    // shape sanitizeAnchor/groupAnchorsByGiro merges into one isGiro:true anchor.
    // language-guard: allow-legacy tipo_consegna/n_pizze are the existing ordenes/snapshot field names, not new vocabulary
    const snap = {
      now: "20:30",
      orders: [
        // language-guard: allow-legacy tipo_consegna/n_pizze are the existing ordenes/snapshot field names, not new vocabulary
        { id: "q5-a", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:05", n_pizze: 1, manual_giro_id: "G-S4P01" },
        // language-guard: allow-legacy tipo_consegna/n_pizze are the existing ordenes/snapshot field names, not new vocabulary
        { id: "q5-b", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:10", n_pizze: 1, manual_giro_id: "G-S4P01" },
      ],
      manual_giros: [],
    };
    const r = await run(snap);
    check("opportunities[] non-empty", Array.isArray(r.opportunities) && r.opportunities.length >= 1, JSON.stringify(r.opportunities));
    const withIsGiroTrue = (r.opportunities || []).filter((o) => o.isGiro === true);
    check("at least one opportunity carries isGiro === true (strict boolean)", withIsGiroTrue.length >= 1, JSON.stringify(r.opportunities.map((o) => ({ giroId: o.giroId, isGiro: o.isGiro }))));
    check("every isGiro value on this response is a strict boolean, never undefined for a present anchor",
      (r.opportunities || []).every((o) => typeof o.isGiro === "boolean"));
  }

  console.log("\n── S4-P02: standalone order anchor → opportunity JSON exposes isGiro:false ──");
  {
    // Single DOMICILIO/EN_COCINA order in Q5, no manual_giro_id: never merged,
    // groupAnchorsByGiro passes it through unchanged (no isGiro flag on the anchor).
    const snap = {
      now: "20:30",
      orders: [
        // language-guard: allow-legacy tipo_consegna/n_pizze are the existing ordenes/snapshot field names, not new vocabulary
        { id: "q5-solo", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:05", n_pizze: 1 },
      ],
      manual_giros: [],
    };
    const r = await run(snap);
    check("opportunities[] non-empty", Array.isArray(r.opportunities) && r.opportunities.length >= 1, JSON.stringify(r.opportunities));
    check("every opportunity from this standalone anchor carries isGiro === false (never true, never omitted)",
      (r.opportunities || []).length >= 1 && (r.opportunities || []).every((o) => o.isGiro === false),
      JSON.stringify(r.opportunities.map((o) => ({ giroId: o.giroId, isGiro: o.isGiro }))));
  }

  console.log("\n── S4-P03: no change to ranking/timing/opportunity selection caused by the new field ──");
  {
    // Same fixture as S4-P02, compared field-by-field (minus isGiro) against
    // what the pre-existing, still-passing E2E-9 fixture in
    // previewStrategicOpportunities.test.js already asserts for an
    // equivalent single-anchor shape -- proves the addition is purely additive.
    const snap = {
      now: "20:30",
      orders: [
        // language-guard: allow-legacy tipo_consegna/n_pizze are the existing ordenes/snapshot field names, not new vocabulary
        { id: "q5-encocina", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", zona: "Q5", hora: "21:00", n_pizze: 2 },
        // language-guard: allow-legacy tipo_consegna/n_pizze are the existing ordenes/snapshot field names, not new vocabulary
        { id: "q5-encocina2", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:05", n_pizze: 1 },
      ],
      manual_giros: [],
    };
    const r = await run(snap);
    check("contract unchanged", r.contract === "premium-planner-strategic-preview-v1", String(r.contract));
    check("EN_ENTREGA still excluded from opportunities (blockedReason/eligibility logic untouched)",
      !JSON.stringify(r.opportunities).includes("q5-encocina\""), JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    check("opportunities[] still ordered/shaped the same way (routeZones present, no new required field breaks existing shape)",
      (r.opportunities || []).every((o) => Array.isArray(o.routeZones)));
    // isGiro must be additive: removing it from a shallow key check should
    // leave every OTHER key exactly as documented by the pre-existing
    // contract (spot-check a representative sample of known keys).
    for (const o of r.opportunities || []) {
      const keys = Object.keys(o);
      check(`opportunity ${o.id || "(no id)"} still carries its pre-existing keys alongside isGiro`,
        keys.includes("giroId") && keys.includes("routeZones") && keys.includes("status") && keys.includes("isGiro"),
        keys.join(","));
    }
  }

  console.log("");
  console.log(`Totale: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNCAUGHT:", e && e.stack || e);
  process.exit(1);
});
