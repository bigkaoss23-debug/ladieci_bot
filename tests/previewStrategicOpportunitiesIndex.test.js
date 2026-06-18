// tests/previewStrategicOpportunitiesIndex.test.js
// ===============================================================
// Premium Planner dispatcher wiring guard + integration.
// Run: node tests/previewStrategicOpportunitiesIndex.test.js
//
// Boundary:
//   - Part 1 (static): source-inspection di index.js (NON avvia il server, NON
//     tocca DB). Verifica che la action `previewStrategicOpportunities` sia
//     wired read-only, con loadSnapshot closure su createReadOnlyRestDb({sbSelect}),
//     senza writer, senza Date.now, senza apply/manual_giros write.
//   - Part 2 (integration): ricostruisce ESATTAMENTE la stessa deps closure del
//     dispatcher (loadPlannerSnapshot + createReadOnlyRestDb + adapter) con un
//     `sbSelect` FAKE in-memory (niente DB/rete) e prova il comportamento:
//     missing_start_time, loader failure safe, Q2→Q5 nel contract, no PII,
//     no write, same-zone escluso.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { loadPlannerSnapshot } = require("../src/core/delivery/plannerSnapshot");
const { createReadOnlyRestDb } = require("../src/core/delivery/readOnlyRestDb");
const { previewStrategicOpportunities } = require("../src/agents/previewStrategicOpportunities");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

// ── Part 1: index.js wiring (source-inspection) ───────────────────────────────
const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

console.log("\n── index.js previewStrategicOpportunities wiring ──");

