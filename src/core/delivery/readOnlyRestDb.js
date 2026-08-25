// src/core/delivery/readOnlyRestDb.js
// ===============================================================
// Read-only REST DB adapter for planner preview (runtime wiring).
//
// Ponte tra index.js (che ha solo l'helper REST `sbSelect(table, queryString)`)
// e plannerSnapshot, che chiama `db.select("ordenes", "select=...&order=...")`
// con una STRINGA REST PostgREST. A differenza di readOnlyDbAdapter (che parla
// object-query + Supabase builder, qui assente), questo adapter:
//   - accetta la queryString REST così com'è e la inoltra invariata a sbSelect;
//   - espone SOLO `select` (nessun write method);
//   - allowlista le tabelle (ordenes, manual_giros);
//   - valida la clausola `select=` per BLOCCARE campi PII e wildcard.
//
// NB: sbSelect antepone sempre `select=*&` alla query. Per questo pretendiamo
// una clausola `select=` esplicita e validata: senza, il `select=*` esporrebbe
// colonne PII. Bloccando wildcard + campi non-allowlist, l'output resta no-PII.
//
// SOLO LETTURA: nessun sbInsert/sbUpdate/sbUpsert/sbDelete, nessun geo_cache.
// ===============================================================
"use strict";

// Allineato a readOnlyDbAdapter.ALLOWED_FIELDS (stesso contratto no-PII).
const ALLOWED_FIELDS = {
  ordenes: new Set([
    "id",
    "tipo_consegna",
    "estado",
    "zona",
    "hora",
    "durata_andata_min",
    "items",
    "manual_giro_id",
    "forzado",
    "forzado_hora",
    "promesa_precisa",
    "created_at",
    "forno_out",
    "salida_driver_estimada",
    "entrega_estimada",
    "retraso_estimado_min",
    "conflicto_driver",
  ]),
  manual_giros: new Set([
    "id",
    "type",
    "order_ids",
    "route_order",
    "block_start",
    "manual_duration_min",
    "created_by_operator",
    "force",
    "hora_ref",
  ]),
};

// Difesa in profondità: anche se non in allowlist, questi sono PII espliciti.
const PII_FIELDS = new Set([
  "nombre",
  "telefono",
  "direccion",
  "direccion_note",
  "wa_id",
  "tel",
]);

function safeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  e.safe = true;
  return e;
}

function assertAllowedTable(table) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_FIELDS, table)) {
    throw safeError("table_not_allowed", "table_not_allowed");
  }
}

// Estrae il valore della clausola `select=` dalla queryString REST.
// Ritorna null se assente.
function extractSelectClause(queryString) {
  const parts = String(queryString || "").split("&");
  for (const part of parts) {
    if (part.startsWith("select=")) return part.slice("select=".length);
  }
  return null;
}

// Normalizza un token campo PostgREST: gestisce alias `a:source` e cast `f::type`.
// Ritorna il nome colonna sottostante (o "*" / "" per casi speciali).
function normalizeFieldToken(token) {
  let t = String(token || "").trim();
  if (!t) return "";
  // alias rename "alias:source" → tieni la source
  if (t.includes(":")) t = t.split(":").pop();
  // cast "field::type" → tieni field
  if (t.includes("::")) t = t.split("::")[0];
  return t.trim();
}

// Valida la clausola select: ogni campo richiesto deve essere nell'allowlist
// della tabella e non PII; wildcard `*` e relazioni embedded `rel(...)` bloccate.
function assertSafeSelect(table, queryString) {
  const clause = extractSelectClause(queryString);
  if (clause == null || clause.length === 0) {
    // Senza select= esplicito, sbSelect userebbe `select=*` → rischio PII.
    throw safeError("select_required", "select_required");
  }
  const allowed = ALLOWED_FIELDS[table];
  for (const raw of clause.split(",")) {
    const field = normalizeFieldToken(raw);
    if (!field) continue;
    if (field === "*" || field.includes("(") || field.includes(")")) {
      throw safeError("select_wildcard_not_allowed", "select_wildcard_not_allowed");
    }
    if (PII_FIELDS.has(field)) {
      throw safeError("pii_field_blocked", "pii_field_blocked");
    }
    if (!allowed.has(field)) {
      throw safeError("field_not_allowed", "field_not_allowed");
    }
  }
}

function createReadOnlyRestDb({ sbSelect } = {}) {
  return {
    async select(table, queryString = "") {
      assertAllowedTable(table);
      if (typeof sbSelect !== "function") {
        throw safeError("sbselect_missing", "sbselect_missing");
      }
      assertSafeSelect(table, queryString);

      let rows;
      try {
        rows = await sbSelect(table, queryString);
      } catch (_) {
        // Non propaghiamo e.message: può contenere URL/secret/PII.
        throw safeError("db_select_failed", "db_select_failed");
      }
      return Array.isArray(rows) ? rows : [];
    },
  };
}

module.exports = { createReadOnlyRestDb };
