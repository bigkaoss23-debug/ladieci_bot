// ===============================================================
// menuAdapter.js — Phase 2A domain transform + renderers (STAGING)
// Pure functions. NO env access, NO DB access, NO prompt to Claude.
// Input = raw table rows (from menuRepository). Output = structured
// catalogue + MENU_LISTA / INFO menu section / ABBINAMENTI equivalents.
// All product data derives from Supabase; only templates are code.
// ===============================================================

class MenuAdapterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MenuAdapterError";
    this.code = code || "MENU_ADAPTER_ERROR";
  }
}

const CONTRACT_VERSION = 1;

function fmtPrice(n) {
  // numeric → "12.00" style used by the legacy MENU_LISTA strings
  return Number(n).toFixed(2);
}
function fmtEuro(n) {
  // "12€" / "12.50€" style used by INFO_RISTORANTE
  const v = Number(n);
  return (Number.isInteger(v) ? String(v) : v.toFixed(2)) + "€";
}

// ── validation: never silently ignore structural corruption ────────
function assertNoDuplicates(rows, key, label) {
  const seen = new Set();
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined) continue;
    if (seen.has(v)) throw new MenuAdapterError(`duplicate ${label}: ${v}`, "DUP_" + label.toUpperCase());
    seen.add(v);
  }
}

// Build the structured catalogue from raw rows. Pure + deterministic.
// opts.includeInactive (default false) keeps inactive rows for future admin.
function assembleCatalogue(raw, opts = {}) {
  const includeInactive = !!opts.includeInactive;
  const generatedAt = opts.now || new Date().toISOString();

  const categoriasRaw = raw.menu_categorias || [];
  const productosRaw = raw.menu_productos || [];
  const extrasRaw = raw.menu_extras || [];
  const mapRaw = raw.menu_producto_extras || [];
  const aliasesRaw = raw.menu_aliases || [];

  // structural integrity (throw, never drop silently)
  assertNoDuplicates(productosRaw, "legacy_id", "legacy_id");
  assertNoDuplicates(productosRaw, "clave", "clave");
  assertNoDuplicates(aliasesRaw, "alias_normalizado", "alias");
  // duplicate official number within a category
  const numByCat = new Set();
  for (const p of productosRaw) {
    if (p.num_oficial == null) continue;
    const k = p.categoria_id + "#" + p.num_oficial;
    if (numByCat.has(k)) throw new MenuAdapterError(`duplicate num_oficial ${p.num_oficial}`, "DUP_NUM");
    numByCat.add(k);
  }

  const catById = new Map(categoriasRaw.map((c) => [c.id, c]));
  const prodById = new Map(productosRaw.map((p) => [p.id, p]));
  const extraById = new Map(extrasRaw.map((e) => [e.id, e]));

  // product → permitted extras (assembled in one pass, no N+1)
  const extrasByProduct = new Map();
  for (const m of mapRaw) {
    if (!prodById.has(m.producto_id)) throw new MenuAdapterError("orphan producto_extra → missing product", "ORPHAN_MAP");
    if (!extraById.has(m.extra_id)) throw new MenuAdapterError("orphan producto_extra → missing extra", "ORPHAN_MAP");
    if (m.activo === false) continue;
    const e = extraById.get(m.extra_id);
    if (!includeInactive && e.activo === false) continue;
    if (!extrasByProduct.has(m.producto_id)) extrasByProduct.set(m.producto_id, []);
    extrasByProduct.get(m.producto_id).push({
      id: e.id, legacyKey: e.legacy_key, nombre: e.nombre,
      grupo: e.grupo, precioDelta: Number(e.precio_delta), orden: e.orden,
    });
  }

  const activeProd = (p) => includeInactive || p.activo !== false;

  const categorias = categoriasRaw
    .filter((c) => includeInactive || c.activo !== false)
    .map((c) => ({ id: c.id, slug: c.slug, label: c.label, orden: c.orden, activo: c.activo }));

  const productos = productosRaw
    .filter(activeProd)
    .map((p) => {
      const cat = catById.get(p.categoria_id);
      const perms = (extrasByProduct.get(p.id) || []).slice().sort((a, b) => a.orden - b.orden);
      return {
        id: p.id,
        legacyId: p.legacy_id,
        clave: p.clave,
        categoria: cat ? cat.slug : null,
        numOficial: p.num_oficial,
        nombreFantasia: p.nombre_fantasia,
        nombreClasico: p.nombre_clasico,
        nombreCanonico: p.nombre_canonico,
        precio: Number(p.precio),
        emoji: p.emoji,
        ingredientesBase: Array.isArray(p.ingredientes_base) ? p.ingredientes_base : [],
        alergenos: Array.isArray(p.alergenos) ? p.alergenos : [],
        orden: p.orden,
        activo: p.activo,
        disponible: p.disponible,
        visiblePicker: p.visible_picker,
        visibleCocina: p.visible_cocina,
        extrasPermitidos: perms.map((x) => x.legacyKey),
      };
    });

  // aliases must point to an included (active) product
  const includedIds = new Set(productos.map((p) => p.id));
  const aliases = aliasesRaw
    .filter((a) => includeInactive || a.activo !== false)
    .map((a) => {
      if (!prodById.has(a.producto_id)) throw new MenuAdapterError(`alias '${a.alias}' → missing product`, "ALIAS_ORPHAN");
      return { alias: a.alias, aliasNormalizado: a.alias_normalizado, productoId: a.producto_id, fuente: a.fuente, activo: a.activo };
    })
    .filter((a) => includeInactive || includedIds.has(a.productoId));

  const extras = extrasRaw
    .filter((e) => includeInactive || e.activo !== false)
    .map((e) => ({ id: e.id, legacyKey: e.legacy_key, nombre: e.nombre, grupo: e.grupo, precioDelta: Number(e.precio_delta), orden: e.orden, activo: e.activo }));

  return { version: CONTRACT_VERSION, generatedAt, categorias, productos, extras, aliases };
}

