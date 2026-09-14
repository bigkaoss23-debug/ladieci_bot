// tests/deliveryProposalSelector.test.js
// ===============================================================
// PREMIUM PLANNER — selector puro `selectDeliveryProposals`.
// Run: node tests/deliveryProposalSelector.test.js
//
// Boundary: PURO/offline. Lavora sull'output già calcolato di
// previewStrategicOpportunities (firstAvailable/bestProposal/opportunities[]).
// Niente DB/fetch/env/router, niente Date.now. Verifica:
//   ruoli bottone, status comanda (no_recomendado in coda), max 4, determinismo.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { selectDeliveryProposals } = require("../src/core/delivery/deliveryProposalSelector");
const { previewStrategicOpportunities } = require("../src/agents/previewStrategicOpportunities");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

// ── helper: opportunity nella shape reale di buildPremiumOpportunity ──────────
function opp(over = {}) {
  const routeZones = over.routeZones || ["Q2", "Q5"];
  return {
    id: over.id || `opp-${routeZones.join("-").toLowerCase()}`,
    kind: over.kind || "agregar", // agregar | crear
    channel: over.channel || "sur",
    routeZones,
    routeEtas: over.routeEtas || [
      { zone: routeZones[0], eta: "20:50", isNew: true, slips: false, slipLabel: "" },
      { zone: routeZones[1], eta: "21:00", isNew: false, slips: false, slipLabel: "" },
    ],
    status: over.status || "compatible",
    blocked: over.blocked === true,
    title: over.title || `Agregar a giro ${routeZones[routeZones.length - 1]}`,
    explanation: over.explanation || "",
    warning: over.warning || "",
    routeTimeline: over.routeTimeline || { nodes: [] },
  };
}
function directOpp(over = {}) {
  return opp({
    id: over.id || "opp-direct-q2",
    kind: "crear",
    channel: over.channel || "sur",
    routeZones: ["Q2"],
    routeEtas: [{ zone: "Q2", eta: "20:40", isNew: true, slips: false, slipLabel: "" }],
    status: over.status || "compatible",
    blocked: over.blocked === true,
    title: over.title || "Crear giro Q2",
    ...over,
  });
}
function response(over = {}) {
  return {
    ok: over.ok !== false,
    firstAvailable: over.firstAvailable !== undefined ? over.firstAvailable : { zone: "Q2", eta: "20:40", status: "compatible" },
    bestProposal: over.bestProposal !== undefined ? over.bestProposal : directOpp(),
    opportunities: over.opportunities || [],
    safety: over.safety || { readOnly: true, writes: false, pii: "redacted" },
  };
}
function kinds(res) { return res.proposals.map((p) => p.kind); }

