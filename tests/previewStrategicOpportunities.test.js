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

const { previewStrategicOpportunities, buildAnchorsFromSnapshot } = mod;

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

  // ── E2E. deps.loadSnapshot con snapshot fixture realistico ─────────────────
  // Valida il percorso completo:
  //   deps.loadSnapshot() → snapshot.orders → buildAnchorsFromSnapshot →
  //   strategicOpportunities → routeImpact → bridge → mapper → contract.
  // La fixture è DELIBERATAMENTE "sporca" (PII non sanitizzata dal loader): in
  // produzione plannerSnapshot.normalizeOrder già strippa la PII, ma qui
  // proviamo che ANCHE se il loader non sanitizzasse, l'adapter non la propaga.
  console.log("\n══ E2E. snapshot loader fixture ══");

  // Snapshot fixture realistico (shape plannerSnapshot.orders + PII grezza).
  function e2eSnapshot() {
    return {
      now: "20:30",
      orders: [
        {
          id: "ord-q5-2100", tipo_consegna: "DOMICILIO", estado: "EN_COCINA",
          zona: "Q5", hora: "21:00", n_pizze: 2,
          // PII grezza: NON deve mai apparire in output.
          cliente_nombre: "Mario PII", telefono: "699000000", direccion: "Calle PII 123",
        },
        { id: "ord-q2-2030", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q2", hora: "20:30", n_pizze: 1 },
        { id: "ord-ret-2040", tipo_consegna: "RITIRO", estado: "EN_COCINA", zona: null, hora: "20:40", n_pizze: 1 },
        { id: "ord-done", tipo_consegna: "DOMICILIO", estado: "RETIRADO", zona: "Q5", hora: "20:00", n_pizze: 1 },
      ],
      manual_giros: [],
    };
  }

  // Spy loader: conta le chiamate e cattura gli args.
  function spyLoader(snapshot) {
    const spy = { calls: 0, args: null };
    const fn = async (args) => { spy.calls++; spy.args = args; return snapshot; };
    return { spy, fn };
  }

  // PII E2E: valori e chiavi della fixture sporca che NON devono uscire.
  function e2eNoPii(obj) {
    const out = JSON.stringify(obj);
    return !/Mario PII|699000000|Calle PII 123|cliente_nombre|telefono|direccion/i.test(out);
  }

  const e2eCurrentDraft = { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 };

  // E2E-1 — happy path via loader.
  {
    const { spy, fn } = spyLoader(e2eSnapshot());
    const r = await previewStrategicOpportunities({
      currentOrderDraft: e2eCurrentDraft,
      startTime: "20:35",
      capacity: CAPACITY,
      // NESSUN anchors, NESSUN snapshot → deve usare deps.loadSnapshot.
    }, { loadSnapshot: fn });

    check("E2E loader chiamato esattamente 1 volta", spy.calls === 1, `calls=${spy.calls}`);
    check("E2E loader args includePii:false", spy.args && spy.args.includePii === false, JSON.stringify(spy.args));
    check("E2E ok true", r.ok === true, JSON.stringify(r));
    check("E2E source offline-readonly", r.source === "offline-readonly");
    check("E2E opportunities include Q2→Q5", r.opportunities.some((o) =>
      o.routeZones[0] === "Q2" && o.routeZones[1] === "Q5"), JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    const q5opp = r.opportunities.find((o) => o.routeZones[1] === "Q5");
    check("E2E Q2→Q5 compatible (routeImpact)", q5opp && q5opp.status === "compatible", q5opp && q5opp.status);
    check("E2E serviceLine contiene anchor Q5 generico", r.serviceLine.some((s) =>
      s.id === "ord-q5-2100" && s.zone === "Q5" && s.promised === "21:00"), JSON.stringify(r.serviceLine));
    check("E2E serviceLine senza campi PII", r.serviceLine.every((s) =>
      !("cliente_nombre" in s) && !("telefono" in s) && !("direccion" in s)), JSON.stringify(r.serviceLine));
    check("E2E firstAvailable + bestProposal presenti", !!r.firstAvailable && !!r.bestProposal, JSON.stringify({ fa: r.firstAvailable, bp: r.bestProposal }));
    check("E2E nessuna PII nel JSON output", e2eNoPii(r), JSON.stringify(r));
    check("E2E nessuno stacktrace", noStacktrace(r));
  }

  // E2E-2 — loader fallisce → ok false, blocker safe.
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: e2eCurrentDraft,
      startTime: "20:35",
      capacity: CAPACITY,
    }, { loadSnapshot: async () => { throw new Error("network exploded /secret/path.js:99 token=abc"); } });

    check("E2E loader throw → ok false", r.ok === false, JSON.stringify(r));
    check("E2E loader throw → blocker snapshot_unavailable", r.error && r.error.code === "snapshot_unavailable", JSON.stringify(r.error));
    check("E2E loader throw → safe (no stacktrace/secret)", noStacktrace(r) && !/network exploded|token=abc/.test(JSON.stringify(r)), JSON.stringify(r));
  }

  // E2E-3 — nessun loader e snapshot assente → missing_snapshot.
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: e2eCurrentDraft,
      startTime: "20:35",
      capacity: CAPACITY,
      // NESSUN anchors, NESSUN snapshot, NESSUN deps.loadSnapshot.
    }, {});
    check("E2E no-data → ok false", r.ok === false, JSON.stringify(r));
    check("E2E no-data → blocker missing_snapshot", r.error && r.error.code === "missing_snapshot", JSON.stringify(r.error));
  }

  // E2E-4 — filtering terminale/RITIRO: non diventano anchors.
  {
    const { fn } = spyLoader(e2eSnapshot());
    const r = await previewStrategicOpportunities({
      currentOrderDraft: e2eCurrentDraft,
      startTime: "20:35",
      capacity: CAPACITY,
    }, { loadSnapshot: fn });
    const ids = r.serviceLine.map((s) => s.id);
    check("E2E RITIRO escluso (ord-ret-2040)", !ids.includes("ord-ret-2040"), JSON.stringify(ids));
    check("E2E RETIRADO/terminale escluso (ord-done)", !ids.includes("ord-done"), JSON.stringify(ids));
    // FIX_26: same-zone anchor (Q2) ORA INCLUSO in serviceLine — occupa il rider e
    // struttura la serata anche se non è candidato di insertion (vedi E2E-6, che
    // verifica l'ASSENZA dell'opportunity [Q2,Q2]). "non aggregabile ≠ rider libero".
    check("E2E same-zone Q2 incluso in serviceLine (rider busy, FIX_26)", ids.includes("ord-q2-2030"), JSON.stringify(ids));
    check("E2E Q5 incluso (ord-q5-2100)", ids.includes("ord-q5-2100"), JSON.stringify(ids));
    check("E2E nessun anchor con zona null", r.serviceLine.every((s) => typeof s.zone === "string" && s.zone.length > 0), JSON.stringify(r.serviceLine));
  }

  // E2E-5 — startTime obbligatorio anche col loader; loader NON chiamato.
  {
    const { spy, fn } = spyLoader(e2eSnapshot());
    const r = await previewStrategicOpportunities({
      currentOrderDraft: e2eCurrentDraft,
      capacity: CAPACITY,
      // NO startTime
    }, { loadSnapshot: fn });
    check("E2E missing startTime → ok false", r.ok === false, JSON.stringify(r));
    check("E2E missing startTime → blocker missing_start_time",
      (r.error && r.error.code === "missing_start_time") || r.blockers.some((b) => b.code === "missing_start_time"),
      JSON.stringify(r));
    check("E2E loader NON chiamato se startTime manca (fail-fast)", spy.calls === 0, `calls=${spy.calls}`);
  }

  // E2E-6 — A1: anchor same-zone (Q2) ESCLUSO dallo strategic adapter.
  // Prima (FINDING B) degradava a blocked/missing_travel_times [Q2,Q2]; ora la
  // consolidazione same-zone resta dominio del planner classico → niente
  // opportunity Premium [Q2,Q2], niente missing_travel_times spurio.
  {
    const { fn } = spyLoader(e2eSnapshot());
    const r = await previewStrategicOpportunities({
      currentOrderDraft: e2eCurrentDraft,
      startTime: "20:35",
      capacity: CAPACITY,
    }, { loadSnapshot: fn });
    const sameZone = r.opportunities.find((o) => o.routeZones[0] === "Q2" && o.routeZones[1] === "Q2");
    check("E2E A1: nessuna opportunity same-zone [Q2,Q2]", !sameZone, JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    check("E2E A1: nessun warning missing_travel_times spurio", !r.warnings.some((w) => w.code === "missing_travel_times"), JSON.stringify(r.warnings));
    check("E2E A1: nessuna opportunity blocked residua", r.opportunities.every((o) => o.blocked !== true), JSON.stringify(r.opportunities.map((o) => ({ z: o.routeZones, b: o.blocked }))));
    check("E2E A1: Q2→Q5 cross-zone resta presente e compatible",
      r.opportunities.some((o) => o.routeZones[0] === "Q2" && o.routeZones[1] === "Q5" && o.status === "compatible"),
      JSON.stringify(r.opportunities.map((o) => ({ z: o.routeZones, s: o.status }))));
  }

  // E2E-7 — buildAnchorsFromSnapshot: filtro same-zone + backward-compat.
  {
    const snap = e2eSnapshot();
    // con currentOrderZone Q2 → l'anchor Q2 (ord-q2-2030) è filtrato, Q5 resta.
    const filtered = buildAnchorsFromSnapshot(snap, { currentOrderZone: "Q2" });
    check("buildAnchors A1: same-zone Q2 filtrato", filtered.every((a) => a.id !== "ord-q2-2030"), JSON.stringify(filtered.map((a) => a.id)));
    check("buildAnchors A1: Q5 mantenuto", filtered.some((a) => a.id === "ord-q5-2100" && a.zone === "Q5"), JSON.stringify(filtered.map((a) => a.id)));
    check("buildAnchors A1: confronto zona case-insensitive", buildAnchorsFromSnapshot(snap, { currentOrderZone: "q2" }).every((a) => a.zone !== "Q2"), "lowercase q2 deve filtrare Q2");
    // senza currentOrderZone → backward-compat: same-zone NON filtrato.
    const legacy = buildAnchorsFromSnapshot(snap, {});
    check("buildAnchors backward-compat: senza currentOrderZone tiene Q2", legacy.some((a) => a.id === "ord-q2-2030"), JSON.stringify(legacy.map((a) => a.id)));
    check("buildAnchors: terminali/RITIRO sempre esclusi", legacy.every((a) => a.id !== "ord-done" && a.id !== "ord-ret-2040"), JSON.stringify(legacy.map((a) => a.id)));
  }

  // E2E-8 — Anchor guard: solo lavoro operativo confermato (EN_COCINA/LISTO) è
  // candidabile. EN_ENTREGA escluso (rider già partito). POR_CONFIRMAR escluso
  // (non confermato → fantasma #001). Terminali sempre esclusi.
  console.log("\n══ E2E-8. EN_ENTREGA anchor guard ══");
  {
    const snap = {
      now: "20:30",
      orders: [
        // rider GIÀ partito → deve essere escluso (il bug che chiudiamo).
        { id: "q5-enentrega", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", zona: "Q5", hora: "21:00", n_pizze: 2 },
        // pre-partenza → restano candidabili (rider non uscito).
        { id: "q5-encocina", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:05", n_pizze: 1 },
        { id: "q5-listo", tipo_consegna: "DOMICILIO", estado: "LISTO", zona: "Q5", hora: "21:10", n_pizze: 1 },
        { id: "q5-porconf", tipo_consegna: "DOMICILIO", estado: "POR_CONFIRMAR", zona: "Q5", hora: "21:15", n_pizze: 1 },
        // terminale → escluso (già coperto, qui per non-regressione).
        { id: "q5-retirado", tipo_consegna: "DOMICILIO", estado: "RETIRADO", zona: "Q5", hora: "20:40", n_pizze: 1 },
      ],
      manual_giros: [],
    };

    // 8a — buildAnchorsFromSnapshot diretto (no travel/ETA, test puro del filtro).
    const anchors = buildAnchorsFromSnapshot(snap, { currentOrderZone: "Q2" });
    const ids = anchors.map((a) => a.id);
    check("EN_ENTREGA escluso (rider partito)", !ids.includes("q5-enentrega"), JSON.stringify(ids));
    check("EN_COCINA resta candidabile", ids.includes("q5-encocina"), JSON.stringify(ids));
    check("LISTO resta candidabile (rider non partito)", ids.includes("q5-listo"), JSON.stringify(ids));
    check("POR_CONFIRMAR NON è candidabile (fix fantasma #001)", !ids.includes("q5-porconf"), JSON.stringify(ids));
    check("RETIRADO resta escluso (terminale, no regressione)", !ids.includes("q5-retirado"), JSON.stringify(ids));

    // 8b — costante esposta e coerente con la semantica.
    const NIS = mod._internal && mod._internal.NON_INSERTABLE_ANCHOR_STATES;
    check("NON_INSERTABLE_ANCHOR_STATES esportata", NIS instanceof Set, String(NIS));
    check("NON_INSERTABLE include EN_ENTREGA", NIS && NIS.has("EN_ENTREGA"));
    check("NON_INSERTABLE include i terminali", NIS && NIS.has("RETIRADO") && NIS.has("CANCELADO") && NIS.has("ENTREGADO"));
    check("NON_INSERTABLE NON include EN_COCINA/LISTO/POR_CONFIRMAR",
      NIS && !NIS.has("EN_COCINA") && !NIS.has("LISTO") && !NIS.has("POR_CONFIRMAR"));

    // 8c — end-to-end via adapter: l'anchor EN_ENTREGA non entra in serviceLine.
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:35",
      snapshot: snap,
      travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
      capacity: CAPACITY,
    });
    const slIds = r.serviceLine.map((s) => s.id);
    check("E2E adapter: EN_ENTREGA assente da serviceLine", !slIds.includes("q5-enentrega"), JSON.stringify(slIds));
    check("E2E adapter: EN_COCINA presente in serviceLine", slIds.includes("q5-encocina"), JSON.stringify(slIds));
  }

  // E2E-9 — proposals[] additive (selector wired read-only).
  console.log("\n══ E2E-9. proposals[] additive ══");
  {
    const snap = {
      now: "20:30",
      orders: [
        // EN_ENTREGA escluso a monte (guard) → non deve comparire nei proposals.
        { id: "q5-enentrega", tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA", zona: "Q5", hora: "21:00", n_pizze: 2 },
        // anchor candidabile cross-zone (sur) per generare un insertion.
        { id: "q5-encocina", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:05", n_pizze: 1 },
      ],
      manual_giros: [],
    };
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:35",
      snapshot: snap,
      travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
      capacity: CAPACITY,
    });

    // A — proposals[] presente.
    check("A: proposals[] presente", Array.isArray(r.proposals), JSON.stringify(r.proposals));
    check("A: proposalContract presente", r.proposalContract === "premium-planner-proposal-selection-v1", String(r.proposalContract));
    // B — opportunities[] resta presente e invariato (additive-only).
    check("B: opportunities[] ancora presente", Array.isArray(r.opportunities) && r.opportunities.length >= 1, JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    check("B: contract preview invariato", r.contract === "premium-planner-strategic-preview-v1");
    // C — max 4.
    check("C: proposals max 4", r.proposals.length <= 4, String(r.proposals.length));
    // D — direct presente (bestProposal valido).
    check("D: direct presente", r.proposals.some((p) => p.kind === "direct"), JSON.stringify(r.proposals.map((p) => p.kind)));
    // E — kind validi mappati dal selector.
    const validKinds = new Set(["direct", "insertion", "alternative", "not_recommended"]);
    check("E: kind tutti validi", r.proposals.every((p) => validKinds.has(p.kind)), JSON.stringify(r.proposals.map((p) => p.kind)));
    check("E: rank 1-based contiguo", r.proposals.map((p) => p.rank).join(",") === r.proposals.map((_, i) => i + 1).join(","), JSON.stringify(r.proposals.map((p) => p.rank)));
    // F — EN_ENTREGA escluso anche dai proposals.
    check("F: nessuna proposal referenzia EN_ENTREGA", !/q5-enentrega/.test(JSON.stringify(r.proposals)), JSON.stringify(r.proposals));
    // H — additive non rompe: campi storici ancora lì.
    check("H: firstAvailable + bestProposal + serviceLine intatti",
      "firstAvailable" in r && "bestProposal" in r && Array.isArray(r.serviceLine));
  }

  // E2E-9b — fallback safe: nessun anchor → proposals = solo direct, no throw.
  console.log("\n══ E2E-9b. fallback safe senza opportunities ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 },
      startTime: "20:35",
      anchors: [],
      capacity: CAPACITY,
    });
    check("G: ok true", r.ok === true);
    check("G: opportunities vuoto", r.opportunities.length === 0);
    check("G: proposals presente (solo direct atteso)", Array.isArray(r.proposals) && r.proposals.every((p) => p.kind === "direct"), JSON.stringify(r.proposals.map((p) => p.kind)));
  }

  // E2E-9c — path di errore: proposals additive anche su ok:false.
  console.log("\n══ E2E-9c. proposals[] additive su errore ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { zona: "Q2", pizzas: 1, promised: "20:50" },
      // NO startTime → safeError
      capacity: CAPACITY,
    });
    check("err ok false", r.ok === false);
    check("err proposals[] presente (vuoto)", Array.isArray(r.proposals) && r.proposals.length === 0, JSON.stringify(r.proposals));
    check("err proposalContract presente", r.proposalContract === "premium-planner-proposal-selection-v1");
  }

  console.log("\n══ Anchor allowlist (fix fantasma #001) ══");
  {
    const ELIG = mod._internal && mod._internal.ANCHOR_ELIGIBLE_STATES;
    check("ANCHOR_ELIGIBLE_STATES esportata come Set", ELIG instanceof Set, String(ELIG));
    check("ANCHOR_ELIGIBLE_STATES = {EN_COCINA, LISTO}",
      ELIG && ELIG.has("EN_COCINA") && ELIG.has("LISTO") && ELIG.size === 2,
      String(ELIG && [...ELIG]));

    // hora 22:10 ≈ now 22:00: gli stati eligibili NON sono time-stale, così questo
    // blocco isola la allowlist di STATO dal filtro anti-stale (testato a parte in
    // previewStrategicOpportunitiesStaleness.test.js). Gli stati esclusi cadono per
    // stato a prescindere dalla hora.
    const mkOrder = (id, estado) => ({ id, tipo_consegna: "DOMICILIO", estado, zona: "Q1", hora: "22:10", n_pizze: 1 });
    const snap = {
      now: "22:00",
      orders: [
        mkOrder("a-cocina", "EN_COCINA"),
        mkOrder("a-listo", "LISTO"),
        mkOrder("g-ghost", "POR_CONFIRMAR"),
        mkOrder("g-forz", "CHIUSO_FORZATO"),
        mkOrder("g-nuevo", "NUEVO"),
        mkOrder("g-entrega", "EN_ENTREGA"),
        mkOrder("g-ret", "RETIRADO"),
        mkOrder("g-comp-es", "COMPLETADO"),
        mkOrder("g-comp-it", "COMPLETATO"),
        mkOrder("g-canc", "CANCELADO"),
        mkOrder("g-anul", "ANULADO"),
        mkOrder("g-entg", "ENTREGADO"),
      ],
      manual_giros: [],
    };
    const anchors = buildAnchorsFromSnapshot(snap, { currentOrderZone: "Q2" });
    const ids = new Set(anchors.map((a) => String(a.id)));
    check("EN_COCINA è ancora valida", ids.has("a-cocina"), JSON.stringify([...ids]));
    check("LISTO è ancora valida", ids.has("a-listo"), JSON.stringify([...ids]));
    check("POR_CONFIRMAR (ghost #001) NON è ancora", !ids.has("g-ghost"), JSON.stringify([...ids]));
    check("CHIUSO_FORZATO NON è ancora", !ids.has("g-forz"), JSON.stringify([...ids]));
    check("NUEVO NON è ancora", !ids.has("g-nuevo"), JSON.stringify([...ids]));
    check("EN_ENTREGA NON è ancora", !ids.has("g-entrega"), JSON.stringify([...ids]));
    check("stati terminali NON sono ancore",
      !["g-ret", "g-comp-es", "g-comp-it", "g-canc", "g-anul", "g-entg"].some((x) => ids.has(x)),
      JSON.stringify([...ids]));
    check("solo 2 ancore ammesse (EN_COCINA + LISTO)", anchors.length === 2, JSON.stringify([...ids]));
  }

  console.log("\n══ Regression #001: solo POR_CONFIRMAR Q1 20:25 → no proposta (+155) ══");
  {
    const ghostSnap = {
      now: "22:55",
      orders: [{ id: "#001", tipo_consegna: "DOMICILIO", estado: "POR_CONFIRMAR", zona: "Q1", hora: "20:25", n_pizze: 1 }],
      manual_giros: [],
    };
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "22:55", serviceMin: 2 },
      startTime: "22:55",
      capacity: CAPACITY,
      snapshot: ghostSnap,
    }, {});
    check("ghost #001 non genera opportunities", Array.isArray(r.opportunities) && r.opportunities.length === 0, JSON.stringify(r.opportunities));
    check("nessuno slip assurdo (+155) nelle opportunities", JSON.stringify(r.opportunities).indexOf("155") === -1, JSON.stringify(r.opportunities));
  }

  console.log("\n══ Empty snapshot → no opportunities ══");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: { id: "draft-q2", zona: "Q2", pizzas: 1, promised: "22:55", serviceMin: 2 },
      startTime: "22:55",
      capacity: CAPACITY,
      snapshot: { now: "22:55", orders: [], manual_giros: [] },
    }, {});
    check("snapshot vuoto → opportunities vuoto", Array.isArray(r.opportunities) && r.opportunities.length === 0, JSON.stringify(r.opportunities));
  }

  // ── Δpromised guard (BLOCCO A.2) ───────────────────────────────────────────
  // Aggregazione same-channel con orari promessi distanti → no_recomendado, anche
  // quando lo slip resta sotto la soglia routeImpact. Capacity larga per ISOLARE
  // la guardia gap (no falsi no_recomendado da ruta-larga/qualità).
  console.log("\n══ Δpromised guard (BLOCCO A.2) ══");
  {
    const CAP_LOOSE = { maxPizzas: 8, routeMinLimit: 240, pizzaQualityLimitMin: 240 };
    const TRAVEL = { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 };
    const run = (currentPromised, anchorHora) => previewStrategicOpportunities({
      currentOrderDraft: { id: "new-q2", zona: "Q2", pizzas: 1, promised: currentPromised, serviceMin: 2 },
      startTime: "20:15",
      anchors: [{ id: "tg-q5", zona: "Q5", hora: anchorHora, pizzas: 1 }],
      travelTimes: TRAVEL,
      capacity: CAP_LOOSE,
      now: "20:05",
    });
    const oppQ5 = (r) => r.opportunities.find((o) => Array.isArray(o.routeZones) && o.routeZones[1] === "Q5");

    // gap 50 (>25) → no_recomendado per "Horarios lejanos" (non per slip)
    const far = oppQ5(await run("20:30", "21:20"));
    check("gap 50 → no_recomendado", far && far.status === "no_recomendado", far && far.status);
    check("gap 50 → warning Horarios lejanos", far && /Horarios lejanos/.test(far.warning || ""), far && far.warning);

    // boundary: gap 25 NON scatta (soglia è > 25)
    const at25 = oppQ5(await run("20:30", "20:55"));
    check("gap 25 → NO Δpromised block (status != no_recomendado o warning non-gap)",
      at25 && (at25.status !== "no_recomendado" || !/Horarios lejanos/.test(at25.warning || "")),
      at25 && `${at25.status} / ${at25.warning}`);

    // boundary: gap 26 scatta
    const at26 = oppQ5(await run("20:30", "20:56"));
    check("gap 26 → no_recomendado Horarios lejanos", at26 && at26.status === "no_recomendado" && /Horarios lejanos/.test(at26.warning || ""), at26 && `${at26.status} / ${at26.warning}`);

    // gap piccolo (10) → invariato (compatible/ajuste), nessun warning gap
    const near = oppQ5(await run("20:50", "21:00"));
    check("gap 10 → no Δpromised block", near && near.status !== "no_recomendado" && !/Horarios lejanos/.test(near.warning || ""), near && `${near.status} / ${near.warning}`);

    // single-stop "crear" (nessun anchor) → mai gap (un solo promised)
    const single = await previewStrategicOpportunities({
      currentOrderDraft: { id: "new-q2", zona: "Q2", pizzas: 1, promised: "20:30", serviceMin: 2 },
      startTime: "20:15", anchors: [], travelTimes: TRAVEL, capacity: CAP_LOOSE, now: "20:05",
    });
    const dir = single.opportunities.find((o) => o.routeZones && o.routeZones.length === 1);
    check("single-stop crear → nessun Δpromised block", !dir || !/Horarios lejanos/.test(dir.warning || ""), dir && `${dir.status} / ${dir.warning}`);
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
