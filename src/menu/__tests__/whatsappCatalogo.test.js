// Phase C — dynamic-catalogue WhatsApp matcher tests. PURE, offline (no DB/LLM).
// Run: `node src/menu/__tests__/whatsappCatalogo.test.js`
const assert = require("assert");
const { buildCatalogIndex, resolveProduct, resolveExtra, resolveWhatsappItem, normalizeText } = require("../whatsappCatalogo");
const { normalizeOrderItem } = require("../menuSnapshot");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("FAIL  " + name + " -> " + e.message); } };

// ── Deterministic fixture mirroring the real staging catalogue shape ──
const CAT = {
  version: 1,
  categorias: [
    { slug: "pizzas", label: "Pizzas" },
    { slug: "dessert_pizzas", label: "Pizzas Dulces" },
    { slug: "beverages", label: "Bebidas" },
  ],
  productos: [
    { id: "uuid-1", legacyId: 1, clave: "el_pelusa", categoria: "pizzas", numOficial: 1, nombreFantasia: "El Pelusa", nombreClasico: "Margherita Classica", nombreCanonico: "El Pelusa", precio: 12.0, emoji: "🍕", ingredientesBase: ["Tomate", "Mozzarella"], extrasPermitidos: ["ing_coppa", "ing_salami_napoli"], disponible: true, activo: true },
    { id: "uuid-4", legacyId: 4, clave: "el_maestro", categoria: "pizzas", numOficial: 4, nombreFantasia: "El Maestro", nombreClasico: "Inferno", nombreCanonico: "El Maestro", precio: 13.5, emoji: "🍕", ingredientesBase: ["Tomate"], extrasPermitidos: ["ing_coppa"], disponible: true, activo: true },
    { id: "uuid-11", legacyId: 11, clave: "il_gladiatore", categoria: "pizzas", numOficial: 11, nombreFantasia: "Il Gladiatore", nombreClasico: "Capricciosa", nombreCanonico: "Il Gladiatore", precio: 14.5, emoji: "🍕", ingredientesBase: ["Tomate"], extrasPermitidos: ["ing_coppa"], disponible: true, activo: true },
    { id: "uuid-16", legacyId: 16, clave: "pizza_nutella", categoria: "dessert_pizzas", numOficial: null, nombreFantasia: "Pizza Nutella", nombreClasico: "Pizza Nutella", nombreCanonico: "Pizza Nutella", precio: 9.0, emoji: "🍫", ingredientesBase: [], extrasPermitidos: ["sweet_nutella", "sweet_kitkat", "sweet_kinder", "sweet_pistacho", "sweet_almendra"], disponible: true, activo: true },
    { id: "uuid-98", legacyId: 98, clave: "special_new", categoria: "pizzas", numOficial: 12, nombreFantasia: "La Joya", nombreClasico: "CarboDieci", nombreCanonico: "La Joya", precio: 15.0, emoji: "🍕", ingredientesBase: ["Tomate"], extrasPermitidos: ["ing_coppa"], disponible: true, activo: true },
    { id: "uuid-99", legacyId: 99, clave: "sold_out", categoria: "pizzas", numOficial: 13, nombreFantasia: "Magicbox", nombreClasico: "Parmazola", nombreCanonico: "Magicbox", precio: 16.5, emoji: "🍕", ingredientesBase: [], extrasPermitidos: [], disponible: false, activo: true },
  ],
  extras: [
    { id: "e-coppa", legacyKey: "ing_coppa", nombre: "Coppa", grupo: "savory", precioDelta: 0.5, emoji: "🥓", activo: true },
    { id: "e-salaminap", legacyKey: "ing_salami_napoli", nombre: "Salami Napoli", grupo: "savory", precioDelta: 0.5, emoji: "🥩", activo: true },
    { id: "e-nutella", legacyKey: "sweet_nutella", nombre: "Nutella", grupo: "sweet", precioDelta: 0.5, emoji: "🍫", activo: true },
    { id: "e-kitkat", legacyKey: "sweet_kitkat", nombre: "KitKat", grupo: "sweet", precioDelta: 0.5, emoji: "🍫", activo: true },
    { id: "e-kinder", legacyKey: "sweet_kinder", nombre: "Kinder", grupo: "sweet", precioDelta: 0.5, emoji: "🥚", activo: true },
    { id: "e-pistacho", legacyKey: "sweet_pistacho", nombre: "Pistacho", grupo: "sweet", precioDelta: 0.5, emoji: "🟢", activo: true },
    { id: "e-almendra", legacyKey: "sweet_almendra", nombre: "Almendra", grupo: "sweet", precioDelta: 0.5, emoji: "🌰", activo: true },
    { id: "e-disabled", legacyKey: "ing_disabled", nombre: "Trufa", grupo: "savory", precioDelta: 1.0, emoji: "🍄", activo: false },
  ],
  aliases: [
    { alias: "marinara", aliasNormalizado: "marinara", productoId: "uuid-1", fuente: "seed" },
    { alias: "inferno", aliasNormalizado: "inferno", productoId: "uuid-4", fuente: "seed" },
    { alias: "capricciosa", aliasNormalizado: "capricciosa", productoId: "uuid-11", fuente: "seed" },
    { alias: "caprichosa", aliasNormalizado: "caprichosa", productoId: "uuid-11", fuente: "seed" },
    { alias: "nutella pizza", aliasNormalizado: "nutella pizza", productoId: "uuid-16", fuente: "seed" },
    // an intentionally ambiguous alias mapping to two products (collision test)
    { alias: "especial", aliasNormalizado: "especial", productoId: "uuid-4", fuente: "seed" },
    { alias: "especial", aliasNormalizado: "especial", productoId: "uuid-11", fuente: "seed" },
  ],
};

