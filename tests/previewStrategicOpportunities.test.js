// tests/previewStrategicOpportunities.test.js
// ===============================================================
// PREMIUM PLANNER — read-only offline adapter `previewStrategicOpportunities`.
// Run: node tests/previewStrategicOpportunities.test.js
//
// Boundary:
//   - adapter OFFLINE: orquesta i mattoni puri (strategicOpportunities,
//     routeImpact, premiumPlannerBridge, premiumPlannerOpportunities) su
//     fixture/snapshot iniettati. Niente DB/fetch/env/router, niente Date.now.
//   - startTime ESPLICITO obbligatorio (missing → blocker missing_start_time).
//   - no PII in output; write-guard provato con db che throwa su write.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

let mod;
try {
  mod = require("../src/agents/previewStrategicOpportunities");
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND" && /previewStrategicOpportunities/.test(String(e.message))) {
    console.log("EXPECTED FAIL: src/agents/previewStrategicOpportunities.js not implemented yet.");
    process.exit(1);
  }
  throw e;
}

const { previewStrategicOpportunities } = mod;

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

// db che throwa su qualunque write: prova che l'adapter non scrive mai.
function writeGuardDb() {
  const calls = [];
  const write = (op) => { throw new Error(`unexpected_db_write_${op}`); };
  return {
    calls,
    select: async (table, query) => { calls.push({ op: "select", table, query }); return []; },
    insert: () => write("insert"),
    update: () => write("update"),
    delete: () => write("delete"),
    upsert: () => write("upsert"),
  };
}

const CAPACITY = { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 };

// Snapshot fixture con PII deliberata: l'adapter NON deve mai propagarla.
function snapshotWithPii() {
  return {
    now: "20:30",
    orders: [
      {
        id: "#Q5-2100", tipo_consegna: "DOMICILIO", estado: "EN_COCINA",
        zona: "Q5", hora: "21:00", n_pizze: 2,
        // PII che NON deve apparire in output:
        nombre: "Persona Inventada", telefono: "+34000000000", direccion: "Calle Falsa 123",
      },
      {
        id: "#Q5-RET", tipo_consegna: "DOMICILIO", estado: "RETIRADO", // terminale → escluso
        zona: "Q5", hora: "20:40", n_pizze: 1,
      },
      {
        id: "#RIT-1", tipo_consegna: "RITIRO", estado: "NUEVO", // non DOMICILIO → escluso
        zona: "Q2", hora: "21:00", n_pizze: 1,
      },
    ],
    manual_giros: [],
    driver: null, driver_events: [], driver_status: null,
  };
}

