// ===============================================================
// supabase.js — Supabase REST helpers
// ===============================================================
// H1A — Security Foundation Block: internally routed through the hardened
// server-side transport (src/utils/supabaseTransport.js — timeout, AbortController,
// normalized error codes, secret/PII-safe logging). The external contract of every
// export below (arguments, return shape, tolerant-JSON-parse behavior) is preserved
// byte-for-byte from the pre-H1A version — see tests/supabaseHelpersRegression.test.js.

const { supabaseRequest } = require('./supabaseTransport');

async function sbFetch(table, method, params = {}) {
  const r = await supabaseRequest({
    resource: table,
    method,
    query: params.query,
    body: params.body ? params.body : undefined,
    prefer: params.prefer,
    operation: `sbFetch:${table}`,
  });
  // Preserves the original tolerant behavior: parsed JSON when possible,
  // otherwise the raw response text (never throws on a non-JSON 2xx/4xx body).
  return r.bodyIsJson ? r.body : r.text;
}

async function sbSelect(table, query = "") {
  return sbFetch(table, "GET", { query: "select=*&" + query });
}

async function sbUpsert(table, data, onConflict = null) {
  return sbFetch(table, "POST", {
    body: data,
    prefer: "return=representation,resolution=merge-duplicates",
    query: onConflict ? `on_conflict=${onConflict}` : undefined
  });
}

async function sbUpdate(table, query, data) {
  return sbFetch(table, "PATCH", { query, body: data });
}

async function sbDelete(table, query) {
  return sbFetch(table, "DELETE", { query });
}

async function sbInsert(table, data, prefer = "return=representation") {
  return sbFetch(table, "POST", { body: data, prefer });
}

async function getConfig() {
  const rows = await sbSelect("config");
  const cfg = {};
  if (Array.isArray(rows)) {
    rows.forEach(r => { cfg[r.chiave] = r.valore; });
  }
  return cfg;
}

// sbRpc — invoke a PostgreSQL function via PostgREST /rest/v1/rpc/<fn>, as the
// backend service-role. Used by the transactional rider trip primitives
// (start_rider_trip / complete_rider_stop / close_rider_trip). Never logs secrets;
// never surfaces raw PostgREST text — callers (src/agents/riderTrip.js) normalize
// the structured {ok,code,...} JSON result.
async function sbRpc(functionName, args = {}) {
  const r = await supabaseRequest({
    resource: `rpc/${functionName}`,
    method: 'POST',
    body: args || {},
    operation: `sbRpc:${functionName}`,
  });
  return { httpStatus: r.status, ok: r.ok, body: r.bodyIsJson ? r.body : null };
}

module.exports = { sbSelect, sbUpsert, sbUpdate, sbDelete, sbInsert, getConfig, sbRpc };
