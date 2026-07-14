// ===============================================================
// whatsappMenuContext.js — Phase C: build the WhatsApp prompt context from
// the DYNAMIC catalogue (getMenuCatalogue), replacing the hardcoded config.js
// MENU_LISTA / ABBINAMENTI_NOMI / inline number map / INFO menu section.
//
// One place fetches the (cache-backed, last-good) catalogue and renders every
// prompt section the interpreter/responder needs, plus the deterministic
// matcher index. A catalogue rename (incl. Pizza #8) propagates automatically.
//
// Fail-safe: if the catalogue cannot be loaded (cold cache + DB down), this
// throws — the parser caller MUST fail closed and never fabricate an order from
// stale hardcoded data.
// ===============================================================

const { getMenuCatalogue } = require("./menuService");
const { renderMenuLista, renderInfoMenuSection, renderAbbinamenti } = require("./menuAdapter");
const { buildCatalogIndex } = require("./whatsappCatalogo");

// "1=El Pelusa, 2=Zizou, ... 14=Pinturicchio" from the live pizzas, by number.
function renderNumeriMenu(cat) {
  return cat.productos
    .filter((p) => p.categoria === "pizzas" && p.numOficial != null)
    .slice()
    .sort((a, b) => a.numOficial - b.numOficial)
    .map((p) => `${p.numOficial}=${p.nombreCanonico}`)
    .join(", ");
}

// Extras the interpreter may recognize, grouped, e.g.
// "SALADOS: Coppa, Salami Napoli · DULCES: Nutella, KitKat, Kinder, Pistacho, Almendra".
function renderExtrasCatalog(cat) {
  const savory = cat.extras.filter((e) => e.grupo !== "sweet").map((e) => e.nombre);
  const sweet = cat.extras.filter((e) => e.grupo === "sweet").map((e) => e.nombre);
  const parts = [];
  if (savory.length) parts.push("SALADOS: " + savory.join(", "));
  if (sweet.length) parts.push("DULCES: " + sweet.join(", "));
  return parts.join(" · ");
}

// Returns the full prompt context + the matcher index. Throws on catalogue
// failure (caller decides the fail-safe behavior).
async function getWhatsappMenuContext() {
  const cat = await getMenuCatalogue(); // cache-backed; throws only on cold+down
  if (!cat || !Array.isArray(cat.productos) || cat.productos.length === 0) {
    throw new Error("whatsapp_menu_context: empty catalogue");
  }
  return {
    catalogue: cat,
    index: buildCatalogIndex(cat),
    menuLista: renderMenuLista(cat),          // array of "N. Fantasia - Clasico price"
    abbinamenti: renderAbbinamenti(cat),      // "alias1/alias2=Canonico, ..."
    numeriMenu: renderNumeriMenu(cat),        // "1=El Pelusa, ..."
    extrasCatalog: renderExtrasCatalog(cat),  // "SALADOS: ... · DULCES: ..."
    infoMenuSection: renderInfoMenuSection(cat),
    cacheMeta: cat.cacheMeta || null,
  };
}

module.exports = { getWhatsappMenuContext, renderNumeriMenu, renderExtrasCatalog };
