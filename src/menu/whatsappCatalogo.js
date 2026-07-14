// ===============================================================
// whatsappCatalogo.js — Phase C: dynamic-catalogue matcher for the
// WhatsApp parser. PURE functions, NO DB, NO LLM, NO env.
//
// Input  = the structured catalogue from menuAdapter.assembleCatalogue()
//          (the same object getMenuCatalogue() returns).
// Output = deterministic resolution of a parsed WhatsApp item to a canonical
//          catalogue product + structured extras, ready to feed the shared
//          normalizeOrderItem() snapshot builder.
//
// The catalogue is the SINGLE source of truth: numbers, classic/fantasy/canonical
// names, aliases (menu_aliases), extras, product↔extra compatibility, disabled
// state and accepted prices all come from Supabase. A future rename (incl. Pizza
// #8) propagates with zero parser-source edits. No hardcoded product data lives
// here — only category-slug→label templates and text normalization.
// ===============================================================

// Catalogue category slug → the legacy `cat` label the rest of the system uses
// (Cocina isExtra, frontend). Template only, not product data.
const SLUG_TO_CAT = {
  pizzas: "Pizzas",
  dessert_pizzas: "Pizzas Dulces",
  desserts: "Postres",
  beverages: "Bebidas",
};

// lowercase, strip diacritics, collapse punctuation/whitespace. Matches the
// `alias_normalizado` convention already stored in menu_aliases.
function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// Build deterministic lookup indexes over the catalogue. Product names come from
// classic + fantasy + canonical + every active alias. A normalized key that maps
// to more than one product is recorded as ambiguous (never silently resolved).
function buildCatalogIndex(catalogue) {
  if (!catalogue || !Array.isArray(catalogue.productos)) {
    throw new Error("buildCatalogIndex: invalid catalogue");
  }
  const productsById = new Map(catalogue.productos.map((p) => [p.id, p]));
  const byNumber = new Map();      // "pizzas #N" → productId
  const nameToIds = new Map();     // normalizedName → Set(productId)
  const extrasByName = new Map();  // normalizedName → Set(extraLegacyKey)
  const extrasByKey = new Map();   // legacyKey → extra

  const addName = (raw, id) => {
    const k = normalizeText(raw);
    if (!k) return;
    if (!nameToIds.has(k)) nameToIds.set(k, new Set());
    nameToIds.get(k).add(id);
  };

  for (const p of catalogue.productos) {
    if (p.categoria === "pizzas" && p.numOficial != null) byNumber.set(String(p.numOficial), p.id);
    addName(p.nombreClasico, p.id);
    addName(p.nombreFantasia, p.id);
    addName(p.nombreCanonico, p.id);
  }
  for (const a of (catalogue.aliases || [])) {
    // prefer the stored normalized alias; fall back to normalizing the alias text
    const k = a.aliasNormalizado ? normalizeText(a.aliasNormalizado) : normalizeText(a.alias);
    if (!k) continue;
    if (!nameToIds.has(k)) nameToIds.set(k, new Set());
    nameToIds.get(k).add(a.productoId);
  }
  for (const e of (catalogue.extras || [])) {
    extrasByKey.set(e.legacyKey, e);
    const k = normalizeText(e.nombre);
    if (!k) continue;
    if (!extrasByName.has(k)) extrasByName.set(k, new Set());
    extrasByName.get(k).add(e.legacyKey);
  }

  return { catalogue, productsById, byNumber, nameToIds, extrasByName, extrasByKey };
}

// Resolve a product from an explicit official number and/or a free-text name.
// Number wins (deterministic). Returns a discriminated result — never guesses
// between ambiguous candidates.
function resolveProduct(index, { name, number } = {}) {
  if (number != null && String(number).trim() !== "") {
    const id = index.byNumber.get(String(number).trim());
    if (!id) return { status: "unknown", by: "number", query: String(number) };
    const p = index.productsById.get(id);
    if (p.disponible === false) return { status: "disabled", product: p };
    return { status: "ok", product: p };
  }
  const key = normalizeText(name);
  if (!key) return { status: "unknown", by: "name", query: name };
  const ids = index.nameToIds.get(key);
  if (!ids || ids.size === 0) return { status: "unknown", by: "name", query: name };
  if (ids.size > 1) {
    const candidates = [...ids].map((id) => index.productsById.get(id).nombreCanonico);
    return { status: "ambiguous", query: name, candidates };
  }
  const p = index.productsById.get([...ids][0]);
  if (p.disponible === false) return { status: "disabled", product: p };
  return { status: "ok", product: p };
}

