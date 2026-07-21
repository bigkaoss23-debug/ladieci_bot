const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { MENU_LISTA, ABBINAMENTI_NOMI } = require("../../config");
const { resolveMenuReference } = require("../menuSemanticResolver");

const norm = (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const legacyGroups = ABBINAMENTI_NOMI.split(", ").map((part) => {
  const split = part.lastIndexOf("=");
  return { aliases: part.slice(0, split).split("/"), canonicalName: part.slice(split + 1) };
});
const pizzaLines = MENU_LISTA.filter((line) => /^\d+\. /.test(line));
const pizzaByName = new Map(pizzaLines.map((line) => {
  const match = line.match(/^(\d+)\.\s+(.+?)\s+-\s+/);
  return [norm(match[2]), Number(match[1])];
}));

const products = legacyGroups.map(({ canonicalName }) => ({
  id: `p:${norm(canonicalName)}`,
  clave: norm(canonicalName),
  categoria: "pizzas",
  numOficial: pizzaByName.get(norm(canonicalName)) || null,
  nombreFantasia: canonicalName,
  nombreClasico: canonicalName,
  nombreCanonico: canonicalName,
  emoji: canonicalName === "Ferrero Rocher" ? "🍰" : null,
  ingredientesBase: canonicalName === "El Pelusa" ? ["Cebolla", "Mozzarella"] : [],
}));
const productByName = new Map(products.map((product) => [norm(product.nombreCanonico), product]));
const aliases = legacyGroups.flatMap(({ aliases: values, canonicalName }) => values.map((alias) => ({
  alias, aliasNormalizado: alias, productoId: productByName.get(norm(canonicalName)).id,
})));
const MENU = {
  version: 1,
  categorias: [{ id: "c:pizzas", slug: "pizzas", label: "Pizze", orden: 1 }],
  productos: products.concat([{ id: "p:nutella", clave: "nutella", categoria: "desserts", nombreCanonico: "Nutella", nombreFantasia: "Nutella", ingredientesBase: [], emoji: "🍫" }]),
  extras: [
    { id: "e:coppa", legacyKey: "ing_coppa", nombre: "Coppa", emoji: "🥓" },
    { id: "e:cebolla", legacyKey: "ing_cebolla", nombre: "Cebolla", emoji: "🧅" },
    { id: "e:nutella", legacyKey: "sweet_nutella", nombre: "Nutella", emoji: "🍫" },
  ],
  aliases,
};

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("exact product name resolves canonically", () => {
  const result = resolveMenuReference("El Pelusa", MENU);
  assert.equal(result.matched, true);
  assert.equal(result.kind, "product");
  assert.equal(result.canonicalId, "p:el_pelusa");
  assert.equal(result.matchedBy, "product_name");
  assert.equal(result.confidence, "exact");
});

test("legacy product alias resolves", () => {
  const result = resolveMenuReference("caprichosa", MENU);
  assert.equal(result.canonicalName, "Il Gladiatore");
  assert.equal(result.matchedBy, "product_alias");
});

test("official pizza number resolves without fuzzy matching", () => {
  const result = resolveMenuReference("pizza 4", MENU);
  assert.equal(result.canonicalName, "El Maestro");
  assert.equal(result.matchedBy, "product_number");
});

test("category label resolves canonically", () => {
  const result = resolveMenuReference(" PÍZZE ", MENU);
  assert.equal(result.matched, true);
  assert.equal(result.kind, "category");
  assert.equal(result.canonicalId, "c:pizzas");
});

test("unique emoji resolves and shared emoji is ambiguous", () => {
  const extra = resolveMenuReference("🥓", MENU);
  assert.equal(extra.kind, "extra");
  assert.equal(extra.canonicalName, "Coppa");
  const collision = resolveMenuReference("🍫", MENU);
  assert.equal(collision.ambiguous, true);
  assert.deepStrictEqual(collision.candidates.map((item) => item.kind), ["product", "extra"]);
});

test("extra name and legacy key resolve", () => {
  assert.equal(resolveMenuReference("  CÓPPA!! ", MENU).canonicalId, "e:coppa");
  assert.equal(resolveMenuReference("ing_coppa", MENU).matchedBy, "extra_key");
});

test("case, spaces, accents, apostrophes and punctuation normalize conservatively", () => {
  const menu = structuredClone(MENU);
  menu.aliases.push({ alias: "l’ultima  pizza", aliasNormalizado: "l’ultima pizza", productoId: "p:el_ultimo_10" });
  const result = resolveMenuReference("  L'ÚLTIMA---PIZZA!!! ", menu);
  assert.equal(result.canonicalName, "El Ultimo 10");
});

test("duplicate alias across products is explicit ambiguity", () => {
  const menu = structuredClone(MENU);
  menu.aliases.push({ alias: "especial", aliasNormalizado: "especial", productoId: "p:el_maestro" });
  menu.aliases.push({ alias: "especial", aliasNormalizado: "especial", productoId: "p:il_gladiatore" });
  const result = resolveMenuReference("especial", menu);
  assert.equal(result.matched, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.matchedBy, "collision");
  assert.deepStrictEqual(result.candidates.map((item) => item.canonicalName), ["El Maestro", "Il Gladiatore"]);
});

test("product/extra collision never chooses arbitrarily", () => {
  const result = resolveMenuReference("Nutella", MENU);
  assert.equal(result.ambiguous, true);
  assert.deepStrictEqual(result.candidates.map((item) => item.kind), ["product", "extra"]);
});

test("explicit ingredient removal resolves existing base ingredient", () => {
  const result = resolveMenuReference("sin cebolla", MENU);
  assert.equal(result.matched, true);
  assert.equal(result.kind, "ingredient_removal");
  assert.equal(result.canonicalId, "ingredient:cebolla");
  assert.deepStrictEqual(result.productIds, ["p:el_pelusa"]);
});

test("unknown and empty input are controlled unmatched results", () => {
  for (const input of ["", "   ", null, "pizza quattro stagioni inventata"]) {
    const result = resolveMenuReference(input, MENU);
    assert.equal(result.matched, false);
    assert.equal(result.ambiguous, false);
    assert.deepStrictEqual(result.candidates, []);
  }
});

test("candidate ordering is deterministic across catalogue order", () => {
  const menu = structuredClone(MENU);
  menu.aliases.push({ alias: "collisione", aliasNormalizado: "collisione", productoId: "p:il_gladiatore" });
  menu.aliases.push({ alias: "collisione", aliasNormalizado: "collisione", productoId: "p:el_maestro" });
  const reversed = { ...menu, productos: menu.productos.slice().reverse(), aliases: menu.aliases.slice().reverse() };
  assert.deepStrictEqual(resolveMenuReference("collisione", menu), resolveMenuReference("collisione", reversed));
});

test("complete legacy alias matrix preserves meaning", () => {
  const failures = [];
  for (const group of legacyGroups) for (const alias of group.aliases) {
    const result = resolveMenuReference(alias, MENU);
    if (!result.matched || norm(result.canonicalName) !== norm(group.canonicalName)) failures.push({ alias, expected: group.canonicalName, result });
  }
  assert.deepStrictEqual(failures, []);
  assert.equal(legacyGroups.flatMap((group) => group.aliases).length, 41);
});

test("legacy pizza numbering and names are preserved", () => {
  assert.equal(pizzaLines.length, 14);
  for (const [name, number] of pizzaByName) {
    const result = resolveMenuReference(String(number), MENU);
    assert.equal(norm(result.canonicalName), name);
  }
});

test("dynamic alias semantic drift is surfaced as collision", () => {
  const menu = structuredClone(MENU);
  menu.aliases.push({ alias: "margarita", aliasNormalizado: "margarita", productoId: "p:el_maestro" });
  const result = resolveMenuReference("margarita", menu);
  assert.equal(result.ambiguous, true);
  assert.deepStrictEqual(result.candidates.map((item) => item.canonicalName), ["El Maestro", "El Pelusa"]);
});

test("resolver is pure and has no infrastructure or operational imports", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "menuSemanticResolver.js"), "utf8");
  for (const forbidden of ["supabase", "fetch(", "process.env", "menuFacade", "agentWhatsapp", "agentOrdini", "planner", "sbSelect", "sbInsert", "sbUpdate", "sbUpsert", "sbDelete"]) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
  assert.ok(!/require\s*\(/.test(source));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}: ${error.stack || error}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
