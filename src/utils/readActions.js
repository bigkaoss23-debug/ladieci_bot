// ===============================================================
// readActions.js — Authenticated private READ contracts (P0 containment)
// ===============================================================
//
// PURPOSE (2026-07): close the public read exposure. The dashboard used to read
// sensitive tables (storico, ordenes, clientes, conv, wa_msgs, delivery_logs,
// suggerimenti) DIRECTLY from the browser with the public publishable key. Those
// reads now go through the Netlify JWT proxy → here (Railway, service_role).
//
// HARD RULES:
//   - Every export is a FIXED contract: the table, selected columns, accepted
//     filters, ordering and a strict max page size are hardcoded here.
//   - The client NEVER submits a table name, a raw select string, an arbitrary
//     filter, an arbitrary order clause, or raw SQL.
//   - Only explicit validated params are accepted (telefono, id, wa_ids, fecha,
//     limit, …). Invalid params → throw ReadParamError (mapped to HTTP 400).
//   - Read failures → throw ReadBackendError (mapped to HTTP 500). Never leak
//     service-role metadata or secrets.
//   - Role authorization is enforced UPSTREAM at the Netlify proxy allow-lists.
//     This layer is reachable only behind the shared X-Api-Key (trusted proxy).
//
// The rows returned are the RAW Supabase rows the frontend already maps, so
// existing frontend response shapes stay byte-identical after the transport swap.

const { sbSelect } = require("./supabase");

class ReadParamError extends Error {
  constructor(msg) { super(msg); this.name = "ReadParamError"; this.httpStatus = 400; }
}
class ReadBackendError extends Error {
  constructor(msg) { super(msg); this.name = "ReadBackendError"; this.httpStatus = 500; }
}

