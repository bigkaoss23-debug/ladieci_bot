// ===============================================================
// menuSnapshot.js — Phase 2A snapshot mapper (PREPARED, NOT ACTIVATED)
// Converts a catalogue product + selected extras into an IMMUTABLE
// order-item snapshot. Existing order-creation paths are unchanged;
// this is not wired into runtime in Phase 2A.
//
// Contract: once built, the snapshot must never change if the catalogue
// later changes price / name / number / extra. It is a deep copy + freeze.
// ===============================================================

// product = a structured catalogue product (from menuAdapter)
// opts = { q, extras: [{legacyKey,...}] | [legacyKey], nota, catalogueExtras }
function buildOrderItemSnapshot(product, opts = {}) {
  if (!product) throw new Error("buildOrderItemSnapshot: product required");
  const q = Number(opts.q) > 0 ? Number(opts.q) : 1;

  // resolve selected extras against the catalogue extras list, snapshotting
  // name + price delta at THIS moment (immune to later edits).
  const catExtras = new Map((opts.catalogueExtras || []).map((e) => [e.legacyKey, e]));
  const selected = (opts.extras || []).map((sel) => {
    const key = typeof sel === "string" ? sel : sel.legacyKey;
    const e = catExtras.get(key) || (typeof sel === "object" ? sel : null);
    if (!e) throw new Error(`snapshot: unknown extra '${key}'`);
    return {
      legacyKey: e.legacyKey,
      nombre: e.nombre,
      precioDelta: Number(e.precioDelta),
    };
  });

  const snap = {
    // stable identity
    id: product.legacyId,
    legacy_id: product.legacyId,
    clave: product.clave,
    // display snapshots (immutable at order time)
    n: product.nombreFantasia || product.nombreClasico,
    nombre_fantasia: product.nombreFantasia,
    sub: product.nombreClasico,
    nombre_clasico: product.nombreClasico,
    num: product.numOficial,
    num_oficial: product.numOficial,
    p: Number(product.precio),
    q,
    cat: product.categoria,
    e: product.emoji,
    ing: (product.ingredientesBase || []).slice(),
    alg: (product.alergenos || []).slice(),
    extras: selected,
    nota: opts.nota || "",
  };

  // deep-freeze so nothing can mutate a captured snapshot in memory
  return deepFreeze(snap);
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

// ===============================================================
// Phase A — canonical, immutable order-item snapshot NORMALIZER.
//
// One tolerant builder that accepts ANY runtime item shape already in
// circulation (dynamic frontend item, legacy hardcoded frontend item,
// WhatsApp/parser item, Custom product, unknown historical item) and
// produces a single object carrying BOTH:
//   - the canonical snapshot (snapshotVersion 1, explicit commercial fields)
//   - the legacy fields every current view still reads (id,n,p,sub,q,cat,e,...)
//
// IMMUTABILITY: it only ever copies values already present on the item. It
// NEVER looks up a live catalogue to re-name / re-price an item that already
// carries that value. An optional `opts.catalogue` may ENRICH a newly selected
// product ONLY where an explicit saved field is absent — it can never overwrite
// an accepted value. Output is deep-frozen.
// ===============================================================

class OrderItemValidationError extends Error {
  constructor(msg) { super(msg); this.name = "OrderItemValidationError"; this.validation = true; }
}

const SNAPSHOT_VERSION = 1;

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null);
const nonEmptyStr = (...vals) => {
  for (const v of vals) { if (v !== undefined && v !== null && String(v).trim() !== "") return String(v); }
  return "";
};
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Split a legacy `sub` string ("+Coppa, +Kinder, cortar en 4") into structured
// extra tags and free-text notes — same convention the frontend render uses
// (tokens starting with "+" are extras; the rest is the operational note).
function parseLegacySub(sub) {
  const parts = String(sub || "").split(",").map((s) => s.trim()).filter(Boolean);
  const extraTokens = parts.filter((p) => p.startsWith("+"));
  const noteTokens = parts.filter((p) => !p.startsWith("+"));
  const counts = new Map();
  for (const tok of extraTokens) {
    // strip leading "+" and any trailing "×N" the UI may append
    const name = tok.replace(/^\+/, "").replace(/\s*[×x]\s*\d+\s*$/i, "").trim();
    if (!name) continue;
    const mult = (tok.match(/[×x]\s*(\d+)\s*$/i) || [])[1];
    counts.set(name, (counts.get(name) || 0) + (mult ? Number(mult) : 1));
  }
  const extras = [...counts.entries()].map(([name, quantity]) => ({ name, quantity }));
  return { extras, notes: noteTokens.join(", ") };
}