// Resolve one extra by name/alias, optionally checking compatibility with a
// product (extrasPermitidos). Deterministic; ambiguity is surfaced, not hidden.
function resolveExtra(index, name, product) {
  const key = normalizeText(name);
  if (!key) return { status: "unknown", query: name };
  const keys = index.extrasByName.get(key);
  if (!keys || keys.size === 0) return { status: "unknown", query: name };
  if (keys.size > 1) {
    return { status: "ambiguous", query: name, candidates: [...keys] };
  }
  const legacyKey = [...keys][0];
  const extra = index.extrasByKey.get(legacyKey);
  if (extra.activo === false) return { status: "disabled", extra };
  if (product && Array.isArray(product.extrasPermitidos) && !product.extrasPermitidos.includes(legacyKey)) {
    return { status: "incompatible", extra, product };
  }
  return { status: "ok", extra };
}

// Resolve a full parsed WhatsApp item into a canonical-ready order item.
//
// parsed = { n?, num?, q?, extras?:[names], removed?:[names], nota?/note?, sub? }
//   - `extras`: explicit extra names the interpreter extracted (preferred).
//   - `removed`: explicitly removed base ingredients ("sin cebolla").
//   - the manual note is taken from `nota`/`note` (NEVER echoed into `sub`).
//
// Returns { status:"ok", item, warnings } or { status:"error", reason, detail }.
// On any hard failure (unknown/ambiguous product) it returns an error — the
// caller must NOT fabricate a priced order (fail-safe).
function resolveWhatsappItem(index, parsed = {}) {
  const q = Number(parsed.q) > 0 ? Math.trunc(Number(parsed.q)) : 1;
  const prodRes = resolveProduct(index, { name: parsed.n, number: parsed.num });
  if (prodRes.status !== "ok") {
    return { status: "error", reason: `product_${prodRes.status}`, detail: prodRes };
  }
  const p = prodRes.product;
  const warnings = [];

  // structured extras (explicit names only — never parsed from free text)
  const extras = [];
  let extrasUnitTotal = 0;
  for (const exName of (Array.isArray(parsed.extras) ? parsed.extras : [])) {
    const exRes = resolveExtra(index, exName, p);
    if (exRes.status !== "ok") { warnings.push({ extra: exName, reason: exRes.status }); continue; }
    const e = exRes.extra;
    const existing = extras.find((x) => x.key === e.legacyKey);
    if (existing) { existing.quantity += 1; }
    else extras.push({ key: e.legacyKey, name: e.nombre, price: round2(e.precioDelta), emoji: e.emoji ?? null, quantity: 1 });
  }
  for (const e of extras) extrasUnitTotal += round2(e.price) * e.quantity;
  extrasUnitTotal = round2(extrasUnitTotal);

  const removedIngredients = Array.isArray(parsed.removed) ? parsed.removed.map(String).filter(Boolean) : [];
  const notes = String(parsed.nota ?? parsed.note ?? "").trim();

  const baseUnitPrice = round2(p.precio);
  const finalUnitPrice = round2(baseUnitPrice + extrasUnitTotal);
  // sub = configuration/compatibility text only (extras "+Name"); NEVER the note.
  const sub = extras.map((e) => (e.quantity > 1 ? `+${e.name} ×${e.quantity}` : `+${e.name}`)).join(", ");

  const item = {
    // canonical identity (immutable snapshot inputs for normalizeOrderItem)
    databaseId: p.id,
    productId: p.id,
    legacyId: p.legacyId,
    clave: p.clave,
    num: p.numOficial,
    officialNumber: p.numOficial,
    classicName: p.nombreClasico,
    fantasyName: p.nombreFantasia,
    category: SLUG_TO_CAT[p.categoria] || p.categoria,
    cat: SLUG_TO_CAT[p.categoria] || p.categoria,
    emoji: p.emoji ?? null,
    e: p.emoji ?? null,
    baseIngredients: Array.isArray(p.ingredientesBase) ? p.ingredientesBase.slice() : [],
    extrasPermitidos: Array.isArray(p.extrasPermitidos) ? p.extrasPermitidos.slice() : undefined,
    // structured config
    extras,
    removedIngredients,
    notes,
    // prices (accepted from catalogue; never re-derived later)
    baseUnitPrice,
    extrasUnitTotal,
    finalUnitPrice,
    // legacy fields the orchestrator still reads
    n: p.nombreFantasia,
    p: finalUnitPrice,
    q,
    quantity: q,
    sub,
  };
  return { status: "ok", item, warnings };
}

module.exports = {
  normalizeText,
  buildCatalogIndex,
  resolveProduct,
  resolveExtra,
  resolveWhatsappItem,
  SLUG_TO_CAT,
};
