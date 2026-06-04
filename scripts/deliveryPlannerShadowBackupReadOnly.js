// ===============================================================
// scripts/deliveryPlannerShadowBackupReadOnly.js
// SHADOW MODE — BACKUP SERATA READ-ONLY · task SHADOW-BACKUP-SERATA-SCRIPT-08
// ===============================================================
// Esegue il Delivery Planner rev.5 (via runner shadow) contro le serate REALI già
// archiviate in produzione nella tabella public `backup_serata` (una riga per serata,
// colonna JSON array `ordini`), in SOLA LETTURA.
//
// Differenza vs deliveryPlannerShadowLiveReadOnly.js:
//   • live runner → legge `ordenes` (ordini correnti, estado reale);
//   • questo runner → legge `backup_serata.ordini` (serate archiviate) e le RIGIOCA
//     come MOVIBILE (estado "NUEVO") al now di replay, come la suite multi-snapshot.
//
// HARD READ-ONLY: unico accesso DB = `httpGet` (method "GET"). Nessun metodo di
// scrittura definito/importato. Nessun client write-capable importato. Nessun
// side-effect a import-time (la rete è toccata SOLO nel blocco CLI).
//
// PRIVACY: l'output usa SOLO id ordine / tipo / zona / orari / warning / diff.
// Nessun campo PII (`nombre`, `tel`, `direccion`, note) viene mai stampato: il
// normalize del runner shadow non li propaga e il report non li espone.
//
// REGOLA MADRE: il derivato non alimenta mai il derivato. `forno_out` archiviato è
// usato SOLO come baseline di confronto (mai input → strip nel runner).
// ===============================================================

"use strict";

const { runShadowFromRows } = require("./deliveryPlannerShadowLiveReadOnly");

const BACKUP_TABLE = "backup_serata";
const REPLAY_NOW = "19:00"; // now di replay serale (parità con multi-snapshot AB)

// ── Arg parser ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dates: [], now: REPLAY_NOW, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") args.dates.push(...splitDates(argv[++i]));
    else if (a.startsWith("--date=")) args.dates.push(...splitDates(a.slice(7)));
    else if (a === "--dates") args.dates.push(...splitDates(argv[++i]));
    else if (a.startsWith("--dates=")) args.dates.push(...splitDates(a.slice(8)));
    else if (a === "--now") args.now = argv[++i] || args.now;
    else if (a.startsWith("--now=")) args.now = a.slice(6) || args.now;
  }
  // dedup, mantieni ordine
  args.dates = [...new Set(args.dates)];
  if (args.dates.length === 0) args.error = "missing --date or --dates";
  return args;
}
function splitDates(s) {
  if (!s) return [];
  return String(s).split(",").map((x) => x.trim()).filter((x) => /^\d{4}-\d\d-\d\d$/.test(x));
}

// ── Selezione riga backup_serata (gestione duplicati) ─────────────────────────
// Se più righe per la stessa serata, scegli la PIÙ RICCA (più ordini), e segnala
// l'ambiguità a chi chiama.
function pickRichestRow(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length === 0) return { row: null, ambiguous: false, candidates: 0 };
  const score = (r) => (Array.isArray(r.ordini) ? r.ordini.length : (Number(r.n_ordini) || 0));
  const sorted = [...list].sort((a, b) => score(b) - score(a));
  return { row: sorted[0], ambiguous: list.length > 1, candidates: list.length };
}

function extractOrdini(row) {
  return row && Array.isArray(row.ordini) ? row.ordini : [];
}