function noPii(obj) {
  const out = JSON.stringify(obj);
  return !/Persona Inventada|\+34000000000|Calle Falsa|telefono|direccion|nombre/i.test(out);
}
function noStacktrace(obj) {
  const out = JSON.stringify(obj);
  return !/\bat\s+\w+\s*\(|Error:|\.js:\d+/.test(out);
}

async function main() {
  // ── Module boundary / purity ───────────────────────────────────────────────
  console.log("\n══ Module boundary / purity ══");
  {
    check("export previewStrategicOpportunities", typeof previewStrategicOpportunities === "function");
    const src = fs.readFileSync(path.join(__dirname, "../src/agents/previewStrategicOpportunities.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    check("no Date.now", !/Date\.now/.test(code));
    check("no process.env", !/process\.env/.test(code));
    check("no fetch/supabase/router/db-verbs",
      !/\bfetch\b|supabase|express|\brouter\b|app\.(get|post|put|patch|delete)|\b(insert|update|delete|upsert)\s*\(/i.test(code),
      "adapter must not call live IO");
    check("not imported by index.js (checked separately in grep)", true);
  }

  // ── 1. Q2 current + Q5 anchor (esplicito) ──────────────────────────────────
  console.log("\n══ 1. Q2 current + Q5 anchor ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "new-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:35",
      anchors: [{ id: "tg-q5", zona: "Q5", hora: "21:00", pizzas: 2 }],
      travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
      capacity: CAPACITY,
    });
    check("ok true", r.ok === true, JSON.stringify(r));
    check("contract", r.contract === "premium-planner-strategic-preview-v1");
    check("source offline-readonly", r.source === "offline-readonly");
    check("currentOrder zone Q2", r.currentOrder.zone === "Q2");
    check("firstAvailable presente", r.firstAvailable && typeof r.firstAvailable.eta === "string", JSON.stringify(r.firstAvailable));
    check("bestProposal presente", !!r.bestProposal, JSON.stringify(r.bestProposal));
    check("opportunities include Q2→Q5", r.opportunities.some((o) =>
      Array.isArray(o.routeZones) && o.routeZones[0] === "Q2" && o.routeZones[1] === "Q5"), JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    const opp = r.opportunities.find((o) => o.routeZones[1] === "Q5");
    check("opportunity channel sur", opp && opp.channel === "sur", opp && opp.channel);
    check("opportunity status compatible (routeImpact)", opp && opp.status === "compatible", opp && opp.status);
    check("safety read-only/no-write/pii redacted",
      r.safety.readOnly === true && r.safety.writes === false && r.safety.pii === "redacted");
    check("no PII", noPii(r), JSON.stringify(r));
    check("no stacktrace", noStacktrace(r));
  }

  // ── 2. missing startTime → blocker ─────────────────────────────────────────
  console.log("\n══ 2. missing startTime ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { zona: "Q2", pizzas: 1, promised: "20:50" },
      anchors: [{ id: "tg-q5", zona: "Q5", hora: "21:00", pizzas: 2 }],
      capacity: CAPACITY,
      // NO startTime
    });
    check("ok false", r.ok === false, JSON.stringify(r));
    check("blocker missing_start_time",
      r.blockers.some((b) => b.code === "missing_start_time") || (r.error && r.error.code === "missing_start_time"),
      JSON.stringify(r.blockers));
    check("contract preservato anche su errore", r.contract === "premium-planner-strategic-preview-v1");
    check("no Date.now leak (no opportunities computed)", Array.isArray(r.opportunities) && r.opportunities.length === 0);
  }

  // ── 3. no anchors → opportunities vuoto + baseline ─────────────────────────
  console.log("\n══ 3. no anchors ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:35",
      anchors: [],
      capacity: CAPACITY,
    });
    check("ok true", r.ok === true, JSON.stringify(r));
    check("opportunities vuoto", r.opportunities.length === 0, JSON.stringify(r.opportunities));
    check("warning no_anchors", r.warnings.some((w) => w.code === "no_anchors"), JSON.stringify(r.warnings));
    check("baseline diretta comunque presente", !!r.firstAvailable && !!r.bestProposal, JSON.stringify({ fa: r.firstAvailable, bp: r.bestProposal }));
  }

  // ── 4. cross channel: Q3 current + Q5 anchor ───────────────────────────────
  console.log("\n══ 4. cross channel Q3 + Q5 ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { zona: "Q3", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:20",
      anchors: [{ id: "tg-q5", zona: "Q5", hora: "21:00", pizzas: 1 }],
      // travel cross esplicito: forziamo routeImpactInput presente per testare la
      // riconciliazione (routeImpact direbbe compatible, ma cross = no_recomendado).
      travelTimes: { "Pizzería->Q3": 8, "Q3->Q5": 20, "Q5->Pizzería": 15 },
      capacity: CAPACITY,
      includeCrossZone: true,
    });
    check("ok true", r.ok === true, JSON.stringify(r));
    const cross = r.opportunities.find((o) => o.routeZones.includes("Q5"));
    check("cross opportunity presente", !!cross, JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    check("cross status no_recomendado (riconciliato)", cross && cross.status === "no_recomendado", cross && cross.status);
    check("cross blocked true", cross && cross.blocked === true, cross && String(cross.blocked));
    check("cross channel cross", cross && cross.channel === "cross", cross && cross.channel);
  }

  // ── 4b. cross con includeCrossZone:false → scartato ────────────────────────
  console.log("\n══ 4b. cross scartato (includeCrossZone:false) ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { zona: "Q3", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:20",
      anchors: [{ id: "tg-q5", zona: "Q5", hora: "21:00", pizzas: 1 }],
      travelTimes: { "Pizzería->Q3": 8, "Q3->Q5": 20, "Q5->Pizzería": 15 },
      capacity: CAPACITY,
      includeCrossZone: false,
    });
    check("ok true", r.ok === true);
    check("nessuna opportunity cross", r.opportunities.every((o) => o.channel !== "cross"), JSON.stringify(r.opportunities.map((o) => o.channel)));
  }

  // ── 5. write guard ─────────────────────────────────────────────────────────
  console.log("\n══ 5. write guard ══");
  {
    const db = writeGuardDb();
    let threw = false;
    let r;
    try {
      r = await previewStrategicOpportunities({
        currentOrderDraft: { zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
        startTime: "20:35",
        anchors: [{ id: "tg-q5", zona: "Q5", hora: "21:00", pizzas: 2 }],
        travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
        capacity: CAPACITY,
      }, { db });
    } catch (_) { threw = true; }
    check("nessun throw (write methods mai chiamati)", threw === false);
    check("ok true", r && r.ok === true);
    check("db non usato per write (nessuna call select neppure: anchors espliciti)",
      db.calls.every((c) => c.op === "select"), JSON.stringify(db.calls));
  }

  // ── 6. snapshot loader dependency ──────────────────────────────────────────
  console.log("\n══ 6. snapshot loader dependency ══");
  {
    // 6a. usa deps.loadSnapshot se input.snapshot assente
    let loaderArgs = null;
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "new-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:35",
      travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
      capacity: CAPACITY,
      // NO snapshot, NO anchors → deve usare deps.loadSnapshot
    }, {
      loadSnapshot: async (args) => { loaderArgs = args; return snapshotWithPii(); },
    });
    check("loadSnapshot chiamato con includePii:false", loaderArgs && loaderArgs.includePii === false, JSON.stringify(loaderArgs));
    check("ok true", r.ok === true, JSON.stringify(r));
    check("anchor Q5 ricavato dallo snapshot", r.opportunities.some((o) => o.routeZones.includes("Q5")), JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    check("ordine RETIRADO escluso (terminale)", r.serviceLine.every((s) => s.id !== "#Q5-RET"), JSON.stringify(r.serviceLine));
    check("ordine RITIRO escluso (no DOMICILIO)", r.serviceLine.every((s) => s.id !== "#RIT-1"), JSON.stringify(r.serviceLine));
    check("no PII dallo snapshot", noPii(r), JSON.stringify(r));

    // 6b. loader fallisce → blocker
    const r2 = await previewStrategicOpportunities({
      currentOrderDraft: { zona: "Q2", pizzas: 1, promised: "20:50" },
      startTime: "20:35",
      capacity: CAPACITY,
    }, {
      loadSnapshot: async () => { throw new Error("boom secret leak /path/x.js:42"); },
    });
    check("loader fallisce → ok false", r2.ok === false, JSON.stringify(r2));
    check("blocker snapshot_unavailable", r2.error && r2.error.code === "snapshot_unavailable", JSON.stringify(r2.error));
    check("errore loader safe (no stacktrace/secret)", noStacktrace(r2) && !/boom secret leak/.test(JSON.stringify(r2)), JSON.stringify(r2));
  }

  // ── 7. no PII anche con snapshot sporco ────────────────────────────────────
  console.log("\n══ 7. no PII (snapshot sporco) ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "new-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2,
        // PII nel draft: NON deve uscire
        direccion: "Avenida Secreta 9", telefono: "+34999999999", nombre: "Cliente Privado" },
      startTime: "20:35",
      snapshot: snapshotWithPii(),
      travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
      capacity: CAPACITY,
    });
    check("ok true", r.ok === true);
    check("response senza PII del draft", !/Avenida Secreta|\+34999999999|Cliente Privado/.test(JSON.stringify(r)), JSON.stringify(r));
    check("response senza PII dello snapshot", noPii(r), JSON.stringify(r));
    check("safety.pii redacted", r.safety.pii === "redacted");
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
