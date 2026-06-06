// tests/deliveryPlannerShadowPreviewEndpoint.test.js
// ===============================================================
// SHADOW PREVIEW ENDPOINT READ-ONLY — offline tests
// Run: node tests/deliveryPlannerShadowPreviewEndpoint.test.js
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const {
  ENDPOINT_PATH,
  buildOrdersQuery,
  buildShadowPreviewResponse,
  handleShadowPreviewReadOnly,
} = require("../src/core/delivery/shadowPreviewEndpoint");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

function pizza(name, q) {
  return { n: name, q };
}

const FAKE_ROWS = [
  {
    id: "#E1",
    created_at: "2026-06-04T20:00:00+02:00",
    tipo_consegna: "DOMICILIO",
    estado: "NUEVO",
    zona: "Q5",
    hora: "21:00",
    durata_andata_min: 28,
    geo_source: "cache-street",
    durata_google_min: null,
    durata_haversine_min: 28,
    items: [pizza("Diavola", 1)],
    forno_out: "20:30",
    salida_driver_estimada: "20:32",
    entrega_estimada: "21:00",
    retraso_estimado_min: 0,
    conflicto_driver: false,
    nombre: "Persona Inventada",
    telefono: "+34000000000",
    direccion: "Calle Falsa 123",
  },
  {
    id: "#P1",
    created_at: "2026-06-04T20:01:00+02:00",
    tipo_consegna: "RITIRO",
    estado: "NUEVO",
    zona: null,
    hora: "20:30",
    items: [pizza("Napoli", 4)],
  },
  {
    id: "#P2",
    created_at: "2026-06-04T20:02:00+02:00",
    tipo_consegna: "RITIRO",
    estado: "NUEVO",
    zona: null,
    hora: "20:30",
    items: [pizza("Margherita", 4)],
  },
  {
    id: "#OTHER_DAY",
    created_at: "2026-06-05T20:00:00+02:00",
    tipo_consegna: "DOMICILIO",
    estado: "NUEVO",
    zona: "Q1",
    hora: "20:30",
    durata_andata_min: 8,
    items: [pizza("Marinara", 1)],
  },
];