// Normalize the `extras` field, which may already be a structured array
// (new frontend emission) or must be derived from the legacy `sub` text.
function normalizeExtras(item, ingLookup) {
  let raw = [];
  if (Array.isArray(item.extras)) {
    raw = item.extras.map((e) => {
      if (typeof e === "string") return { name: e, quantity: 1 };
      return {
        key: firstDefined(e.key, e.legacyKey, e.clave) ?? null,
        name: nonEmptyStr(e.name, e.nombre, e.n),
        price: toNum(firstDefined(e.price, e.precio, e.precioDelta, e.prezzo)),
        emoji: firstDefined(e.emoji, e.e) ?? null,
        quantity: toNum(e.quantity ?? e.q) && toNum(e.quantity ?? e.q) > 0 ? Math.trunc(toNum(e.quantity ?? e.q)) : 1,
      };
    });
  } else {
    // derive from legacy sub text (price unknown → enriched from catalogue if available, else 0)
    raw = parseLegacySub(item.sub).extras.map((x) => ({ key: null, name: x.name, price: null, emoji: null, quantity: x.quantity }));
  }
  return raw.map((e) => {
    const enriched = e.price == null && ingLookup ? ingLookup(e.name, e.key) : null;
    const price = e.price != null ? round2(e.price) : (enriched && enriched.price != null ? round2(enriched.price) : 0);
    return {
      key: e.key ?? (enriched ? enriched.key : null) ?? null,
      name: nonEmptyStr(e.name, enriched && enriched.name),
      price,
      emoji: e.emoji ?? (enriched ? enriched.emoji : null) ?? null,
      quantity: e.quantity > 0 ? e.quantity : 1,
    };
  });
}

// Build a small lookup over an optional catalogue's extras (enrich-only).
function makeIngLookup(catalogue) {
  if (!catalogue || !Array.isArray(catalogue.extras)) return null;
  const byKey = new Map(), byName = new Map();
  for (const e of catalogue.extras) {
    const rec = { key: e.legacyKey || e.key || null, name: e.nombre || e.name || "", price: toNum(e.precioDelta ?? e.price), emoji: e.emoji ?? null };
    if (rec.key) byKey.set(rec.key, rec);
    if (rec.name) byName.set(rec.name.toLowerCase(), rec);
  }
  return (name, key) => (key && byKey.get(key)) || (name && byName.get(String(name).toLowerCase())) || null;
}

// Rebuild a backward-compatible readable `sub` string from structured extras
// ONLY, matching the "+Name" convention parsed by existing views.
//
// CANONICAL CONTRACT: `sub` is configuration/compatibility text only. The manual
// operator note lives exclusively in `notes` and must NEVER be echoed into `sub`
// (a note-only item must produce sub="", not sub=notes). Every consumer reads the
// note from `notes`; legacy sub-only items keep their original `sub` verbatim
// (this rebuild only runs when no incoming `sub` is present).
function buildLegacySub(extras) {
  const tags = [];
  for (const e of extras) {
    const label = e.quantity > 1 ? `+${e.name} ×${e.quantity}` : `+${e.name}`;
    tags.push(label);
  }
  return tags.filter(Boolean).join(", ");
}

