// ===============================================================
// supabase.js — Supabase REST helpers
// ===============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function sbHeaders(extra = {}) {
  return {
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json",
    ...extra
  };
}

async function sbFetch(table, method, params = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  const options = { method: method.toUpperCase(), headers: sbHeaders() };

  if (params.query) url += "?" + params.query;
  if (params.prefer) options.headers["Prefer"] = params.prefer;
  if (params.body) options.body = JSON.stringify(params.body);

  const res = await fetch(url, options);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
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
  const url = `${SUPABASE_URL}/rest/v1/rpc/${functionName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: sbHeaders(),
    body: JSON.stringify(args || {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { httpStatus: res.status, ok: res.ok, body };
}

module.exports = { sbSelect, sbUpsert, sbUpdate, sbDelete, sbInsert, getConfig, sbRpc };
