// ===============================================================
// menuRepository.js — Phase 2A read-only repository (STAGING)
// Reads the dynamic menu catalogue from Supabase. DB reads ONLY.
// No formatting / no prompt logic (that lives in menuAdapter.js).
// Uses the existing privileged backend client (src/utils/supabase.js).
// Never writes. Never reads menu_audit in this phase.
// ===============================================================

const { sbSelect } = require("../utils/supabase");

// Recognizable adapter error so callers can distinguish menu problems
// from generic failures (never silently swallow malformed catalogue).
class MenuRepositoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MenuRepositoryError";
    this.code = code || "MENU_REPO_ERROR";
  }
}

const MENU_TABLES = [
  "menu_categorias",
  "menu_productos",
  "menu_extras",
  "menu_producto_extras",
  "menu_aliases",
];

// Deterministic ordering pushed to PostgREST so results are stable.
const ORDER_BY = {
  menu_categorias: "order=orden.asc,slug.asc",
  menu_productos: "order=orden.asc,legacy_id.asc",
  menu_extras: "order=grupo.asc,orden.asc,legacy_key.asc",
  menu_producto_extras: "order=producto_id.asc,extra_id.asc",
  menu_aliases: "order=alias_normalizado.asc",
};

// Fetch all five tables. `select` is injectable for offline tests.
// Single round per table, in parallel → no N+1. Returns raw arrays.
async function readMenuTables(select = sbSelect) {
  const results = await Promise.all(
    MENU_TABLES.map(async (t) => {
      const rows = await select(t, ORDER_BY[t]);
      if (!Array.isArray(rows)) {
        // sbSelect returns text/object on REST error → treat as failure.
        throw new MenuRepositoryError(
          `menu read failed for ${t} (non-array response)`,
          "MENU_READ_FAILED"
        );
      }
      return [t, rows];
    })
  );
  const out = {};
  for (const [t, rows] of results) out[t] = rows;
  return out;
}

module.exports = { readMenuTables, MenuRepositoryError, MENU_TABLES };
