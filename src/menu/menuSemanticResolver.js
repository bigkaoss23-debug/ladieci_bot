"use strict";

const KIND_ORDER = Object.freeze({ product: 0, category: 1, extra: 2, ingredient_removal: 3 });
const REMOVAL_PREFIX = /^(?:sin|senza|no|quitar|quita|togliere|togli)\s+(.+)$/;

function normalizeMenuText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`´]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function candidate(kind, canonicalId, canonicalName, matchedBy, extra = {}) {
  return { kind, canonicalId: String(canonicalId), canonicalName: String(canonicalName), matchedBy, ...extra };
}

function compareCandidates(a, b) {
  return (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99)
    || a.canonicalName.localeCompare(b.canonicalName, "it", { sensitivity: "base" })
    || a.canonicalId.localeCompare(b.canonicalId);
}

function add(index, key, value) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  const values = index.get(key);
  const existing = values.find((entry) => entry.kind === value.kind && entry.canonicalId === value.canonicalId);
  if (!existing) {
    values.push({ ...value, matchedSources: [value.matchedBy] });
    return;
  }
  existing.matchedSources = [...new Set([...(existing.matchedSources || [existing.matchedBy]), value.matchedBy])].sort();
}

function productName(product) {
  return product.nombreCanonico || product.nombreFantasia || product.nombreClasico || product.clave || product.id;
}

function buildIndex(menu) {
  if (!menu || !Array.isArray(menu.productos) || !Array.isArray(menu.categorias)
      || !Array.isArray(menu.extras) || !Array.isArray(menu.aliases)) {
    throw new TypeError("canonical menu shape is required");
  }

  const text = new Map();
  const emoji = new Map();
  const products = new Map(menu.productos.map((item) => [String(item.id), item]));

  for (const product of menu.productos) {
    const id = product.id;
    const name = productName(product);
    for (const [field, by] of [
      [product.nombreCanonico, "product_name"], [product.nombreFantasia, "product_name"],
      [product.nombreClasico, "product_name"], [product.clave, "product_key"],
    ]) add(text, normalizeMenuText(field), candidate("product", id, name, by));
    if (product.numOficial != null) {
      for (const key of [String(product.numOficial), `pizza ${product.numOficial}`, `numero ${product.numOficial}`, `n ${product.numOficial}`]) {
        add(text, normalizeMenuText(key), candidate("product", id, name, "product_number"));
      }
    }
    if (product.emoji) add(emoji, String(product.emoji).trim(), candidate("product", id, name, "product_emoji"));
  }

  for (const alias of menu.aliases) {
    const product = products.get(String(alias.productoId));
    if (!product) continue;
    add(text, normalizeMenuText(alias.aliasNormalizado || alias.alias),
      candidate("product", product.id, productName(product), "product_alias"));
  }

  for (const category of menu.categorias) {
    const id = category.id || category.slug;
    const name = category.label || category.slug;
    add(text, normalizeMenuText(category.label), candidate("category", id, name, "category_name"));
    add(text, normalizeMenuText(category.slug), candidate("category", id, name, "category_slug"));
    if (category.emoji) add(emoji, String(category.emoji).trim(), candidate("category", id, name, "category_emoji"));
  }

  for (const extra of menu.extras) {
    const id = extra.id || extra.legacyKey;
    const name = extra.nombre || extra.legacyKey;
    add(text, normalizeMenuText(extra.nombre), candidate("extra", id, name, "extra_name"));
    add(text, normalizeMenuText(extra.legacyKey), candidate("extra", id, name, "extra_key"));
    if (extra.emoji) add(emoji, String(extra.emoji).trim(), candidate("extra", id, name, "extra_emoji"));
  }

  const ingredients = new Map();
  for (const product of menu.productos) {
    for (const raw of (Array.isArray(product.ingredientesBase) ? product.ingredientesBase : [])) {
      const key = normalizeMenuText(raw);
      if (!key) continue;
      if (!ingredients.has(key)) ingredients.set(key, { names: new Set(), productIds: new Set() });
      ingredients.get(key).names.add(String(raw));
      ingredients.get(key).productIds.add(String(product.id));
    }
  }

  return { text, emoji, ingredients };
}

function resultFor(rawInput, normalizedInput, matches) {
  const deduplicated = new Map();
  for (const match of matches) {
    const key = `${match.kind}\u0000${match.canonicalId}`;
    const existing = deduplicated.get(key);
    if (!existing) {
      deduplicated.set(key, { ...match, matchedSources: [...new Set(match.matchedSources || [match.matchedBy])].sort() });
      continue;
    }
    existing.matchedSources = [...new Set([
      ...(existing.matchedSources || [existing.matchedBy]),
      ...(match.matchedSources || [match.matchedBy]),
    ])].sort();
  }
  const sorted = [...deduplicated.values()].sort(compareCandidates);
  if (!sorted.length) {
    return { matched: false, kind: null, canonicalId: null, canonicalName: null, matchedBy: null, confidence: "none", ambiguous: false, candidates: [], input: rawInput, normalizedInput };
  }
  if (sorted.length > 1) {
    return { matched: false, kind: null, canonicalId: null, canonicalName: null, matchedBy: "collision", confidence: "none", ambiguous: true, candidates: sorted, input: rawInput, normalizedInput };
  }
  const match = sorted[0];
  return { matched: true, ...match, confidence: "exact", ambiguous: false, candidates: [], input: rawInput, normalizedInput };
}

function resolveMenuReference(input, canonicalMenu) {
  const rawInput = String(input ?? "").trim();
  const normalizedInput = normalizeMenuText(rawInput);
  const index = buildIndex(canonicalMenu);
  const emojiMatches = index.emoji.get(rawInput) || [];
  if (emojiMatches.length) return resultFor(rawInput, normalizedInput, emojiMatches);
  if (!normalizedInput) return resultFor(rawInput, normalizedInput, []);

  const removal = normalizedInput.match(REMOVAL_PREFIX);
  if (removal) {
    const ingredientKey = normalizeMenuText(removal[1]);
    const ingredient = index.ingredients.get(ingredientKey);
    if (!ingredient) return resultFor(rawInput, normalizedInput, []);
    const canonicalName = [...ingredient.names].sort((a, b) => a.localeCompare(b, "it", { sensitivity: "base" }))[0];
    return resultFor(rawInput, normalizedInput, [candidate(
      "ingredient_removal", `ingredient:${ingredientKey}`, canonicalName, "ingredient_removal",
      { productIds: [...ingredient.productIds].sort() }
    )]);
  }

  return resultFor(rawInput, normalizedInput, index.text.get(normalizedInput) || []);
}

module.exports = { resolveMenuReference };