// ─── validation helpers (internal only) ──────────────────────────
const MAX_LIMIT = 500;
function clampLimit(v, def, max = MAX_LIMIT) {
  if (v === undefined || v === null || v === "") return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new ReadParamError("limit inválido");
  return Math.min(n, max);
}
function validTelefono(v) {
  const s = String(v == null ? "" : v).replace("+", "").trim();
  if (!/^\d{6,15}$/.test(s)) throw new ReadParamError("telefono inválido");
  return s;
}
function validId(v) {
  // Order/message ids are short opaque strings like "#001" or a uuid. Reject
  // anything with PostgREST metacharacters so it can never widen the filter.
  const s = String(v == null ? "" : v).trim();
  if (!s || s.length > 64 || /[,&()=*"'\s]/.test(s)) throw new ReadParamError("id inválido");
  return s;
}
function validFecha(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ReadParamError("fecha inválida (YYYY-MM-DD)");
  return s;
}
const MAX_WA_IDS = 200;
function validWaIds(input) {
  // Accepts an array or a CSV string (querystring transport). Enforces a hard
  // cap BEFORE validation (bounds URL length), a strict per-id format (6-15
  // digits → bounds id length), and removes duplicates.
  const raw = Array.isArray(input)
    ? input
    : String(input == null ? "" : input).split(",").map(s => s.trim()).filter(Boolean);
  if (raw.length === 0) return [];
  if (raw.length > MAX_WA_IDS) throw new ReadParamError(`demasiados wa_ids (max ${MAX_WA_IDS})`);
  const seen = new Set();
  for (const x of raw) {
    const s = String(x == null ? "" : x).trim();
    if (!/^\d{6,15}$/.test(s)) throw new ReadParamError("wa_id inválido en la lista");
    seen.add(s);
  }
  return [...seen];
}

// Small internal wrapper: never leaks the raw error to the client.
async function safeSelect(table, query) {
  try {
    const rows = await sbSelect(table, query);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn(`[readActions] ${table} read failed:`, e?.message || e);
    throw new ReadBackendError("read failed");
  }
}

// ─── FIXED READ CONTRACTS ─────────────────────────────────────────

// Operativo: ordini delle ultime 24h, tutti gli stati (dashboard operatore + rider).
// order ts.desc, limit 100 — identico alla query diretta che sostituisce, così
// la mappatura frontend (api.getOrdenes) resta byte-identica.
async function getOrdenesRecent() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return safeSelect("ordenes", `ts=gte.${since}&order=ts.desc&limit=100`);
}

// WhatsApp: ultimi 100 messaggi (frontend filtra 24h + mappa).
async function getWaMessages() {
  return safeSelect("wa_msgs", "order=ts.desc&limit=100");
}

// Archivio finanziario (Economía). Opz. fecha=YYYY-MM-DD; limit cap 500.
async function getStorico({ fecha, limit } = {}) {
  const f = validFecha(fecha);
  const lim = clampLimit(limit, 500);
  const filtro = f ? `fecha=eq.${f}&` : "";
  return safeSelect("storico", `${filtro}order=ts.desc&limit=${lim}`);
}

// Ordini archiviati/chiusi (Economía live-fallback): estado in (COMPLETADO,RETIRADO).
async function getOrdenesArchivio({ limit } = {}) {
  const lim = clampLimit(limit, 500);
  return safeSelect("ordenes", `estado=in.(COMPLETADO,RETIRADO)&order=ts.desc&limit=${lim}`);
}

// Log dei giri di consegna (Economía). order partito_alle.desc, limit cap 500.
async function getDeliveryLogs({ limit } = {}) {
  const lim = clampLimit(limit, 500);
  return safeSelect("delivery_logs", `order=partito_alle.desc&limit=${lim}`);
}

// Suggerimenti pendenti del bot.
async function getSuggerimenti() {
  return safeSelect("suggerimenti", "stato=eq.pending&order=ts.desc&limit=200");
}

// Conversazioni con ordine confermato (badge dashboard).
async function getConversacionesActivas() {
  return safeSelect("conv", "stato_ordine=eq.confermata&order=ts.desc&limit=200");
}

// Cliente singolo per telefono (Nuevo Pedido). Ritorna la riga o null.
async function getClienteByTelefono({ telefono } = {}) {
  const tel = validTelefono(telefono);
  const rows = await safeSelect("clientes", `tel=eq.${encodeURIComponent(tel)}&limit=1`);
  return rows[0] || null;
}

// Messaggio WA singolo per id (WADettaglio). Ritorna la riga o null.
async function getWaMessageById({ id } = {}) {
  const wid = validId(id);
  const rows = await safeSelect("wa_msgs", `id=eq.${encodeURIComponent(wid)}&limit=1`);
  return rows[0] || null;
}

// Ordine singolo per id (WADettaglio). Ritorna la riga o null.
async function getOrdenById({ id } = {}) {
  const oid = validId(id);
  const rows = await safeSelect("ordenes", `id=eq.${encodeURIComponent(oid)}&limit=1`);
  return rows[0] || null;
}

// Conversazione singola per wa_id (WADettaglio): riga più recente.
async function getConvByWaId({ wa_id } = {}) {
  const wid = validTelefono(wa_id);
  const rows = await safeSelect("conv", `wa_id=eq.${encodeURIComponent(wid)}&order=ts.desc&limit=1`);
  return rows[0] || null;
}

// Chat di più conversazioni in batch (TabPreguntas): solo wa_id + chat.
async function getConvChats({ wa_ids } = {}) {
  const ids = validWaIds(wa_ids);
  if (ids.length === 0) return [];
  const list = ids.map(t => `"${t}"`).join(",");
  return safeSelect("conv", `wa_id=in.(${list})&select=wa_id,chat`);
}

module.exports = {
  ReadParamError,
  ReadBackendError,
  getOrdenesRecent,
  getWaMessages,
  getStorico,
  getOrdenesArchivio,
  getDeliveryLogs,
  getSuggerimenti,
  getConversacionesActivas,
  getClienteByTelefono,
  getWaMessageById,
  getOrdenById,
  getConvByWaId,
  getConvChats,
};
