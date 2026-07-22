"use strict";

const assert = require("assert");
const { resolveMenuReference } = require("../menuSemanticResolver");
const { compareLegacyAndDynamicResolution } = require("../menuShadowComparison");
const { evaluateShadowGate } = require("../menuShadowGate");

const base = {
  categorias: [],
  productos: [{ id: "p1", nombreCanonico: "Atun", nombreFantasia: "Atun", clave: "atun", emoji: null, ingredientesBase: [] }],
  extras: [{ id: "e1", legacyKey: "coppa", nombre: "Coppa", emoji: "🥓" }],
  aliases: [{ alias: "atun", aliasNormalizado: "atun", productoId: "p1" }],
};

let r = resolveMenuReference("atun", base);
assert.equal(r.matched, true);
assert.equal(r.canonicalId, "p1");
assert.deepStrictEqual(r.matchedSources, ["product_alias", "product_key", "product_name"]);

const duplicatedExtra = { ...base, extras: [...base.extras, { ...base.extras[0] }] };
r = resolveMenuReference("🥓", duplicatedExtra);
assert.equal(r.matched, true);
assert.equal(r.canonicalId, "e1");
r = resolveMenuReference("coppa", duplicatedExtra);
assert.equal(r.matched, true);
assert.equal(r.canonicalId, "e1");
assert.deepStrictEqual(r.matchedSources, ["extra_key", "extra_name"]);

const twoTargets = { ...base, aliases: [...base.aliases, { alias: "atun", aliasNormalizado: "atun", productoId: "p2" }], productos: [...base.productos, { ...base.productos[0], id: "p2" }] };
assert.equal(resolveMenuReference("atun", twoTargets).ambiguous, true);

const productExtra = { ...base, extras: [...base.extras, { id: "e2", legacyKey: "atun", nombre: "Atun" }] };
assert.equal(resolveMenuReference("atun", productExtra).ambiguous, true);

const legacy = { matched: false };
const expansion = compareLegacyAndDynamicResolution({ input: "atun", legacyResult: legacy, canonicalMenu: base, menuSource: "fixture" });
assert.equal(expansion.classification, "DYNAMIC_EXPANSION");
assert.deepStrictEqual(legacy, { matched: false });

assert.equal(evaluateShadowGate({ counts: { DYNAMIC_EXPANSION: 3 }, ambiguities: ["especial"], documentedAmbiguities: ["especial"] }).green, true);
assert.equal(evaluateShadowGate({ counts: { TARGET_MISMATCH: 1, DYNAMIC_EXPANSION: 3 } }).green, false);
assert.equal(evaluateShadowGate({ counts: {}, ambiguities: ["unexpected"] }).green, false);

const diagnostic = expansion.diagnostic;
assert.deepStrictEqual(Object.keys(diagnostic), ["inputHash", "classification", "legacyKind", "legacyCanonicalId", "dynamicKind", "dynamicCanonicalId", "menuSource", "counters"]);
assert.equal(JSON.stringify(diagnostic).includes("atun"), false);

console.log("menuCollisionDedupAndGate: ok");
