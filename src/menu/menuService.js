const { MENU_LISTA, INFO_RISTORANTE, ABBINAMENTI_NOMI } = require("../config");
const { readMenuTables } = require("./menuRepository");
const { assembleCatalogue } = require("./menuAdapter");
const { createMenuCache } = require("./menuCache");

function legacyMenuFallback(reason) {
  return {
    source: "legacy",
    reason,
    catalogue: null,
    legacy: {
      menuLista: MENU_LISTA.slice(),
      infoRistorante: INFO_RISTORANTE,
      abbinamentiNomi: ABBINAMENTI_NOMI,
    },
  };
}

function createMenuReadService({
  readTables = readMenuTables,
  assemble = assembleCatalogue,
  fallback = legacyMenuFallback,
  ttlMs = Number(process.env.DYNAMIC_MENU_TTL_MS) || 120000,
  now,
} = {}) {
  const cache = createMenuCache({
    ttlMs,
    now,
    loader: async () => {
      const catalogue = assemble(await readTables());
      if (!catalogue.productos.length) throw Object.assign(new Error("dynamic menu is empty"), { code: "MENU_EMPTY" });
      return catalogue;
    },
  });

  async function getMenu() {
    try {
      const result = await cache.get();
      return { source: "dynamic", catalogue: result.value, cacheState: result.state };
    } catch (error) {
      return fallback(error.code || "MENU_READ_FAILED");
    }
  }

  return { getMenu, clear: cache.clear };
}

const defaultService = createMenuReadService();
module.exports = { createMenuReadService, getMenu: defaultService.getMenu, legacyMenuFallback };