const IDX = buildCatalogIndex(CAT);

console.log("\n══ WHATSAPP DYNAMIC CATALOGUE MATCHER ══");

// 1. pizza by official number
t("1: pizza by official number (4 → El Maestro, the DYNAMIC one, not stale config)", () => {
  const r = resolveProduct(IDX, { number: 4 });
  assert.equal(r.status, "ok");
  assert.equal(r.product.nombreCanonico, "El Maestro");
  assert.equal(r.product.nombreClasico, "Inferno");
});
// 2. pizza by classic name
t("2: pizza by classic name (Capricciosa → Il Gladiatore #11)", () => {
  const r = resolveProduct(IDX, { name: "Capricciosa" });
  assert.equal(r.status, "ok");
  assert.equal(r.product.numOficial, 11);
});
// 3. pizza by fantasy name
t("3: pizza by fantasy name (El Pelusa)", () => {
  const r = resolveProduct(IDX, { name: "el pelusa" });
  assert.equal(r.status, "ok");
  assert.equal(r.product.id, "uuid-1");
});
// 4. dynamic alias
t("4: dynamic alias (marinara → El Pelusa, inferno → El Maestro)", () => {
  assert.equal(resolveProduct(IDX, { name: "marinara" }).product.id, "uuid-1");
  assert.equal(resolveProduct(IDX, { name: "inferno" }).product.nombreCanonico, "El Maestro");
});
// 5. dynamic-only product not present in old config
t("5: dynamic-only product resolves (La Joya / CarboDieci, #12)", () => {
  assert.equal(resolveProduct(IDX, { number: 12 }).product.nombreCanonico, "La Joya");
  assert.equal(resolveProduct(IDX, { name: "CarboDieci" }).product.id, "uuid-98");
});
// 6. Coppa extra
t("6: Coppa extra resolves + compatible with El Pelusa", () => {
  const p = resolveProduct(IDX, { number: 1 }).product;
  const r = resolveExtra(IDX, "coppa", p);
  assert.equal(r.status, "ok");
  assert.equal(r.extra.nombre, "Coppa");
  assert.equal(r.extra.precioDelta, 0.5);
});
// 7. Salami Napoli extra
t("7: Salami Napoli extra resolves", () => {
  const r = resolveExtra(IDX, "Salami Napoli", resolveProduct(IDX, { number: 1 }).product);
  assert.equal(r.status, "ok");
  assert.equal(r.extra.legacyKey, "ing_salami_napoli");
});
// 8. sweet pizza
t("8: sweet pizza (Pizza Nutella, dessert_pizzas → cat 'Pizzas Dulces')", () => {
  const out = resolveWhatsappItem(IDX, { n: "Pizza Nutella" });
  assert.equal(out.status, "ok");
  assert.equal(out.item.cat, "Pizzas Dulces");
});
// 9. each sweet extra
t("9: each sweet extra resolves on Pizza Nutella", () => {
  const p = resolveProduct(IDX, { name: "Pizza Nutella" }).product;
  for (const nm of ["Nutella", "KitKat", "Kinder", "Pistacho", "Almendra"]) {
    assert.equal(resolveExtra(IDX, nm, p).status, "ok", nm);
  }
});
// 10. multiple extras
t("10: multiple extras → structured extras[] with summed unit total", () => {
  const out = resolveWhatsappItem(IDX, { n: "Pizza Nutella", extras: ["KitKat", "Pistacho"] });
  assert.equal(out.item.extras.length, 2);
  assert.equal(out.item.extrasUnitTotal, 1.0);
  assert.equal(out.item.finalUnitPrice, 10.0);
});
// 11. extra quantity
t("11: repeated extra name → quantity aggregated", () => {
  const out = resolveWhatsappItem(IDX, { n: "Pizza Nutella", extras: ["KitKat", "KitKat"] });
  assert.equal(out.item.extras.length, 1);
  assert.equal(out.item.extras[0].quantity, 2);
  assert.equal(out.item.extrasUnitTotal, 1.0);
});
// 12. removed ingredient
t("12: removed ingredient preserved in removedIngredients", () => {
  const out = resolveWhatsappItem(IDX, { n: "el pelusa", removed: ["Cebolla"] });
  assert.deepEqual(out.item.removedIngredients, ["Cebolla"]);
});
// 13. manual note separated from sub
t("13: manual note goes to notes, sub stays extras-only", () => {
  const out = resolveWhatsappItem(IDX, { n: "el pelusa", extras: ["Coppa"], nota: "cortar en 4" });
  assert.equal(out.item.notes, "cortar en 4");
  assert.equal(out.item.sub, "+Coppa");
  assert.ok(!out.item.sub.includes("cortar"));
});
// 14. multiple products in one message — resolve each independently
t("14: multiple parsed items resolve independently", () => {
  const a = resolveWhatsappItem(IDX, { n: "el pelusa", q: 2 });
  const b = resolveWhatsappItem(IDX, { num: 4 });
  assert.equal(a.status, "ok"); assert.equal(a.item.q, 2);
  assert.equal(b.status, "ok"); assert.equal(b.item.classicName, "Inferno");
});
// 15. unknown product
t("15: unknown product → error (no fabricated order)", () => {
  const out = resolveWhatsappItem(IDX, { n: "carbonara napoletana quattro stagioni" });
  assert.equal(out.status, "error");
  assert.equal(out.reason, "product_unknown");
});
// 16. unknown extra
t("16: unknown extra → item still ok, warning, extra dropped (not priced)", () => {
  const out = resolveWhatsappItem(IDX, { n: "el pelusa", extras: ["Foiegras"] });
  assert.equal(out.status, "ok");
  assert.equal(out.item.extras.length, 0);
  assert.equal(out.warnings[0].reason, "unknown");
  assert.equal(out.item.finalUnitPrice, 12.0);
});
// 17. ambiguous alias
t("17: ambiguous alias → explicit ambiguous error, no silent pick", () => {
  const r = resolveProduct(IDX, { name: "especial" });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.candidates.length, 2);
  const out = resolveWhatsappItem(IDX, { n: "especial" });
  assert.equal(out.status, "error");
  assert.equal(out.reason, "product_ambiguous");
});
// 18. disabled product
t("18: disabled (disponible=false) product → disabled error", () => {
  const r = resolveProduct(IDX, { number: 13 });
  assert.equal(r.status, "disabled");
  const out = resolveWhatsappItem(IDX, { num: 13 });
  assert.equal(out.status, "error");
  assert.equal(out.reason, "product_disabled");
});
// 19. disabled extra
t("19: disabled extra → not applied (warning)", () => {
  const p = resolveProduct(IDX, { number: 1 }).product;
  assert.equal(resolveExtra(IDX, "Trufa", { ...p, extrasPermitidos: ["ing_disabled"] }).status, "disabled");
});
// 20. menu unavailable → index build throws (caller fails safe)
t("20: invalid/empty catalogue → buildCatalogIndex throws (fail-safe)", () => {
  assert.throws(() => buildCatalogIndex(null));
  assert.throws(() => buildCatalogIndex({}));
});
// 21. canonical snapshot output (through the shared normalizer)
t("21: resolved item → canonical snapshot via normalizeOrderItem", () => {
  const out = resolveWhatsappItem(IDX, { n: "Pizza Nutella", extras: ["Kinder"], q: 2, nota: "Sin cortar" });
  const snap = normalizeOrderItem(out.item);
  assert.equal(snap.snapshotVersion, 1);
  assert.equal(snap.classicName, "Pizza Nutella");
  assert.equal(snap.extras.length, 1);
  assert.equal(snap.extras[0].name, "Kinder");
  assert.equal(snap.notes, "Sin cortar");
  assert.ok(!snap.sub.includes("Sin cortar"), "note not echoed into sub");
  assert.equal(snap.q, 2);
  assert.equal(snap.lineTotal, 19.0); // (9 + 0.5) * 2
});
// 22. correct accepted prices and line totals
t("22: accepted catalogue price used (base + extras), not an LLM-picked price", () => {
  const out = resolveWhatsappItem(IDX, { n: "el maestro", extras: ["Coppa"], p: 999 });
  assert.equal(out.item.baseUnitPrice, 13.5);   // from catalogue, ignores parsed p
  assert.equal(out.item.extrasUnitTotal, 0.5);
  assert.equal(out.item.finalUnitPrice, 14.0);
});
// 23. no hardcoded rename dependency (normalizer/matcher never read config.js)
t("23: matcher output has no dependency on config.js MENU_LISTA", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "whatsappCatalogo.js"), "utf8");
  assert.ok(!/require\(["'].*config["']\)/.test(src), "resolver must not import config");
  assert.ok(!/MENU_LISTA|ABBINAMENTI_NOMI|INFO_RISTORANTE/.test(src), "no hardcoded catalogue constants");
});
// 24. future catalogue rename fixture propagates automatically
t("24: renaming a product in the catalogue propagates with no code change", () => {
  const renamed = JSON.parse(JSON.stringify(CAT));
  renamed.productos.find((p) => p.numOficial === 8 || p.id === "uuid-1").nombreFantasia = "El Pelusa REBRAND";
  renamed.aliases.push({ alias: "rebrand", aliasNormalizado: "rebrand", productoId: "uuid-1", fuente: "seed" });
  const idx2 = buildCatalogIndex(renamed);
  assert.equal(resolveProduct(idx2, { name: "rebrand" }).product.id, "uuid-1");
  assert.equal(resolveProduct(idx2, { number: 1 }).product.nombreFantasia, "El Pelusa REBRAND");
});
// 25. legacy regression: accent/case/space tolerance + number-in-name
t("25: matching is case/accent/space tolerant", () => {
  assert.equal(normalizeText("  Càpricciôsa  "), "capricciosa");
  assert.equal(resolveProduct(IDX, { name: "  MARINARA " }).product.id, "uuid-1");
  assert.equal(resolveProduct(IDX, { name: "margherita classica" }).product.id, "uuid-1");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