check("imports previewStrategicOpportunities adapter",
  /require\(["']\.\/src\/agents\/previewStrategicOpportunities["']\)/.test(src));
check("imports loadPlannerSnapshot",
  /require\(["']\.\/src\/core\/delivery\/plannerSnapshot["']\)/.test(src));
check('dispatches action "previewStrategicOpportunities"',
  /action === ["']previewStrategicOpportunities["']/.test(src));

// Isola il blocco della nuova action per i check mirati.
const actionBlock = (src.match(/action === ["']previewStrategicOpportunities["'][\s\S]*?\} else if/) || [""])[0];
check("calls previewStrategicOpportunities(...) nel blocco",
  /previewStrategicOpportunities\(/.test(actionBlock), actionBlock.slice(0, 80));
check("inietta loadSnapshot closure read-only (loadPlannerSnapshot + createReadOnlyRestDb({sbSelect}))",
  /loadSnapshot:\s*\(args\)\s*=>\s*loadPlannerSnapshot\(\{[\s\S]*?db:\s*createReadOnlyRestDb\(\{\s*sbSelect\s*\}\)[\s\S]*?\}\)/.test(actionBlock),
  actionBlock);
check("NON inietta writer (sbInsert/sbUpdate/sbUpsert/sbDelete) nel blocco",
  !/sb(Insert|Update|Upsert|Delete)/.test(actionBlock), actionBlock);
check("NON inoltra snapshot/anchors dal client (no injection)",
  !/snapshot:\s*sp\.snapshot|anchors:\s*sp\.anchors/.test(actionBlock), actionBlock);
// Strip dei commenti: i check negativi devono guardare il CODICE, non i commenti
// (che legittimamente menzionano "Date.now"/"manual_giros" per spiegare cosa NON si fa).
const actionCode = actionBlock.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
check("NON usa Date.now nel blocco (codice)",
  !/Date\.now/.test(actionCode), actionCode);
check("NON introduce manual_giros write / applyManualGiro nel blocco (codice)",
  !/applyManualGiro|manual_giros/.test(actionCode), actionCode);
check("mappa serviceDate→date",
  /date:\s*sp\.serviceDate\s*\|\|\s*sp\.date/.test(actionBlock), actionBlock);

// Le action pre-esistenti restano intatte.
check("previewOrderPlanner action ancora presente",
  /action === ["']previewOrderPlanner["']/.test(src));
check("unknown action handler invariato (\"unknown action\")",
  /unknown action/.test(src));
check("nessun nuovo app.post non richiesto (un solo /api POST)",
  (src.match(/app\.post\(["']\/api["']/g) || []).length === 1,
  String((src.match(/app\.post\(/g) || []).length) + " app.post totali");

// ── Part 1b: auth gate comune + error hardening (source-inspection) ───────────
// NB: index.js fa app.listen() e lancia scheduler/Supabase/WhatsApp al require →
// non importabile in un test. Come previewOrderPlannerIndex, verifichiamo il
// wiring via ispezione statica della sorgente.
console.log("\n── index.js auth gate + error hardening ──");

// Auth: middleware globale su /api → 401 unauthorized. previewStrategicOpportunities
// vive sotto app.post("/api") quindi EREDITA lo stesso gate (nessuna scorciatoia).
check("auth middleware app.use(\"/api\", …) presente",
  /app\.use\(\s*["']\/api["']\s*,/.test(src));
check("auth gate confronta x-api-key/_k con DASHBOARD_API_KEY",
  /req\.headers\[["']x-api-key["']\]\s*\|\|\s*req\.query\._k/.test(src) && /DASHBOARD_API_KEY/.test(src));
check("auth gate risponde 401 { error: \"unauthorized\" }",
  /status\(401\)\.json\(\{\s*error:\s*["']unauthorized["']\s*\}\)/.test(src));
// L'auth middleware è registrato PRIMA del POST /api handler (ordine express).
check("auth middleware registrato prima di app.post(\"/api\")",
  src.indexOf('app.use("/api"') !== -1 &&
  src.indexOf('app.use("/api"') < src.indexOf('app.post("/api"'),
  `useIdx=${src.indexOf('app.use("/api"')} postIdx=${src.indexOf('app.post("/api"')}`);

// Error hardening: i catch 500 (GET+POST) NON devono ritornare e.message raw.
const fiveHundreds = src.match(/status\(500\)\.json\([^;]*?\)/g) || [];
check("almeno 2 catch 500 presenti (GET + POST)", fiveHundreds.length >= 2, JSON.stringify(fiveHundreds));
check("nessun 500 ritorna e.message/err.message/.stack raw al client",
  fiveHundreds.every((s) => !/e\.message|err\.message|\.stack/.test(s)), JSON.stringify(fiveHundreds));
check("ogni 500 ritorna { error: \"internal_error\" }",
  fiveHundreds.every((s) => /error:\s*["']internal_error["']/.test(s)), JSON.stringify(fiveHundreds));
// Le RISPOSTE 500 (target dell'hardening) non espongono stack/env/token/internals.
// (Lo scope è la risposta d'errore; gli endpoint diagnostici /version espongono
// SOLO metadati Railway whitelistati, non sono qui in oggetto.)
check("i 500 non espongono e.message/.stack/env/token/supabase",
  fiveHundreds.every((s) => !/e\.message|err\.message|\.stack|process\.env|token|apikey|supabase/i.test(s)),
  JSON.stringify(fiveHundreds));
// L'errore controllato unauthorized resta intatto (non sostituito da internal_error).
check("unauthorized controllato preservato", /error:\s*["']unauthorized["']/.test(src));

// ── Part 2: integration con la stessa closure del dispatcher ──────────────────
// Replica ESATTA della deps closure usata in index.js, con sbSelect FAKE.
function dispatcherDeps(sbSelect) {
  return {
    loadSnapshot: (args) => loadPlannerSnapshot({
      ...args,
      db: createReadOnlyRestDb({ sbSelect }),
    }),
  };
}

// sbSelect fake in-memory: nessun DB, nessuna rete. Ritorna ordini (con PII
// grezza) per "ordenes", [] per il resto. Conta le chiamate.
function fakeSbSelect(orders) {
  const calls = [];
  const fn = async (table, query) => {
    calls.push({ table, query });
    if (table === "ordenes") return orders;
    return [];
  };
  return { fn, calls };
}

const FAKE_ORDERS = [
  // Q5 anchor cross-zone (con PII grezza che NON deve uscire dal contract):
  { id: "ord-q5", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q5", hora: "21:00", n_pizze: 2,
    nombre: "Mario PII", telefono: "+34000000000", direccion: "Calle PII 123", wa_id: "34000000000" },
  // Q2 same-zone del current → fuori dalle insertion (A1), ma in serviceLine/rider-busy (FIX_26):
  { id: "ord-q2", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q2", hora: "20:30", n_pizze: 1 },
  // RITIRO → escluso (non DOMICILIO):
  { id: "ord-rit", tipo_consegna: "RITIRO", estado: "NUEVO", zona: null, hora: "20:40", n_pizze: 1 },
  // RETIRADO → escluso (terminale, già da loadPlannerSnapshot):
  { id: "ord-term", tipo_consegna: "DOMICILIO", estado: "RETIRADO", zona: "Q5", hora: "20:00", n_pizze: 1 },
];

const CURRENT = { zona: "Q2", pizzas: 1, promised: "20:50", serviceMin: 2 };

function noPii(obj) {
  return !/Mario PII|\+34000000000|Calle PII 123|34000000000|nombre|telefono|direccion|wa_id/i.test(JSON.stringify(obj));
}
function noStacktrace(obj) {
  return !/\bat\s+\w+\s*\(|Error:|\.js:\d+/.test(JSON.stringify(obj));
}

async function main() {
  // 2.1 — read-only db: createReadOnlyRestDb espone SOLO select (write impossibile).
  console.log("\n── integration: db read-only ──");
  {
    const db = createReadOnlyRestDb({ sbSelect: async () => [] });
    check("db espone select", typeof db.select === "function");
    check("db NON espone insert/update/delete/upsert",
      !db.insert && !db.update && !db.delete && !db.upsert);
  }

  // 2.2 — happy path Q2→Q5 via closure dispatcher + fake sbSelect.
  console.log("\n── integration: happy path Q2→Q5 ──");
  {
    const sb = fakeSbSelect(FAKE_ORDERS);
    const r = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT,
      startTime: "20:35",
      date: "2026-06-07",
    }, dispatcherDeps(sb.fn));

    check("ok true", r.ok === true, JSON.stringify(r).slice(0, 200));
    check("contract premium-planner-strategic-preview-v1", r.contract === "premium-planner-strategic-preview-v1");
    check("source offline-readonly", r.source === "offline-readonly");
    check("opportunities include Q2→Q5",
      r.opportunities.some((o) => o.routeZones[0] === "Q2" && o.routeZones[1] === "Q5"),
      JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    // Senza capacity esplicita la rotta NON deve uscire falsamente lleno
    // (fix null≠0 in classifyCapacity): Q2→Q5 puntuale ⇒ compatible.
    check("Q2→Q5 compatible (routeImpact via closure, capacity assente)",
      r.opportunities.some((o) => o.routeZones[1] === "Q5" && o.status === "compatible"),
      JSON.stringify(r.opportunities.map((o) => ({ z: o.routeZones, s: o.status }))));
    check("Q2→Q5 capacity.state desconocida (non full)",
      r.opportunities.some((o) => o.routeZones[1] === "Q5" && o.capacity.state === "desconocida"),
      JSON.stringify(r.opportunities.map((o) => o.capacity)));
    // FIX_26: same-zone Q2 ORA INCLUSO in serviceLine (occupa il rider), RITIRO/
    // RETIRADO restano esclusi. La consolidazione same-zone resta fuori dalle
    // opportunities (vedi check sotto: nessun [Q2,Q2]).
    {
      const slIds = r.serviceLine.map((s) => s.id);
      check("serviceLine include Q5 + Q2 same-zone (rider busy), esclude RITIRO/RETIRADO (FIX_26)",
        slIds.includes("ord-q5") && slIds.includes("ord-q2") && slIds.length === 2,
        JSON.stringify(r.serviceLine));
    }
    check("nessuna opportunity same-zone [Q2,Q2]",
      !r.opportunities.some((o) => o.routeZones[0] === "Q2" && o.routeZones[1] === "Q2"),
      JSON.stringify(r.opportunities.map((o) => o.routeZones)));
    check("loader chiamato (sbSelect usato) solo in select", sb.calls.length >= 1);
    check("NESSUNA PII nel contract (loadPlannerSnapshot + adapter sanitizzano)", noPii(r), JSON.stringify(r));
    check("nessuno stacktrace", noStacktrace(r));
  }

  // 2.3 — missing startTime → missing_start_time, loader NON chiamato.
  console.log("\n── integration: missing startTime ──");
  {
    const sb = fakeSbSelect(FAKE_ORDERS);
    const r = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT,
      date: "2026-06-07",
      // NO startTime
    }, dispatcherDeps(sb.fn));
    check("ok false", r.ok === false, JSON.stringify(r));
    check("blocker missing_start_time",
      (r.error && r.error.code === "missing_start_time") || r.blockers.some((b) => b.code === "missing_start_time"),
      JSON.stringify(r));
    check("loader NON chiamato (fail-fast, nessuna query DB)", sb.calls.length === 0, `calls=${sb.calls.length}`);
  }

  // 2.4 — loader failure → safe error, no stacktrace/secret.
  console.log("\n── integration: loader failure safe ──");
  {
    const r = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT,
      startTime: "20:35",
      date: "2026-06-07",
    }, dispatcherDeps(async () => { throw new Error("DB exploded token=SECRET /var/secret.js:42"); }));
    check("ok false", r.ok === false, JSON.stringify(r));
    check("blocker snapshot_unavailable", r.error && r.error.code === "snapshot_unavailable", JSON.stringify(r.error));
    check("errore safe (no stacktrace/secret)",
      noStacktrace(r) && !/DB exploded|token=SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
  }

  // 2.5 — write guard: il db read-only non ha metodi write, e nessun write
  // viene mai chiamato (sbSelect fake non espone write).
  console.log("\n── integration: write guard ──");
  {
    const sb = fakeSbSelect(FAKE_ORDERS);
    const r = await previewStrategicOpportunities({
      currentOrderDraft: CURRENT,
      startTime: "20:35",
    }, dispatcherDeps(sb.fn));
    check("ok true", r.ok === true);
    check("solo letture (sbSelect), nessuna write possibile",
      sb.calls.every((c) => typeof c.query === "string"), JSON.stringify(sb.calls.map((c) => c.table)));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