// A Custom pizza — detected by an explicit flag or the legacy "custom_" id.
function isCustomItem(item) {
  return item.custom === true || String(firstDefined(item.id, item.legacyId, item.legacy_id) ?? "").startsWith("custom_");
}

// Normalize the Custom base identity + accepted price (additive). Copies only
// values already present on the item — never re-prices/re-names from a live
// catalogue. Returns undefined when there is nothing usable to preserve.
function normalizeCustomBase(item) {
  const b = firstDefined(item.customBase, item.custom_base);
  if (!b || typeof b !== "object" || Array.isArray(b)) return undefined;
  const id = firstDefined(b.id, b.key, b.clave, b.legacyKey);
  const name = nonEmptyStr(b.name, b.nombre, b.n);
  const price = toNum(firstDefined(b.price, b.precio, b.p, item.baseUnitPrice));
  const out = {};
  if (id != null) out.id = String(id);
  if (name) out.name = name;
  if (price != null) out.price = round2(price);
  return Object.keys(out).length ? out : undefined;
}

// Preserve the compatibility `_ingredienti` list required by current frontend /
// signature consumers. Accepted fields are copied verbatim (no reprice/rename);
// only a present numeric `prezzo`/`price` is normalized numerically. Unknown but
// valid legacy values are kept. `extras[]` remains the canonical source.
function normalizeCustomIngredients(item) {
  if (!Array.isArray(item._ingredienti)) return undefined;
  return item._ingredienti.map((i) => {
    if (!i || typeof i !== "object" || Array.isArray(i)) return i; // keep scalars/unknown as-is
    const out = { ...i };
    const price = toNum(firstDefined(i.prezzo, i.price));
    if (price != null) { if ("prezzo" in out) out.prezzo = round2(price); else out.price = round2(price); }
    return out;
  });
}

