// src/core/delivery/readOnlyDbAdapter.js
// ===============================================================
// Read-only Supabase adapter for planner preview.
//
// Exposes only `select` and blocks non-allowlisted tables/fields. The Supabase
// client is injected by the caller so tests never touch a real DB.
// ===============================================================
"use strict";

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

const DEFAULT_FIELDS = Object.fromEntries(
  Object.entries(ALLOWED_FIELDS).map(([table, fields]) => [table, [...fields]]),
);

function safeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  e.safe = true;
  return e;
}

function cleanLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  return Math.min(Math.floor(n), 1000);
}

function assertAllowedTable(table) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_FIELDS, table)) {
    throw safeError("table_not_allowed", "table_not_allowed");
  }
}

function normalizeFields(table, fields) {
  assertAllowedTable(table);
  const requested = Array.isArray(fields) && fields.length ? fields : DEFAULT_FIELDS[table];
  const allowed = ALLOWED_FIELDS[table];
  for (const field of requested) {
    if (!allowed.has(field)) throw safeError("field_not_allowed", "field_not_allowed");
  }
  return requested;
}

function applyFilters(query, filters = {}) {
  for (const [field, value] of Object.entries(filters.eq || {})) query = query.eq(field, value);
  for (const [field, value] of Object.entries(filters.neq || {})) query = query.neq(field, value);
  for (const [field, values] of Object.entries(filters.in || {})) query = query.in(field, values);
  return query;
}

function createReadOnlyDbAdapter({ supabase } = {}) {
  return {
    async select(table, query = {}) {
      assertAllowedTable(table);
      if (!supabase || typeof supabase.from !== "function") {
        throw safeError("supabase_client_missing", "supabase_client_missing");
      }

      const fields = normalizeFields(table, query.fields);
      let request = supabase.from(table).select(fields.join(","));
      request = applyFilters(request, query);
      if (query.order && query.order.field) {
        request = request.order(query.order.field, { ascending: query.order.ascending !== false });
      }
      if (typeof request.limit === "function") {
        request = request.limit(cleanLimit(query.limit));
      }

      const result = await request;
      if (result && result.error) throw safeError("db_select_failed", "db_select_failed");
      return Array.isArray(result && result.data) ? result.data : [];
    },
  };
}

module.exports = {
  createReadOnlyDbAdapter,
  _internal: {
    ALLOWED_FIELDS,
    DEFAULT_FIELDS,
    normalizeFields,
  },
};