// ── B. MENU_LISTA equivalent (array of strings for the interpret prompt)
function renderMenuLista(cat) {
  const byCat = (slug) => cat.productos.filter((p) => p.categoria === slug);
  const lines = [];
  for (const p of byCat("pizzas")) {
    lines.push(`${p.numOficial}. ${p.nombreFantasia} - ${p.nombreClasico} ${fmtPrice(p.precio)}`);
  }
  const nonPizza = (slug) =>
    byCat(slug).map((p) => `${p.nombreClasico}${p.nombreFantasia ? ` (${p.nombreFantasia})` : ""} ${fmtPrice(p.precio)}`);
  return lines
    .concat(nonPizza("dessert_pizzas"))
    .concat(nonPizza("desserts"))
    .concat(nonPizza("beverages"));
}

// ── C. INFO_RISTORANTE menu section equivalent (menu block only)
function renderInfoMenuSection(cat) {
  const pizzas = cat.productos.filter((p) => p.categoria === "pizzas");
  const lines = ["MENÚ PIZZAS (con número oficial del menú):"];
  for (const p of pizzas) lines.push(`${p.numOficial}. ${p.nombreFantasia} (${p.nombreClasico}) ${fmtEuro(p.precio)}`);
  return lines.join("\n");
}

// ── D. ABBINAMENTI_NOMI equivalent ("alias1/alias2=Canonico, ...")
function renderAbbinamenti(cat) {
  const prodById = new Map(cat.productos.map((p) => [p.id, p]));
  const byProduct = new Map();
  for (const a of cat.aliases) {
    if (!byProduct.has(a.productoId)) byProduct.set(a.productoId, []);
    byProduct.get(a.productoId).push(a.alias);
  }
  const parts = [];
  for (const [pid, aliasList] of byProduct) {
    const p = prodById.get(pid);
    if (!p) continue;
    parts.push(`${aliasList.join("/")}=${p.nombreCanonico}`);
  }
  return parts.join(", ");
}

module.exports = {
  assembleCatalogue,
  renderMenuLista,
  renderInfoMenuSection,
  renderAbbinamenti,
  MenuAdapterError,
  CONTRACT_VERSION,
};
