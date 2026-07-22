const assert = require("assert");
const { compareLegacyAndDynamicResolution, CLASSIFICATIONS } = require("../menuShadowComparison");

const MENU = {
  categorias: [{ id: "c1", slug: "pizzas", label: "Pizze" }],
  productos: [
    { id: "p1", clave: "pelusa", numOficial: 1, nombreCanonico: "El Pelusa", nombreFantasia: "El Pelusa", ingredientesBase: ["Cebolla"] },
    { id: "p2", clave: "maestro", numOficial: 4, nombreCanonico: "El Maestro", nombreFantasia: "El Maestro", ingredientesBase: [] },
  ],
  extras: [{ id: "e1", legacyKey: "ing_coppa", nombre: "Coppa", emoji: "🥓" }],
  aliases: [
    { alias: "margarita", aliasNormalizado: "margarita", productoId: "p1" },
    { alias: "especial", aliasNormalizado: "especial", productoId: "p1" },
    { alias: "especial", aliasNormalizado: "especial", productoId: "p2" },
  ],
};

const compare = (input, legacyResult, menu = MENU) => compareLegacyAndDynamicResolution({ input, legacyResult, canonicalMenu: menu, menuSource: "dynamic" });
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("all required classifications are frozen", () => {
  assert.deepStrictEqual(CLASSIFICATIONS, ["MATCH", "DYNAMIC_AMBIGUOUS", "DYNAMIC_UNMATCHED", "KIND_MISMATCH", "TARGET_MISMATCH", "DYNAMIC_EXPANSION", "ERROR"]);
});
test("product match", () => assert.equal(compare("margarita", { matched: true, kind: "product", canonicalId: "p1", canonicalName: "El Pelusa" }).classification, "MATCH"));
test("extra match", () => assert.equal(compare("Coppa", { matched: true, kind: "extra", canonicalId: "e1", canonicalName: "Coppa" }).classification, "MATCH"));
test("ingredient removal match", () => assert.equal(compare("sin cebolla", { matched: true, kind: "ingredient_removal", canonicalId: "ingredient:cebolla", canonicalName: "Cebolla" }).classification, "MATCH"));
test("dynamic ambiguity", () => assert.equal(compare("especial", { matched: true, kind: "product", canonicalId: "p1", canonicalName: "El Pelusa" }).classification, "DYNAMIC_AMBIGUOUS"));
test("dynamic unmatched", () => assert.equal(compare("inventata", { matched: true, kind: "product", canonicalName: "Inventata" }).classification, "DYNAMIC_UNMATCHED"));
test("kind mismatch", () => assert.equal(compare("Coppa", { matched: true, kind: "product", canonicalName: "Coppa" }).classification, "KIND_MISMATCH"));
test("target mismatch", () => assert.equal(compare("El Maestro", { matched: true, kind: "product", canonicalId: "p1", canonicalName: "El Pelusa" }).classification, "TARGET_MISMATCH"));
test("legacy unmatched dynamic match is an expansion", () => assert.equal(compare("El Pelusa", { matched: false }).classification, "DYNAMIC_EXPANSION"));
test("invalid menu becomes ERROR", () => assert.equal(compare("El Pelusa", { matched: true }, null).classification, "ERROR"));
test("diagnostic contains only privacy-safe allow-listed fields", () => {
  const secretInput = "Mario +34600000000 Calle Mayor 12 nota sin cebolla";
  const { diagnostic } = compare(secretInput, { matched: false });
  assert.deepStrictEqual(Object.keys(diagnostic).sort(), ["classification", "counters", "dynamicCanonicalId", "dynamicKind", "inputHash", "legacyCanonicalId", "legacyKind", "menuSource"].sort());
  assert.match(diagnostic.inputHash, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(diagnostic);
  for (const forbidden of [secretInput, "Mario", "34600000000", "Calle Mayor", "sin cebolla"]) assert.ok(!serialized.includes(forbidden));
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
