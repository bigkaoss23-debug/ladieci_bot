const assert = require("assert");
const { MENU_LISTA, ABBINAMENTI_NOMI } = require("../../config");
const { compareLegacyAndDynamicResolution } = require("../menuShadowComparison");

const norm = (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const groups = ABBINAMENTI_NOMI.split(", ").map((part) => {
  const i = part.lastIndexOf("=");
  return { aliases: part.slice(0, i).split("/"), name: part.slice(i + 1) };
});
const pizzaLines = MENU_LISTA.filter((line) => /^\d+\. /.test(line));
const numberByName = new Map(pizzaLines.map((line) => {
  const match = line.match(/^(\d+)\.\s+(.+?)\s+-\s+/);
  return [norm(match[2]), Number(match[1])];
}));
const products = groups.map(({ name }) => ({
  id: `p:${norm(name)}`, clave: norm(name), nombreCanonico: name, nombreFantasia: name,
  numOficial: numberByName.get(norm(name)) || null,
  ingredientesBase: name === "El Pelusa" ? ["Cebolla"] : [],
  emoji: name === "Ferrero Rocher" ? "🍰" : null,
}));
const byName = new Map(products.map((item) => [norm(item.nombreCanonico), item]));
const menu = {
  categorias: [{ id: "c:pizzas", slug: "pizzas", label: "Pizze" }],
  productos: products,
  extras: [
    { id: "e:coppa", legacyKey: "ing_coppa", nombre: "Coppa", emoji: "🥓" },
    { id: "e:cebolla", legacyKey: "ing_cebolla", nombre: "Cebolla" },
    { id: "e:olive", legacyKey: "ing_olive", nombre: "Olive" },
  ],
  aliases: groups.flatMap((group) => group.aliases.map((alias) => ({ alias, aliasNormalizado: alias, productoId: byName.get(norm(group.name)).id }))),
};

const cases = [];
for (const group of groups) for (const alias of group.aliases) {
  const product = byName.get(norm(group.name));
  cases.push({ bucket: "legacy_alias", input: alias, legacy: { matched: true, kind: "product", canonicalId: product.id, canonicalName: product.nombreCanonico } });
}
for (const [name, number] of numberByName) {
  const product = byName.get(name);
  cases.push({ bucket: "pizza_number", input: String(number), legacy: { matched: true, kind: "product", canonicalId: product.id, canonicalName: product.nombreCanonico } });
}
for (const product of products) cases.push({ bucket: "product_name", input: product.nombreCanonico, legacy: { matched: true, kind: "product", canonicalId: product.id, canonicalName: product.nombreCanonico } });
for (const extra of menu.extras) cases.push({ bucket: "common_extra", input: extra.nombre, legacy: { matched: true, kind: "extra", canonicalId: extra.id, canonicalName: extra.nombre } });
cases.push({ bucket: "emoji", input: "🍰", legacy: { matched: true, kind: "product", canonicalId: "p:ferrero_rocher", canonicalName: "Ferrero Rocher" } });
cases.push({ bucket: "emoji", input: "🥓", legacy: { matched: true, kind: "extra", canonicalId: "e:coppa", canonicalName: "Coppa" } });
cases.push({ bucket: "ingredient_removal", input: "sin cebolla", legacy: { matched: true, kind: "ingredient_removal", canonicalId: "ingredient:cebolla", canonicalName: "Cebolla" } });
cases.push({ bucket: "unknown", input: "producto inexistente", legacy: { matched: false } });

const matrix = { total: cases.length };
const buckets = {};
for (const item of cases) {
  const result = compareLegacyAndDynamicResolution({ input: item.input, legacyResult: item.legacy, canonicalMenu: menu, menuSource: "fixture" });
  matrix[result.classification] = (matrix[result.classification] || 0) + 1;
  buckets[item.bucket] = buckets[item.bucket] || { total: 0 };
  buckets[item.bucket].total++;
  buckets[item.bucket][result.classification] = (buckets[item.bucket][result.classification] || 0) + 1;
}

assert.equal(groups.flatMap((group) => group.aliases).length, 41);
assert.equal(numberByName.size, 14);
assert.equal(matrix.total, 83);
assert.equal(matrix.MATCH, 83);
assert.equal(matrix.DYNAMIC_AMBIGUOUS || 0, 0);
for (const classification of ["DYNAMIC_UNMATCHED", "KIND_MISMATCH", "TARGET_MISMATCH", "DYNAMIC_EXPANSION", "ERROR"]) assert.equal(matrix[classification || "" ] || 0, 0);
console.log(JSON.stringify({ matrix, buckets, realRegressions: 0 }));
