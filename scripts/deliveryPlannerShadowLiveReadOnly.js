// ===============================================================
// scripts/deliveryPlannerShadowLiveReadOnly.js
// SHADOW MODE LIVE READ-ONLY · task SHADOW-LIVE-SNAPSHOT-READONLY-02
// ===============================================================
// Primo shadow mode su snapshot LIVE/READ-ONLY: legge gli ordini reali dalla
// tabella `ordenes` con SOLA LETTURA (HTTP GET su Supabase REST), normalizza i
// FATTI GREZZI, e li passa al runner shadow esistente (`runShadow`) che esegue il
// Delivery Planner rev.5 PURO. Produce un report JSON su stdout (+ markdown opz.).
//
// HARD READ-ONLY GUARD:
//   • l'UNICO accesso DB è `httpGet` → method "GET". Nessun metodo di scrittura
//     è definito o importato (niente POST/PATCH/DELETE, niente RPC).
//   • nessun import del client live write-capable (`src/utils/supabase.js`).
//   • il core planner resta PURO/offline: questo script NON è importato da runtime.
//   • nessun side-effect a import-time: la rete è toccata SOLO nel blocco CLI.
//
// REGOLA MADRE: il derivato non alimenta mai il derivato. I campi derivati storici
// (`forno_out`, `salida_driver_estimada`, `entrega_estimada`, `retraso_estimado_min`,
// `conflicto_driver`) sono letti SOLO come baseline di confronto, MAI come input.
// ===============================================================

"use strict";

const { runShadow } = require("./deliveryPlannerShadowReadOnly");

// ── Tabella e campi (allineati ai consumer live, sola lettura) ────────────────
const ORDERS_TABLE = "ordenes";

// Esclusioni pizza-count (parità con agentCucina.contaItems / helpers).
function isBevanda(n = "") {
  n = String(n).toLowerCase();
  return ["cerveza", "heineken", "estrella", "peroni", "refresco", "agua", "cola", "coca"].some((k) => n.includes(k));
}
function isDesert(n = "") {
  return String(n).toLowerCase().includes("tiramisu");
}

// n_pizze = somma q degli item che NON sono bevande/dessert/riga consegna.
function countPizzas(items) {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) {
    const name = it && it.n != null ? String(it.n) : "";
    if (name === "Entrega a domicilio") continue;
    if (isBevanda(name) || isDesert(name)) continue;
    n += Number(it && it.q) || 1;
  }
  return n;
}

// ── Normalizza UNA riga DB grezza in un ordine shadow-compatibile ─────────────
// Mantiene SOLO fatti grezzi come input planner. Il campo derivato `forno_out` è
// mappato su `forno_out_db` = BASELINE di confronto (mai input → lo strip lo fa il
// runner). Gli altri derivati storici NON vengono propagati.
function normalizeDbRow(row) {
  const andata = row.durata_andata_min != null ? row.durata_andata_min
    : (row.andata_min != null ? row.andata_min : null);
  return {
    // ── fatti grezzi (input planner) ──
    id: row.id,
    tipo_consegna: row.tipo_consegna,
    estado: row.estado || "NUEVO",          // live: estado reale (freeze reale)
    zona: row.zona != null ? row.zona : null,
    hora: row.hora || null,
    andata_min: andata,
    n_pizze: countPizzas(row.items),
    manual_giro_id: row.manual_giro_id != null ? row.manual_giro_id : null,
    forzado: row.forzado === true,
    forzado_hora: row.forzado_hora || undefined,
    created_at: row.created_at || row.ts || undefined,
    // ── baseline di confronto (MAI input: strip nel runner) ──
    forno_out_db: row.forno_out || null,
  };
}

// ── Costruisce la fixture-snapshot grezza per il runner shadow ────────────────
function buildSnapshotFromRows(rows, opts = {}) {
  const orders = (rows || []).map(normalizeDbRow);
  return {
    fecha: opts.date || null,
    source: "ordenes (live SELECT, read-only)",
    now: opts.now || "19:00",
    manual_giros: opts.manual_giros || [],
    driver: opts.driver || null,
    orders,
  };
}

