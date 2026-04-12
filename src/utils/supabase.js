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

async function sbUpsert(table, data) {
  return sbFetch(table, "POST", {
    body: data,
    prefer: "return=representation,resolution=merge-duplicates"
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

module.exports = { sbSelect, sbUpsert, sbUpdate, sbDelete, sbInsert, getConfig };
