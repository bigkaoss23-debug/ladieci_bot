const { sbSelect } = require("../utils/supabase");

class MenuRepositoryError extends Error {
  constructor(message, code = "MENU_REPOSITORY_ERROR", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "MenuRepositoryError";
    this.code = code;
  }
}

const MENU_TABLES = Object.freeze([
  "menu_categorias",
  "menu_productos",
  "menu_extras",
  "menu_producto_extras",
  "menu_aliases",
]);

const MENU_ORDER = Object.freeze({
  menu_categorias: "order=orden.asc,slug.asc",
  menu_productos: "order=orden.asc,legacy_id.asc",
  menu_extras: "order=grupo.asc,orden.asc,legacy_key.asc",
  menu_producto_extras: "order=producto_id.asc,extra_id.asc",
  menu_aliases: "order=alias_normalizado.asc",
});

async function readMenuTables(select = sbSelect) {
  if (typeof select !== "function") {
    throw new MenuRepositoryError("menu select client is required", "MENU_CLIENT_MISSING");
  }

  try {
    const entries = await Promise.all(MENU_TABLES.map(async (table) => {
      const rows = await select(table, MENU_ORDER[table]);
      if (!Array.isArray(rows)) {
        throw new MenuRepositoryError(`invalid read response for ${table}`, "MENU_READ_INVALID");
      }
      return [table, rows];
    }));
    return Object.fromEntries(entries);
  } catch (error) {
    if (error instanceof MenuRepositoryError) throw error;
    throw new MenuRepositoryError("dynamic menu read failed", "MENU_READ_FAILED", error);
  }
}

module.exports = { MENU_TABLES, MENU_ORDER, MenuRepositoryError, readMenuTables };