// ── Esegue lo shadow su righe DB grezze (PURO, testabile senza rete) ──────────
function runShadowFromRows(rows, opts = {}) {
  const fixture = buildSnapshotFromRows(rows, opts);
  const report = runShadow(fixture, { now: fixture.now });
  report.source = fixture.source;
  return report;
}

// ── Arg parser CLI ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { date: null, today: false, limit: 500, now: null, md: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--today") args.today = true;
    else if (a === "--date") args.date = argv[++i] || null;
    else if (a === "--limit") args.limit = Number(argv[++i]) || args.limit;
    else if (a === "--now") args.now = argv[++i] || null;
    else if (a === "--md") args.md = argv[++i] || null;
    else if (a.startsWith("--date=")) args.date = a.slice(7);
    else if (a.startsWith("--limit=")) args.limit = Number(a.slice(8)) || args.limit;
    else if (a.startsWith("--now=")) args.now = a.slice(6);
    else if (a.startsWith("--md=")) args.md = a.slice(5);
  }
  return args;
}

// Data calendario locale di una riga (da created_at ISO o da ts epoch ms).
function rowDate(row) {
  if (typeof row.created_at === "string" && /^\d{4}-\d\d-\d\d/.test(row.created_at)) {
    return row.created_at.slice(0, 10);
  }
  const t = Number(row.ts);
  if (Number.isFinite(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function filterByDate(rows, date) {
  if (!date) return rows;
  return rows.filter((r) => rowDate(r) === date);
}

module.exports = {
  ORDERS_TABLE,
  countPizzas,
  normalizeDbRow,
  buildSnapshotFromRows,
  runShadowFromRows,
  parseArgs,
  rowDate,
  filterByDate,
};

// ===============================================================
// CLI READ-ONLY — la rete è toccata SOLO qui (require.main === module).
// ===============================================================
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  // GET-only client: NESSUN metodo di scrittura definito o raggiungibile.
  async function httpGet(table, query) {
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!base || !key) {
      const e = new Error("env mancante (SUPABASE_URL/SUPABASE_KEY): runner pronto ma live non eseguito");
      e.code = "ENV_MISSING";
      throw e;
    }
    const url = `${base}/rest/v1/${table}?${query}`;
    const res = await fetch(url, {
      method: "GET", // SOLA LETTURA — nessun body, nessuna mutazione
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${table} → HTTP ${res.status}`);
    try { return JSON.parse(text); } catch { return []; }
  }

  (async () => {
    const date = args.today
      ? (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })()
      : args.date;
    const now = args.now
      || new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });

    let liveReport;
    try {
      const rows = await httpGet(ORDERS_TABLE, `select=*&order=ts.desc&limit=${args.limit}`);
      const list = Array.isArray(rows) ? rows : [];
      const dayRows = filterByDate(list, date);
      liveReport = runShadowFromRows(dayRows, { date, now });
      liveReport.read_only = true;
      liveReport.fetched_rows = list.length;
      liveReport.day_rows = dayRows.length;
    } catch (e) {
      liveReport = {
        executed_live: false,
        read_only: true,
        reason: e.code === "ENV_MISSING" ? "env mancante: runner pronto, live non eseguito" : `errore lettura: ${e.message}`,
        date, now,
      };
    }

    const out = JSON.stringify(liveReport, null, 2);
    console.log(out);

    if (args.md && liveReport.snapshotDate !== undefined) {
      // scrittura SOLO su file locale (NON DB) e solo se richiesto esplicitamente.
      const fs = require("fs");
      fs.writeFileSync(args.md, "```json\n" + out + "\n```\n");
    }
    process.exit(liveReport.executed_live === false ? 0 : (liveReport.verdict === "shadow_red" ? 1 : 0));
  })();
}