// The canonical normalizer. Never re-prices/re-names an item from the live
// catalogue; `opts.catalogue` only fills gaps for a newly selected product.
function normalizeOrderItem(item, opts = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new OrderItemValidationError("order item must be a non-null object");
  }
  const catalogue = opts.catalogue || null;
  const ingLookup = makeIngLookup(catalogue);

  // quantity
  const qn = toNum(item.quantity ?? item.q);
  const quantity = qn && qn > 0 ? Math.trunc(qn) : 1;

  // identity (all optional — never throw if missing)
  const productId = firstDefined(item.productId, item.databaseId, item.database_id) ?? null;
  const legacyId = firstDefined(item.legacyId, item.legacy_id, item.id) ?? null;
  const legacyKey = firstDefined(item.legacyKey, item.legacy_key, item.clave) ?? null;
  const officialNumber = (() => { const n = toNum(firstDefined(item.officialNumber, item.num, item.num_oficial)); return n == null ? null : n; })();

  // names — classic is the commercial name; fantasy is the nickname/display.
  const classicName = nonEmptyStr(item.classicName, item.nombre_clasico, item.classic, item.nombreClasico, item.n, item.sub && !String(item.sub).includes("+") ? item.sub : "");
  const fantasyName = nonEmptyStr(item.fantasyName, item.nombre_fantasia, item.nombreFantasia, item.n, classicName);
  const category = firstDefined(item.category, item.cat) ?? null;
  const emoji = firstDefined(item.emoji, item.e) ?? null;

  // base ingredients (accept array or comma string)
  const baseIngredients = (() => {
    const src = firstDefined(item.baseIngredients, item.ingredientesBase, item.ing);
    if (Array.isArray(src)) return src.slice();
    if (typeof src === "string" && src.trim()) return src.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
  })();
  const allergens = (() => {
    const src = firstDefined(item.alergenos, item.alg);
    if (Array.isArray(src)) return src.slice();
    if (typeof src === "string" && src.trim()) return src.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
  })();

  // extras (structured) + notes
  const extras = normalizeExtras(item, ingLookup);
  const notes = nonEmptyStr(item.notes, item.nota, Array.isArray(item.extras) ? "" : parseLegacySub(item.sub).notes);
  const removedIngredients = Array.isArray(item.removedIngredients) ? item.removedIngredients.slice()
    : Array.isArray(item.removed) ? item.removed.slice() : [];

  // ── PRICES (never recomputed from live catalogue) ──
  const extrasSumStructured = extras.reduce((s, e) => s + (Number(e.price) || 0) * (e.quantity || 1), 0);
  const finalGiven = toNum(firstDefined(item.finalUnitPrice, item.p, item.precio, item.price));
  const baseGiven = toNum(item.baseUnitPrice);
  const extrasGiven = toNum(item.extrasUnitTotal);

  let baseUnitPrice, extrasUnitTotal, finalUnitPrice;
  if (baseGiven != null && (extrasGiven != null || extras.length >= 0)) {
    // explicit split available (new dynamic emission)
    baseUnitPrice = round2(baseGiven);
    extrasUnitTotal = round2(extrasGiven != null ? extrasGiven : extrasSumStructured);
    finalUnitPrice = finalGiven != null ? round2(finalGiven) : round2(baseUnitPrice + extrasUnitTotal);
  } else if (finalGiven != null) {
    // legacy: only a final unit price `p`. Preserve it as the commercial truth.
    finalUnitPrice = round2(finalGiven);
    extrasUnitTotal = round2(extrasSumStructured); // 0 when extras came from text w/o prices
    baseUnitPrice = round2(finalUnitPrice - extrasUnitTotal); // documented fallback split
  } else {
    throw new OrderItemValidationError(`order item '${classicName || fantasyName || legacyId || "?"}' has no usable price`);
  }
  const lineTotal = round2(finalUnitPrice * quantity);

  // legacy readable variation string. Preserve the original `sub` verbatim when
  // present (legacy/Custom compatibility text); otherwise rebuild from EXTRAS ONLY.
  // The manual note is never part of `sub` (it lives in `notes`).
  const legacySub = (typeof item.sub === "string" && item.sub.trim() !== "") ? item.sub : buildLegacySub(extras);

  const snap = {
    // ── canonical (Phase A) ──
    snapshotVersion: SNAPSHOT_VERSION,
    productId, legacyId, legacyKey, officialNumber,
    classicName, fantasyName, category, emoji,
    quantity,
    baseUnitPrice, extrasUnitTotal, finalUnitPrice, lineTotal,
    baseIngredients,
    extras,
    removedIngredients,
    notes,

    // ── legacy backward-compatible fields (every current view still reads these) ──
    id: legacyId != null ? legacyId : productId,
    databaseId: productId,
    clave: legacyKey,
    num: officialNumber,
    n: fantasyName,               // display/fantasy value expected today
    p: finalUnitPrice,            // final unit price expected today
    q: quantity,
    cat: category,
    e: emoji,
    ing: baseIngredients.join(", "),
    alg: allergens.join(", "),
    extrasPermitidos: Array.isArray(item.extrasPermitidos) ? item.extrasPermitidos.slice() : undefined,
    sub: legacySub,
  };
  if (snap.extrasPermitidos === undefined) delete snap.extrasPermitidos;

  // ── Custom pizza configuration (additive; ONLY for Custom items) ──
  // Preserve `custom`, `customBase` and the compatibility `_ingredienti` list so
  // a Custom order stays semantically identical across the backend round-trip.
  // Normal items are untouched. `extras[]` remains the canonical ingredient source.
  if (isCustomItem(item)) {
    snap.custom = true;
    const cb = normalizeCustomBase(item);
    if (cb) snap.customBase = cb;
    const ci = normalizeCustomIngredients(item);
    if (ci) snap._ingredienti = ci;
  }

  return deepFreeze(snap);
}

module.exports = { buildOrderItemSnapshot, normalizeOrderItem, OrderItemValidationError, SNAPSHOT_VERSION };
