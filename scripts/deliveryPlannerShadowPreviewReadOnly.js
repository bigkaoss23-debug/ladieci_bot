// ===============================================================
// scripts/deliveryPlannerShadowPreviewReadOnly.js
// SHADOW PREVIEW INTERNAL READ-ONLY · task 14
// ===============================================================
// Builds an operator-facing preview from backup shadow output.
// The pure path is offline-safe. The CLI path uses GET only.
// ===============================================================
"use strict";

const {
  BACKUP_TABLE,
  REPLAY_NOW,
  splitDates,
  pickRichestRow,
  extractOrdini,
  runNightShadow,
} = require("./deliveryPlannerShadowBackupReadOnly");
const { buildShadowPreviewForOperator } = require("../src/core/delivery/shadowPreview");

function parseArgs(argv) {
  const args = { source: null, dates: [], now: REPLAY_NOW, error: null };
  for (let i = 0; i < (argv || []).length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i] || null;
    else if (a.startsWith("--source=")) args.source = a.slice(9) || null;
    else if (a === "--date") args.dates.push(...splitDates(argv[++i]));
    else if (a.startsWith("--date=")) args.dates.push(...splitDates(a.slice(7)));
    else if (a === "--dates") args.dates.push(...splitDates(argv[++i]));
    else if (a.startsWith("--dates=")) args.dates.push(...splitDates(a.slice(8)));
    else if (a === "--now") args.now = argv[++i] || args.now;
    else if (a.startsWith("--now=")) args.now = a.slice(6) || args.now;
  }
  args.dates = [...new Set(args.dates)];
  if (!args.source) args.error = "missing --source";
  else if (args.source !== "backup") args.error = "unsupported --source";
  else if (args.dates.length === 0) args.error = "missing --date or --dates";
  return args;
}

function flatten(list, key) {
  const out = [];
  for (const item of list || []) {
    const values = item && Array.isArray(item[key]) ? item[key] : [];
    out.push(...values);
  }
  return out;
}

function mergeInvariants(reports) {
  const keys = new Set();
  for (const rep of reports || []) {
    for (const k of Object.keys((rep && rep.invariants) || {})) keys.add(k);
  }
  const out = {};
  for (const k of keys) out[k] = (reports || []).every((rep) => rep && rep.invariants && rep.invariants[k] !== false);
  return out;
}

function aggregateShadowReports(reports) {
  const done = (reports || []).filter((r) => r && r.found !== false);
  const zones = [...new Set(done.flatMap((r) => Array.isArray(r.zones) ? r.zones : []))].sort();
  const warnings = flatten(done, "warnings");
  const differences = flatten(done, "differences");
  const diagnostics = flatten(done, "diagnostics");
  return {
    totalOrders: done.reduce((s, r) => s + (Number(r.totalOrders) || 0), 0),
    deliveryOrders: done.reduce((s, r) => s + (Number(r.deliveryOrders) || 0), 0),
    pickupOrders: done.reduce((s, r) => s + (Number(r.pickupOrders) || 0), 0),
    zones,
    trips: done.reduce((s, r) => s + (Number(r.trips) || 0), 0),
    warnings,
    differences,
    diagnostics,
    invariants: mergeInvariants(done),
  };
}

function runBackupPreviewFromNights(nights, opts = {}) {
  const perDate = [];
  for (const night of nights || []) {
    const picked = pickRichestRow(night.rows);
    if (!picked.row) {
      perDate.push({ date: night.date, found: false });
      continue;
    }
    const rep = runNightShadow(extractOrdini(picked.row), { date: night.date, now: opts.now || REPLAY_NOW });
    if (picked.ambiguous) {
      rep.ambiguous = true;
      rep.candidates = picked.candidates;
    }
    perDate.push(rep);
  }
  const shadow = aggregateShadowReports(perDate);
  const preview = buildShadowPreviewForOperator(shadow);
  return {
    executed_live: opts.executed_live === true,
    read_only: true,
    source: "backup_serata",
    dates: (nights || []).map((n) => n.date).filter(Boolean),
    preview,
  };
}

module.exports = {
  parseArgs,
  aggregateShadowReports,
  runBackupPreviewFromNights,
};

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.log(JSON.stringify({ ok: false, read_only: true, reason: args.error }, null, 2));
    process.exit(1);
  }

  async function httpGet(table, query) {
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!base || !key) {
      const e = new Error("env mancante");
      e.code = "ENV_MISSING";
      throw e;
    }
    const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
      method: "GET",
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    if (!res.ok) throw new Error(`GET ${table} -> HTTP ${res.status}`);
    return res.json();
  }

  (async () => {
    let result;
    try {
      const nights = [];
      for (const date of args.dates) {
        const rows = await httpGet(BACKUP_TABLE, `fecha=eq.${date}&select=fecha,n_ordini,ordini`);
        nights.push({ date, rows: Array.isArray(rows) ? rows : [] });
      }
      result = runBackupPreviewFromNights(nights, { now: args.now, executed_live: true });
    } catch (e) {
      result = {
        executed_live: false,
        read_only: true,
        source: "backup_serata",
        dates: args.dates,
        reason: e.code === "ENV_MISSING" ? "env mancante: preview pronta, backup non letto" : `errore lettura: ${e.message}`,
      };
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.executed_live === false ? 0 : 0);
  })();
}
