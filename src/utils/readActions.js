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
const { getEconomiaLedgerAggregate } = require("../closeout/economiaLedgerAggregate");
// N-9 — the ONE window authority. Economía must never resolve a reporting period
// from the browser's clock, and this layer must not grow a second definition of
// one: the resolver lives in economicWindow.js with every other window in the
// system, and is imported, never restated.
const { resolveEconomiaLedgerWindow } = require("../economy/economicWindow");

// SERVICE CLOSEOUT V2 / SLICE 4A vocabulary — mirrors the DB CHECK constraints
// on service_incidents exactly (migrations/2026-08-08_service_closeout_
// incidents_foundation.sql, hardened by SLICE 3.2). Kept here (not imported
// from a shared module) the same way every other fixed-contract validator in
// this file is self-contained — this is a transport-layer allow-list, not a
// second source of truth for the schema.
const INCIDENT_RESOLUTION_STATUSES = ["pending", "acknowledged", "resolved", "superseded"];
const INCIDENT_CATEGORIES = ["informational", "operational", "financial", "integrity", "security"];
const INCIDENT_ACTIONABLE_STATUSES = ["pending", "acknowledged"];

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validUuid(v, label = "id") {
  const s = String(v == null ? "" : v).trim();
  if (!UUID_RE.test(s)) throw new ReadParamError(`${label} inválido`);
  return s;
}
// Accepts a single value or a CSV string, validates every member against the
// fixed vocabulary, dedupes. Empty/undefined input returns null (caller
// decides the default), never an empty-but-present filter.
function validCsvEnum(v, allowed, label) {
  if (v === undefined || v === null || v === "") return null;
  const raw = String(v).split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return null;
  const seen = new Set();
  for (const x of raw) {
    if (!allowed.includes(x)) throw new ReadParamError(`${label} inválido: ${x}`);
    seen.add(x);
  }
  return [...seen];
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
// Legacy IT 'COMPLETATO' rows are the same terminal domain — include during compat.
async function getOrdenesArchivio({ limit } = {}) {
  const lim = clampLimit(limit, 500);
  return safeSelect("ordenes", `estado=in.(COMPLETADO,COMPLETATO,RETIRADO)&order=ts.desc&limit=${lim}`);
}

// S2-7D6E3 — Economía's ONE money source: per-service-session-day ledger totals, built
// by calling the SAME aggregate() the live closeout and the archived serata_summary use
// (see src/closeout/economiaLedgerAggregate.js). Opt. desde/hasta=YYYY-MM-DD (inclusive).
// N-9 — the resolved reporting period, stated on the wire.
//
// WHY. `porGiorno` is keyed by `service_sessions.business_date`, which is a
// Europe/Madrid BUSINESS date (the day turns over at 04:00 Madrid, per
// serviceSchedule.DEFAULT_SCHEDULE.rolloverMin), not a browser calendar date.
// Before N-9 the frontend had no way to know that: it compared those keys
// against `new Date()` midnight in whatever timezone the operator's laptop
// happened to be in, and between 00:00 and 04:00 Madrid it asked for the wrong
// day entirely. Returning the interval the server actually resolved removes the
// guess — the client renders this, it never recomputes it.
async function getEconomiaLedger({ desde, hasta } = {}) {
  const d = validFecha(desde);
  const h = validFecha(hasta);
  try {
    const aggregate = await getEconomiaLedgerAggregate({ desde: d, hasta: h, select: safeSelect });
    // Additive only: every pre-N-9 field is returned byte-identical.
    return { ...aggregate, ...resolveEconomiaLedgerWindow({ desde: d, hasta: h }) };
  } catch (e) {
    if (e instanceof ReadBackendError || e instanceof ReadParamError) throw e;
    console.warn("[readActions] getEconomiaLedger failed:", e?.message || e);
    throw new ReadBackendError("read failed");
  }
}

// SERVICE CLOSEOUT V2 / SLICE 4A — the Admin "Incidencias" backlog. Default
// (resolutionStatus omitted) returns ONLY actionable findings (pending +
// acknowledged) — resolved/superseded are historical, never the default
// view. No snapshot payload is ever returned here (service_incidents itself
// carries no such column; a future dedicated detail endpoint may expose
// service_closeout_snapshots.payload deliberately, this one never does).
// incidentId, when given, short-circuits to a single-row detail lookup
// (returns the row or null) and ignores every other filter.
const SERVICE_INCIDENT_SELECT = [
  "id", "service_session_id", "business_date", "service_kind", "closeout_correlation_id", "snapshot_id",
  "incident_type", "category", "severity", "entity_type", "entity_id", "order_id", "table_session_id", "giro_id", "rider_id",
  "financial_exposure_cents", "detected_at", "detected_by", "auto_resolved",
  "resolution_status", "resolution_type", "resolved_at", "resolved_by", "resolution_note",
  "created_at", "updated_at",
].join(",");

// Best-effort enrichment: attaches each incident's owning attempt's current
// status ('active'/'completed'/'superseded'). A failure here never fails the
// underlying incident list — it just omits the enrichment.
async function attachAttemptStatus(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const ids = [...new Set(rows.map((r) => r.closeout_correlation_id).filter(Boolean))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, attempt_status: null }));
  try {
    const list = ids.map((id) => `"${id}"`).join(",");
    const attempts = await safeSelect(
      "service_closeout_attempts",
      `closeout_correlation_id=in.(${list})&select=closeout_correlation_id,status`,
    );
    const byId = new Map(attempts.map((a) => [a.closeout_correlation_id, a.status]));
    return rows.map((r) => ({ ...r, attempt_status: byId.get(r.closeout_correlation_id) || null }));
  } catch (e) {
    console.warn("[readActions] getServiceIncidents attempt-status enrichment failed (non-fatal):", e?.message || e);
    return rows.map((r) => ({ ...r, attempt_status: null }));
  }
}

async function getServiceIncidents({ resolutionStatus, category, businessDate, serviceSessionId, incidentId, limit } = {}) {
  if (incidentId !== undefined && incidentId !== null && incidentId !== "") {
    const id = validUuid(incidentId, "incidentId");
    const rows = await safeSelect("service_incidents", `id=eq.${encodeURIComponent(id)}&select=${SERVICE_INCIDENT_SELECT}&limit=1`);
    if (!rows[0]) return null;
    const [enriched] = await attachAttemptStatus(rows);
    return enriched;
  }

  const statuses = validCsvEnum(resolutionStatus, INCIDENT_RESOLUTION_STATUSES, "resolutionStatus") || INCIDENT_ACTIONABLE_STATUSES;
  const categories = validCsvEnum(category, INCIDENT_CATEGORIES, "category");
  const bdate = validFecha(businessDate);
  const sid = serviceSessionId ? validUuid(serviceSessionId, "serviceSessionId") : null;
  const lim = clampLimit(limit, 100, 500);

  let filter = `resolution_status=in.(${statuses.join(",")})`;
  if (categories) filter += `&category=in.(${categories.join(",")})`;
  if (bdate) filter += `&business_date=eq.${bdate}`;
  if (sid) filter += `&service_session_id=eq.${encodeURIComponent(sid)}`;
  filter += `&select=${SERVICE_INCIDENT_SELECT}&order=detected_at.desc&limit=${lim}`;

  const rows = await safeSelect("service_incidents", filter);
  return attachAttemptStatus(rows);
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
  getEconomiaLedger,
  getServiceIncidents,
  getDeliveryLogs,
  getSuggerimenti,
  getConversacionesActivas,
  getClienteByTelefono,
  getWaMessageById,
  getOrdenById,
  getConvByWaId,
  getConvChats,
};