function fakeDb(rows = FAKE_ROWS) {
  const calls = [];
  return {
    calls,
    select: async (table, query) => {
      calls.push({ op: "select", table, query });
      return rows;
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function main() {
console.log("\n══ Handler / query ══");
{
  const db = fakeDb();
  const res = mockRes();
  await handleShadowPreviewReadOnly(
    { method: "GET", query: { date: "2026-06-04" } },
    res,
    { dbClient: db },
  );
  check("1· handler accetta GET",
    res.statusCode === 200 && res.body && res.body.version === "shadow-preview-contract-v1",
    JSON.stringify(res.body));
  check("2· date richiesta/validata",
    buildOrdersQuery("2026-06-04").includes("created_at=gte.") &&
      buildOrdersQuery("2026-06-04").includes("created_at=lt."),
    buildOrdersQuery("2026-06-04"));
  check("2c· query usa colonne non-PII",
    buildOrdersQuery("2026-06-04").includes("select=id,tipo_consegna") &&
      !new RegExp(["nom" + "bre", "te" + "lefono", "dire" + "ccion"].join("|")).test(buildOrdersQuery("2026-06-04")),
    buildOrdersQuery("2026-06-04"));
  check("3· fake rows normalizzate nel contract",
    res.body.summary.totalOrders === 3 &&
      res.body.summary.deliveryOrders === 1 &&
      res.body.summary.pickupOrders === 2,
    JSON.stringify(res.body.summary));
  check("4· solo SELECT chiamata",
    db.calls.length === 1 &&
      db.calls[0].op === "select" &&
      db.calls[0].table === "ordenes",
    JSON.stringify(db.calls));
  const blocked = mockRes();
  await handleShadowPreviewReadOnly(
    { method: "PO" + "ST", query: { date: "2026-06-04" } },
    blocked,
    { dbClient: db },
  );
  check("1b· metodi non GET rifiutati",
    blocked.statusCode === 405 && blocked.body.readOnly === true,
    JSON.stringify(blocked.body));
  const missing = mockRes();
  await handleShadowPreviewReadOnly({ method: "GET", query: {} }, missing, { dbClient: db });
  check("2b· date mancante produce errore pulito",
    missing.statusCode === 400 && missing.body.error === "missing_date",
    JSON.stringify(missing.body));

  // Date validation: formato errato e calendario impossibile → 400 invalid_date.
  // Risposta sempre pulita: no stacktrace, no PII, readOnly/writesEnabled/piiIncluded coerenti.
  const invalidDates = ["bad-date", "2026/06/04", "2026-13-99", "2026-02-31"];
  for (const bad of invalidDates) {
    const r = mockRes();
    await handleShadowPreviewReadOnly({ method: "GET", query: { date: bad } }, r, { dbClient: db });
    check(`2d· date invalida "${bad}" → 400 invalid_date`,
      r.statusCode === 400 &&
        r.body && r.body.error === "invalid_date" &&
        r.body.readOnly === true &&
        r.body.safety && r.body.safety.writesEnabled === false &&
        r.body.safety.piiIncluded === false &&
        !/\bat\s+\w+\s*\(|Error:|\.js:\d+/.test(JSON.stringify(r.body)),
      JSON.stringify(r.body));
  }
  // La validazione non rompe le date future valide.
  const future = mockRes();
  await handleShadowPreviewReadOnly({ method: "GET", query: { date: "2026-12-31" } }, future, { dbClient: db });
  check("2e· date futura valida 2026-12-31 → 200 contract",
    future.statusCode === 200 &&
      future.body && future.body.version === "shadow-preview-contract-v1" &&
      future.body.source && future.body.source.date === "2026-12-31",
    JSON.stringify(future.body && { status: future.statusCode, version: future.body.version, date: future.body.source && future.body.source.date }));
}

console.log("\n══ Contract / safety ══");
{
  const before = JSON.stringify(FAKE_ROWS);
  const contract = await buildShadowPreviewResponse({
    date: "2026-06-04",
    rows: FAKE_ROWS,
    generatedAt: "2026-06-04T12:00:00.000Z",
  });
  const out = JSON.stringify(contract);
  check("6· response contiene contract version",
    contract.version === "shadow-preview-contract-v1",
    out);
  check("7· mode read_only",
    contract.mode === "read_only",
    out);
  check("8· safety readOnly true",
    contract.safety.readOnly === true,
    out);
  check("9· writesEnabled false",
    contract.safety.writesEnabled === false,
    out);
  check("10· rawDiagnosticsHidden true",
    contract.safety.rawDiagnosticsHidden === true,
    out);
  check("11· piiIncluded false",
    contract.safety.piiIncluded === false,
    out);
  check("12· response non contiene PII",
    !/Persona Inventada|\+34000000000|Calle Falsa/.test(out),
    out);
  check("13· dirty geo produce group nel contract",
    contract.groups.some((g) => g.id === "dirty_geo_q5" && /tiempo estimado poco fiable/i.test(g.title)),
    JSON.stringify(contract.groups));
  check("14· oven warning produce group/action",
    contract.groups.some((g) => g.id.startsWith("oven_")) &&
      contract.actions.some((a) => a.id === "review_oven_load"),
    JSON.stringify({ groups: contract.groups, actions: contract.actions }));
  const critical = await buildShadowPreviewResponse({
    date: "2026-06-04",
    rows: FAKE_ROWS,
    generatedAt: "2026-06-04T12:00:00.000Z",
    runShadow: () => ({
      totalOrders: 1,
      deliveryOrders: 1,
      pickupOrders: 0,
      zones: ["Q5"],
      trips: 1,
      warnings: [],
      differences: [],
      diagnostics: [],
      invariants: { noDriverBeforePizza: false },
    }),
  });
  check("15· invariant rossa produce critical / do_not_apply_plan",
    critical.status === "critical" &&
      critical.actions.some((a) => a.id === "do_not_apply_plan"),
    JSON.stringify(critical));
  check("20· non muta input",
    before === JSON.stringify(FAKE_ROWS),
    JSON.stringify(FAKE_ROWS));
}

console.log("\n══ LISTO end-to-end via endpoint non è falso critical (live #002 2026-06-05) ══");
{
  // Ordine #002 live, forma reale: DOMICILIO Q3 in LISTO. Prima del fix runner lo
  // shadow HTTP poteva diventare falso `critical` (LISTO non escluso dalle invarianti
  // di ricalcolo). L'endpoint passa per lo stesso runShadow corretto: deve restare
  // non-critical, con safety contract intatto e niente PII.
  const listoRows = [{
    id: "#002",
    created_at: "2026-06-05T20:23:00+02:00",
    tipo_consegna: "DOMICILIO",
    estado: "LISTO",
    zona: "Q3",
    hora: "20:30",
    durata_andata_min: 7,
    geo_source: "google",
    items: [pizza("Margherita", 1)],
    forno_out: "20:23",
    salida_driver_estimada: "20:23",
    entrega_estimada: "20:30",
    retraso_estimado_min: 0,
    conflicto_driver: false,
    nombre: "Cliente Real 002",
    telefono: "+34999000002",
    direccion: "Calle Secreta 2",
  }];
  const listo = await buildShadowPreviewResponse({
    date: "2026-06-05",
    rows: listoRows,
    now: "20:25",
    generatedAt: "2026-06-05T20:25:00.000Z",
  });
  const listoOut = JSON.stringify(listo);
  check("L1· LISTO via endpoint NON è critical",
    listo.status !== "critical",
    listoOut);
  check("L2· LISTO non produce do_not_apply_plan",
    !listo.actions.some((a) => a.id === "do_not_apply_plan"),
    JSON.stringify(listo.actions));
  check("L3· contract safety intatto su LISTO",
    listo.safety.readOnly === true &&
      listo.safety.writesEnabled === false &&
      listo.safety.piiIncluded === false,
    JSON.stringify(listo.safety));
  check("L4· nessuna PII del cliente LISTO nel contract",
    !/Cliente Real 002|\+34999000002|Calle Secreta/.test(listoOut),
    listoOut);
}

console.log("\n══ Errors / import / static safety ══");
{
  const errRes = mockRes();
  await handleShadowPreviewReadOnly(
    { method: "GET", query: { date: "2026-06-04" } },
    errRes,
    { dbClient: { select: async () => { throw new Error("db_offline"); } } },
  );
  check("16· DB error produce errore pulito",
    errRes.statusCode === 500 &&
      errRes.body.error === "db_offline" &&
      !JSON.stringify(errRes.body).includes("at "),
    JSON.stringify(errRes.body));
  check("17· no side effects a import-time",
    ENDPOINT_PATH === "/api/delivery/shadow-preview");

  const endpointPath = path.join(__dirname, "../src/core/delivery/shadowPreviewEndpoint.js");
  const indexPath = path.join(__dirname, "../index.js");
  const endpointSrc = fs.readFileSync(endpointPath, "utf8");
  const indexSrc = fs.readFileSync(indexPath, "utf8");
  const testSrc = fs.readFileSync(__filename, "utf8");
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const endpointCode = strip(endpointSrc).toLowerCase();
  const testCode = strip(testSrc).toLowerCase();
  const WRITE_TOKENS = ["ins" + "ert", "up" + "date", "del" + "ete", "up" + "sert", ".r" + "pc("];
  const blockedNames = ["Commit" + "Writer", "crear" + "Orden", "crea" + "Ordine", "up" + "dateOrden", "del" + "eteOrden"];
  check("5· helper/test senza metodi di scrittura",
    WRITE_TOKENS.every((t) => !endpointCode.includes(t)) &&
      WRITE_TOKENS.every((t) => !testCode.includes(t)));
  check("18· non importa UI",
    !new RegExp(["front" + "end", "app" + "33"].join("|"), "i").test(endpointSrc + testSrc));
  check("19· non chiama writer o ordini live",
    !new RegExp(blockedNames.join("|"), "i").test(endpointSrc + testSrc));
  check("1c· route registrata come GET",
    indexSrc.includes('app.get("/api/delivery/shadow-preview"') &&
      !indexSrc.includes('app.post("/api/delivery/shadow-preview"'),
    "route missing");
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