// ── Shadow di UNA serata archiviata ───────────────────────────────────────────
// Rigioca gli ordini come MOVIBILE (estado NUEVO). forno_out resta baseline.
function runNightShadow(ordini, opts = {}) {
  const replay = (ordini || []).map((o) => ({ ...o, estado: "NUEVO" }));
  const rep = runShadowFromRows(replay, { date: opts.date || null, now: opts.now || REPLAY_NOW });
  // Proietta SOLO campi safe (niente PII). differences già prive di PII dal runner.
  return {
    date: rep.snapshotDate,
    totalOrders: rep.totalOrders,
    deliveryOrders: rep.deliveryOrders,
    pickupOrders: rep.pickupOrders,
    zones: rep.zones,
    trips: rep.trips,
    riderOverlaps: rep.riderOverlaps,
    warningsCount: rep.warnings.length,
    differencesCount: rep.differences.length,
    invariants: rep.invariants,
    verdict: rep.verdict,
    warnings: rep.warnings,
    differences: rep.differences.map((d) => ({
      orderId: d.orderId, zona: d.zona, type: d.type,
      old: d.old, planner: d.planner, retraso: d.retraso,
      severity: d.severity, reason: d.reason,
    })),
  };
}

// ── Shadow su PIÙ serate (input: [{date, rows}]) ──────────────────────────────
// rows = righe backup_serata per quella data (≥0). Puro/testabile senza rete.
function runBackupShadow(nights, opts = {}) {
  const perDate = [];
  for (const n of nights || []) {
    const { row, ambiguous, candidates } = pickRichestRow(n.rows);
    if (!row) { perDate.push({ date: n.date, found: false }); continue; }
    const rep = runNightShadow(extractOrdini(row), { date: n.date, now: opts.now || REPLAY_NOW });
    if (ambiguous) { rep.ambiguous = true; rep.candidates = candidates; }
    perDate.push(rep);
  }
  const done = perDate.filter((r) => r.found !== false);
  const aggregate = {
    source: "backup_serata.ordini (production, SELECT read-only)",
    read_only: true,
    snapshots: done.length,
    totalOrders: done.reduce((s, r) => s + (r.totalOrders || 0), 0),
    deliveryOrders: done.reduce((s, r) => s + (r.deliveryOrders || 0), 0),
    pickupOrders: done.reduce((s, r) => s + (r.pickupOrders || 0), 0),
    totalDifferences: done.reduce((s, r) => s + (r.differencesCount || 0), 0),
    allGreen: done.length > 0 && done.every((r) => r.verdict === "shadow_ok"),
    verdict: done.length > 0 && done.every((r) => r.verdict === "shadow_ok") ? "shadow_ok" : "shadow_red",
  };
  return { aggregate, perDate };
}

module.exports = {
  BACKUP_TABLE, REPLAY_NOW,
  parseArgs, splitDates, pickRichestRow, extractOrdini,
  runNightShadow, runBackupShadow,
};

// ===============================================================
// CLI READ-ONLY — la rete è toccata SOLO qui.
// ===============================================================
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.log(JSON.stringify({ ok: false, reason: args.error }, null, 2));
    process.exit(1);
  }

  // GET-only client: nessun metodo di scrittura definito o raggiungibile.
  async function httpGet(table, query) {
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!base || !key) {
      const e = new Error("env mancante (SUPABASE_URL/SUPABASE_KEY)");
      e.code = "ENV_MISSING";
      throw e;
    }
    const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
      method: "GET", // SOLA LETTURA
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    if (!res.ok) throw new Error(`GET ${table} → HTTP ${res.status}`);
    return res.json();
  }

  (async () => {
    let result;
    try {
      const nights = [];
      for (const date of args.dates) {
        // legge solo le colonne necessarie (niente PII oltre lo stretto necessario).
        const rows = await httpGet(BACKUP_TABLE, `fecha=eq.${date}&select=fecha,n_ordini,ordini`);
        nights.push({ date, rows: Array.isArray(rows) ? rows : [] });
      }
      result = runBackupShadow(nights, { now: args.now });
      result.executed_live = true;
    } catch (e) {
      result = {
        executed_live: false,
        read_only: true,
        reason: e.code === "ENV_MISSING" ? "env mancante: runner pronto, backup non letto" : `errore lettura: ${e.message}`,
        dates: args.dates,
      };
    }
    console.log(JSON.stringify(result, null, 2));
    const red = result.executed_live && result.aggregate && result.aggregate.verdict === "shadow_red";
    process.exit(red ? 1 : 0);
  })();
}
