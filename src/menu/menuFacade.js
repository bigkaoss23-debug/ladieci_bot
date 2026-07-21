const menuService = require("./menuService");

function toCanonicalShape(result) {
  if (result && result.source === "dynamic" && result.catalogue) {
    return {
      version: result.catalogue.version,
      generatedAt: result.catalogue.generatedAt,
      categorias: result.catalogue.categorias,
      productos: result.catalogue.productos,
      extras: result.catalogue.extras,
      aliases: result.catalogue.aliases,
      cacheMeta: { state: result.cacheState, source: "dynamic", fallbackReason: null },
      legacy: null,
    };
  }

  return {
    version: 1,
    generatedAt: null,
    categorias: [],
    productos: [],
    extras: [],
    aliases: [],
    cacheMeta: { state: "legacy", source: "legacy", fallbackReason: result?.reason || "MENU_READ_FAILED" },
    legacy: result?.legacy || null,
  };
}

async function getCanonicalMenu(service = menuService) {
  if (!service || typeof service.getMenu !== "function") {
    throw new TypeError("canonical menu service is required");
  }
  return toCanonicalShape(await service.getMenu());
}

module.exports = { getCanonicalMenu, toCanonicalShape };