function main() {
  // ── purity ──
  console.log("\n══ Purity ══");
  {
    const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/deliveryProposalSelector.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    check("no Date.now", !/Date\.now/.test(code));
    check("no process.env", !/process\.env/.test(code));
    check("no require (zero import)", !/\brequire\s*\(/.test(code));
    check("no fetch/supabase/router/db-verbs",
      !/\bfetch\b|supabase|express|\brouter\b|app\.(get|post|put|patch|delete)|\b(insert|update|delete|upsert)\s*\(/i.test(code));
  }

  // ── A. solo direct se nessun anchor ──
  console.log("\n══ A. solo direct (no anchor) ══");
  {
    const r = selectDeliveryProposals(response({ opportunities: [] }));
    check("contract", r.contract === "premium-planner-proposal-selection-v1");
    check("1 sola proposal", r.proposals.length === 1, JSON.stringify(kinds(r)));
    check("kind direct", r.proposals[0].kind === "direct");
    check("rank 1", r.proposals[0].rank === 1);
    check("timeLabel dalla baseline", r.proposals[0].timeLabel === "20:40", r.proposals[0].timeLabel);
  }

  // ── B. compatible insertion scelto come best ──
  console.log("\n══ B. compatible insertion = best ══");
  {
    const r = selectDeliveryProposals(response({
      opportunities: [opp({ id: "ins-q5", status: "compatible" })],
    }));
    check("direct + insertion", JSON.stringify(kinds(r)) === JSON.stringify(["direct", "insertion"]), JSON.stringify(kinds(r)));
    const ins = r.proposals.find((p) => p.kind === "insertion");
    check("insertion status compatible", ins.status === "compatible");
    check("insertion zoneLabel Q2 → Q5 (sur)", ins.zoneLabel === "Q2 → Q5 (sur)", ins.zoneLabel);
    check("nessun not_recommended", !kinds(r).includes("not_recommended"));
  }

  // ── C. ajuste genera alternative prudente ──
  console.log("\n══ C. ajuste → alternative ══");
  {
    const r = selectDeliveryProposals(response({
      opportunities: [
        opp({ id: "ins-a", status: "ajuste", warning: "Q5 se mueve +5" }),
        opp({ id: "ins-b", status: "ajuste", routeZones: ["Q1", "Q2"], title: "Agregar a giro Q2" }),
      ],
    }));
    check("direct + insertion + alternative", JSON.stringify(kinds(r)) === JSON.stringify(["direct", "insertion", "alternative"]), JSON.stringify(kinds(r)));
    const ins = r.proposals.find((p) => p.kind === "insertion");
    const alt = r.proposals.find((p) => p.kind === "alternative");
    check("insertion = primo ajuste (ins-a)", ins.id === "ins-a", ins.id);
    check("alternative = secondo (ins-b)", alt.id === "ins-b", alt.id);
    check("insertion reason dal warning", ins.reason === "Q5 se mueve +5", ins.reason);
  }

  // ── D. no_recomendado resta sotto e non supera ajuste/compatible ──
  console.log("\n══ D. no_recomendado in coda ══");
  {
    // rankOpportunities reale metterebbe compatible prima del cross; qui simuliamo
    // l'ordine già rankato (compatible, poi no_recomendado).
    const r = selectDeliveryProposals(response({
      opportunities: [
        opp({ id: "ins-ok", status: "compatible" }),
        opp({ id: "cross-q3", status: "no_recomendado", channel: "cross", routeZones: ["Q3", "Q5"],
              blocked: true, title: "Q3+Q5 no recomendado" }),
      ],
    }));
    check("ordine ruoli", JSON.stringify(kinds(r)) === JSON.stringify(["direct", "insertion", "not_recommended"]), JSON.stringify(kinds(r)));
    const ins = r.proposals.find((p) => p.kind === "insertion");
    const nr = r.proposals.find((p) => p.kind === "not_recommended");
    check("not_recommended rank > insertion rank", nr.rank > ins.rank, `ins=${ins.rank} nr=${nr.rank}`);
    check("insertion è compatible (non lo cross)", ins.status === "compatible" && ins.id === "ins-ok");
    check("not_recommended è il cross", nr.status === "no_recomendado" && nr.id === "cross-q3");
  }

  // ── E. lleno / missing-travel non entrano come proposta principale ──
  console.log("\n══ E. lleno / missing-travel esclusi ══");
  {
    const r = selectDeliveryProposals(response({
      opportunities: [
        opp({ id: "full-q5", status: "lleno", blocked: true, title: "Giro lleno" }),
        // missing-travel: no_recomendado MA routeEtas vuoto → NON Bottone 4.
        opp({ id: "miss-q5", status: "no_recomendado", blocked: true, routeEtas: [], title: "Tiempos incompletos" }),
      ],
    }));
    check("solo direct (nessun insertion/alt/not_rec)", JSON.stringify(kinds(r)) === JSON.stringify(["direct"]), JSON.stringify(kinds(r)));
    check("lleno non presente", !r.proposals.some((p) => p.status === "lleno"));
    check("missing-travel non diventa not_recommended", !kinds(r).includes("not_recommended"));
  }

  // ── F. massimo 4 proposals ──
  console.log("\n══ F. max 4 ══");
  {
    const r = selectDeliveryProposals(response({
      opportunities: [
        opp({ id: "c1", status: "compatible" }),
        opp({ id: "c2", status: "compatible", routeZones: ["Q1", "Q2"] }),
        opp({ id: "c3", status: "compatible", routeZones: ["Q1", "Q5"] }),
        opp({ id: "cross", status: "no_recomendado", channel: "cross", blocked: true, routeZones: ["Q3", "Q5"] }),
      ],
    }));
    check("esattamente 4 (direct+insertion+alternative+not_recommended)", r.proposals.length === 4, JSON.stringify(kinds(r)));
    check("rank 1..4 contigui", r.proposals.map((p) => p.rank).join(",") === "1,2,3,4");
    // cap esplicito a 3
    const r3 = selectDeliveryProposals(response({
      opportunities: [opp({ id: "c1", status: "compatible" }), opp({ id: "c2", status: "compatible", routeZones: ["Q1", "Q2"] })],
    }), { maxProposals: 3 });
    check("cap maxProposals=3 rispettato", r3.proposals.length <= 3);
  }

  // ── G. stesso input = stesso ordine (determinismo) ──
  console.log("\n══ G. determinismo ══");
  {
    const input = response({
      opportunities: [
        opp({ id: "c1", status: "compatible" }),
        opp({ id: "a1", status: "ajuste", routeZones: ["Q1", "Q2"] }),
        opp({ id: "cross", status: "no_recomendado", channel: "cross", blocked: true, routeZones: ["Q3", "Q5"] }),
      ],
    });
    const r1 = selectDeliveryProposals(input);
    const r2 = selectDeliveryProposals(input);
    check("output identico tra due run", JSON.stringify(r1) === JSON.stringify(r2));
    check("rank stabile", r1.proposals.map((p) => `${p.kind}:${p.rank}`).join("|") === r2.proposals.map((p) => `${p.kind}:${p.rank}`).join("|"));
  }

  // ── H. EN_ENTREGA escluso resta escluso (E2E via adapter reale) ──
  console.log("\n══ H. EN_ENTREGA escluso (E2E) ══");
  {
    const snap = {
      now: "20:30",
      orders: [
        { id: "q5-enentrega", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", zona: "Q5", hora: "21:00", n_pizze: 2 },
        { id: "q5-encocina", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:05", n_pizze: 1 },
      ],
      manual_giros: [],
    };
    previewStrategicOpportunities({
      currentOrderDraft: { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:35",
      snapshot: snap,
      travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
      capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
    }).then((preview) => {
      const sel = selectDeliveryProposals(preview);
      const blob = JSON.stringify(sel);
      check("E2E ok: proposals prodotte", sel.proposals.length >= 1, JSON.stringify(kinds(sel)));
      check("E2E nessuna proposal referenzia q5-enentrega", !/q5-enentrega/.test(blob), blob);
      check("E2E direct presente", kinds(sel).includes("direct"));
      console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
      process.exit(fail > 0 ? 1 : 0);
    }).catch((e) => {
      console.error("UNEXPECTED:", e && e.stack ? e.stack : e);
      process.exit(1);
    });
  }
}

main();
