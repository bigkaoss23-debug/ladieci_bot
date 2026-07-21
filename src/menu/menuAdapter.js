class MenuAdapterError extends Error {
  constructor(message, code = "MENU_ADAPTER_ERROR") {
    super(message);
    this.name = "MenuAdapterError";
    this.code = code;
  }
}

const CONTRACT_VERSION = 1;
const byOrder = (a, b) => Number(a.orden || 0) - Number(b.orden || 0);

function assertUnique(rows, key, code) {
  const seen = new Set();
  for (const row of rows) {
    const value = row[key];
    if (value == null) continue;
    if (seen.has(value)) throw new MenuAdapterError(`duplicate ${key}`, code);
    seen.add(value);
  }
}

function assembleCatalogue(raw = {}, { includeInactive = false, now = new Date().toISOString() } = {}) {
  const categoriesRaw = raw.menu_categorias || [];
  const productsRaw = raw.menu_productos || [];
  const extrasRaw = raw.menu_extras || [];
  const linksRaw = raw.menu_producto_extras || [];
  const aliasesRaw = raw.menu_aliases || [];

  assertUnique(productsRaw, "legacy_id", "DUP_LEGACY_ID");
  assertUnique(productsRaw, "clave", "DUP_PRODUCT_KEY");
  assertUnique(aliasesRaw, "alias_normalizado", "DUP_ALIAS");

  const categoryById = new Map(categoriesRaw.map((row) => [row.id, row]));
  const productById = new Map(productsRaw.map((row) => [row.id, row]));
  const extraById = new Map(extrasRaw.map((row) => [row.id, row]));
  const extrasByProduct = new Map();

  for (const link of linksRaw) {
    const product = productById.get(link.producto_id);
    const extra = extraById.get(link.extra_id);
    if (!product || !extra) throw new MenuAdapterError("orphan product-extra link", "ORPHAN_EXTRA_LINK");
    if (link.activo === false || (!includeInactive && extra.activo === false)) continue;
    if (!extrasByProduct.has(product.id)) extrasByProduct.set(product.id, []);
    extrasByProduct.get(product.id).push(extra);
  }

  const categories = categoriesRaw
    .filter((row) => includeInactive || row.activo !== false)
    .slice().sort((a, b) => byOrder(a, b) || String(a.slug).localeCompare(String(b.slug)))
    .map((row) => ({ id: row.id, slug: row.slug, label: row.label, orden: row.orden, activo: row.activo }));

  const products = productsRaw
    .filter((row) => includeInactive || row.activo !== false)
    .slice().sort((a, b) => byOrder(a, b) || Number(a.legacy_id || 0) - Number(b.legacy_id || 0))
    .map((row) => ({
      id: row.id,
      legacyId: row.legacy_id,
      clave: row.clave,
      categoria: categoryById.get(row.categoria_id)?.slug || null,
      numOficial: row.num_oficial,
      nombreFantasia: row.nombre_fantasia,
      nombreClasico: row.nombre_clasico,
      nombreCanonico: row.nombre_canonico,
      precio: Number(row.precio),
      emoji: row.emoji ?? null,
      ingredientesBase: Array.isArray(row.ingredientes_base) ? row.ingredientes_base : [],
      alergenos: Array.isArray(row.alergenos) ? row.alergenos : [],
      orden: row.orden,
      activo: row.activo,
      disponible: row.disponible,
      visiblePicker: row.visible_picker,
      visibleCocina: row.visible_cocina,
      extras: (extrasByProduct.get(row.id) || []).slice().sort(byOrder).map((extra) => ({
        id: extra.id,
        legacyKey: extra.legacy_key,
        nombre: extra.nombre,
        grupo: extra.grupo,
        precioDelta: Number(extra.precio_delta),
        emoji: extra.emoji ?? null,
        orden: extra.orden,
      })),
    }));

  const includedProducts = new Set(products.map((product) => product.id));
  const aliases = aliasesRaw
    .filter((row) => includeInactive || row.activo !== false)
    .map((row) => {
      if (!productById.has(row.producto_id)) throw new MenuAdapterError("orphan alias", "ORPHAN_ALIAS");
      return { alias: row.alias, aliasNormalizado: row.alias_normalizado, productoId: row.producto_id, fuente: row.fuente, activo: row.activo };
    })
    .filter((row) => includeInactive || includedProducts.has(row.productoId));

  const extras = extrasRaw
    .filter((row) => includeInactive || row.activo !== false)
    .slice().sort((a, b) => String(a.grupo).localeCompare(String(b.grupo)) || byOrder(a, b))
    .map((row) => ({ id: row.id, legacyKey: row.legacy_key, nombre: row.nombre, grupo: row.grupo, precioDelta: Number(row.precio_delta), emoji: row.emoji ?? null, orden: row.orden, activo: row.activo }));

  return { version: CONTRACT_VERSION, generatedAt: now, categorias: categories, productos: products, extras, aliases };
}

module.exports = { CONTRACT_VERSION, MenuAdapterError, assembleCatalogue };
