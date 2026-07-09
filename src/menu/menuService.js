// ===============================================================
// menuService.js — Phase 2A wiring (repository + adapter + cache)
// Behind the DYNAMIC_MENU_READ_ENABLED feature gate at the endpoint.
// Provides getMenuCatalogue() for the getMenu action. Read-only.
// ===============================================================

const { readMenuTables } = require("./menuRepository");
const { assembleCatalogue } = require("./menuAdapter");
const { createMenuCache } = require("./menuCache");

const TTL_MS = Number(process.env.DYNAMIC_MENU_TTL_MS) || 120000;

// loader: read live tables → validated structured catalogue (throws on
// malformed data → cache keeps last-good and never caches garbage).
async function loadCatalogue() {
  const raw = await readMenuTables();
  return assembleCatalogue(raw);
}

const cache = createMenuCache({ ttlMs: TTL_MS, loader: loadCatalogue });

// Returns the structured catalogue with internal cache metadata attached.
async function getMenuCatalogue() {
  const { catalogue, meta } = await cache.get();
  return { ...catalogue, cacheMeta: meta };
}

module.exports = { getMenuCatalogue, _cache: cache };
