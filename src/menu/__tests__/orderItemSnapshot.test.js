// Phase A — canonical immutable order-item snapshot normalizer tests.
// Offline: no DB, no LLM, no network. Run: `node src/menu/__tests__/orderItemSnapshot.test.js`
const assert = require("assert");
const { normalizeOrderItem, OrderItemValidationError, SNAPSHOT_VERSION } = require("../menuSnapshot");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("FAIL  " + name + " -> " + e.message); } };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Fixtures: every runtime item shape in circulation ──────────────
// 1. dynamic frontend pizza with savory extras (new emission: structured)
const f1 = {
  productId: "uuid-1", legacyId: 1, legacyKey: "el_pelusa", officialNumber: 1,
  classicName: "Margherita Classica", fantasyName: "El Pelusa", category: "Pizzas", emoji: "🍕",
  quantity: 1, baseUnitPrice: 12.0,
  extras: [{ key: "ing_coppa", name: "Coppa", price: 0.5, emoji: "🥓", quantity: 1 }],
  baseIngredients: ["Tomate San Marzano", "Fior di latte"], sub: "+Coppa, cortar en 4", nota: "cortar en 4",
  // legacy p present too (final)
  p: 12.5, n: "El Pelusa",
};
// 2. dynamic sweet pizza with sweet extra
const f2 = {
  productId: "uuid-2", legacyId: 16, legacyKey: "pizza_nutella", officialNumber: null,
  classicName: "Pizza Nutella", fantasyName: "Pizza Nutella", category: "Pizzas Dulces", emoji: "🍕",
  quantity: 2, baseUnitPrice: 9.0,
  extras: [{ key: "sweet_kinder", name: "Kinder", price: 0.5, emoji: "🥚", quantity: 1 }],
  sub: "+Kinder",
};
// 3. legacy hardcoded frontend item (only legacy fields, extras in sub text)
const f3 = { id: 8, n: "Il Tulipano Nero", sub: "+Provolone, sin cebolla", p: 15.0, q: 1, cat: "Pizzas", e: "🧀", num: 8, ing: "Gorgonzola, Provolone" };
// 4. existing WhatsApp/parser item (LLM shape: n/p/q, no ids)
const f4 = { n: "Diavola", p: 13.0, q: 1, cat: "Pizzas" };
// 5. Custom product
const f5 = { n: "Pizza a tu gusto", sub: "+Champiñones frescos, +Rúcula", p: 13.0, q: 1, cat: "Pizzas", e: "⭐", custom: true };
// 6. beverage
const f6 = { id: 30, n: "Coca-Cola", p: 2.5, q: 3, cat: "Bebidas", e: "🥤" };
// 7. unknown historical item with no catalogue match
const f7 = { n: "Producto Viejo Desconocido", p: 7.5, q: 1 };
// 8. disabled/deleted product snapshot (still must normalize + display)
const f8 = { productId: "uuid-del", legacyId: 99, classicName: "Retirada", fantasyName: "Retirada", p: 11.0, q: 1, cat: "Pizzas", activo: false };
// 9. item with removed ingredient + free note
const f9 = { n: "Marinara", classicName: "Marinara Classica", p: 10.0, q: 1, cat: "Pizzas", removedIngredients: ["Ajo"], notes: "bien cocida", extras: [] };
// 10. quantity > 1 with structured extras
const f10 = { classicName: "Capricciosa", n: "Il Gladiatore", baseUnitPrice: 14.5, quantity: 3, extras: [{ key: "ing_coppa", name: "Coppa", price: 0.5, quantity: 2 }], num: 11 };

const ALL = { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10 };

// ── No source item silently dropped; all normalize ──
t("all 10 fixtures normalize without throwing", () => {
  for (const [k, v] of Object.entries(ALL)) { const s = normalizeOrderItem(v); assert.ok(s, k); }
});

t("snapshotVersion stamped on every item", () => {
  for (const v of Object.values(ALL)) assert.equal(normalizeOrderItem(v).snapshotVersion, SNAPSHOT_VERSION);
});

// ── Canonical + legacy fields both present (read compatibility) ──
t("legacy fields present for existing views (id,n,p,q,sub,cat,e,num)", () => {
  const s = normalizeOrderItem(f1);
  for (const key of ["id", "n", "p", "q", "sub", "cat", "e", "num"]) assert.ok(key in s, "missing legacy " + key);
  assert.equal(s.n, "El Pelusa");        // display/fantasy preserved
  assert.equal(s.p, 12.5);               // final unit price
  assert.equal(s.q, 1);
  assert.equal(s.num, 1);
  assert.equal(s.cat, "Pizzas");
});

t("canonical fields present (classicName/fantasyName/base/extras)", () => {
  const s = normalizeOrderItem(f1);
  assert.equal(s.classicName, "Margherita Classica");
  assert.equal(s.fantasyName, "El Pelusa");
  assert.equal(s.baseUnitPrice, 12.0);
  assert.equal(s.extrasUnitTotal, 0.5);
  assert.equal(s.finalUnitPrice, 12.5);
  assert.deepEqual(s.extras.map((e) => e.name), ["Coppa"]);
  assert.equal(s.extras[0].price, 0.5);
});

// ── PRICE CONTRACT ──
t("finalUnitPrice = baseUnitPrice + extrasUnitTotal (structured)", () => {
  const s = normalizeOrderItem(f2);
  assert.equal(s.baseUnitPrice, 9.0);
  assert.equal(s.extrasUnitTotal, 0.5);
  assert.equal(s.finalUnitPrice, r2(9.0 + 0.5));
});
t("lineTotal = finalUnitPrice * quantity", () => {
  const s = normalizeOrderItem(f2);
  assert.equal(s.lineTotal, r2(9.5 * 2));   // 19.0
  const s10 = normalizeOrderItem(f10);
  // base 14.5 + extras (0.5 * qty2 = 1.0) = 15.5 ; line = 15.5 * 3 = 46.5
  assert.equal(s10.extrasUnitTotal, 1.0);
  assert.equal(s10.finalUnitPrice, 15.5);
  assert.equal(s10.lineTotal, 46.5);
});
t("legacy item with only final p: preserve p, safe base/extras split", () => {
  const s = normalizeOrderItem(f3);   // p=15, extras from text w/o prices
  assert.equal(s.finalUnitPrice, 15.0);   // commercial total preserved
  assert.equal(s.extrasUnitTotal, 0);     // unknown extra prices -> 0
  assert.equal(s.baseUnitPrice, 15.0);    // documented fallback: all to base
  assert.equal(s.lineTotal, 15.0);
  // extra name still captured from sub text
  assert.ok(s.extras.some((e) => e.name === "Provolone"));
  assert.equal(s.notes, "sin cebolla");
});

// ── extras parsing from legacy sub text ──
t("extras parsed from legacy sub, notes separated", () => {
  const s = normalizeOrderItem(f5);
  assert.deepEqual(s.extras.map((e) => e.name).sort(), ["Champiñones frescos", "Rúcula"]);
  assert.equal(s.notes, "");
});

// ── unknown / custom / beverage retained ──
t("unknown historical item retained with its values", () => {
  const s = normalizeOrderItem(f7);
  assert.equal(s.classicName, "Producto Viejo Desconocido");
  assert.equal(s.finalUnitPrice, 7.5);
  assert.equal(s.productId, null);
  assert.equal(s.legacyId, null);
});
t("beverage: quantity + line total", () => {
  const s = normalizeOrderItem(f6);
  assert.equal(s.finalUnitPrice, 2.5);
  assert.equal(s.lineTotal, 7.5);
  assert.deepEqual(s.extras, []);
});
t("removed ingredients + free note preserved", () => {
  const s = normalizeOrderItem(f9);
  assert.deepEqual(s.removedIngredients, ["Ajo"]);
  assert.equal(s.notes, "bien cocida");
});

// ── IMMUTABILITY ──
t("catalogue B (rename+reprice) does NOT alter an item that already has values", () => {
  const catB = { extras: [{ legacyKey: "ing_coppa", nombre: "Coppa DELUXE", precioDelta: 5.0, emoji: "💎" }] };
  const s = normalizeOrderItem(f1, { catalogue: catB });
  // explicit saved extra price/name win over catalogue
  assert.equal(s.extras[0].name, "Coppa");
  assert.equal(s.extras[0].price, 0.5);
  assert.equal(s.classicName, "Margherita Classica");
  assert.equal(s.finalUnitPrice, 12.5);
});
t("catalogue enrich fills ONLY missing extra price (legacy text item)", () => {
  const catB = { extras: [{ legacyKey: "ing_provolone", nombre: "Provolone", precioDelta: 0.5, emoji: "🧀" }] };
  const s = normalizeOrderItem(f3, { catalogue: catB });
  // f3 final p=15 is preserved regardless; enrich only annotates the extra record
  assert.equal(s.finalUnitPrice, 15.0);
  const prov = s.extras.find((e) => e.name === "Provolone");
  assert.equal(prov.price, 0.5);        // enriched name-match price
  assert.equal(prov.emoji, "🧀");
});
t("snapshot is deep-frozen (captured values cannot be mutated)", () => {
  const s = normalizeOrderItem(f1);
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.extras[0]));
  try { s.p = 999; } catch (e) { /* strict-mode throw ok */ }
  try { s.extras[0].price = 999; } catch (e) { /* ok */ }
  assert.equal(s.p, 12.5);          // unchanged whether or not assignment threw
  assert.equal(s.extras[0].price, 0.5);
});
t("re-normalizing an already-normalized snapshot is idempotent (no reprice)", () => {
  const once = normalizeOrderItem(f1);
  const twice = normalizeOrderItem(JSON.parse(JSON.stringify(once)));
  assert.equal(twice.finalUnitPrice, once.finalUnitPrice);
  assert.equal(twice.baseUnitPrice, once.baseUnitPrice);
  assert.equal(twice.classicName, once.classicName);
  assert.deepEqual(twice.extras.map((e) => [e.name, e.price]), once.extras.map((e) => [e.name, e.price]));
});
t("disabled/deleted product snapshot still normalizes & displays", () => {
  const s = normalizeOrderItem(f8);
  assert.equal(s.classicName, "Retirada");
  assert.equal(s.finalUnitPrice, 11.0);
  assert.equal(s.n, "Retirada");
});

// ── validation boundary ──
t("throws controlled validation error on non-object item", () => {
  assert.throws(() => normalizeOrderItem(null), (e) => e instanceof OrderItemValidationError);
  assert.throws(() => normalizeOrderItem("x"), (e) => e.validation === true);
});
t("throws controlled validation error when no usable price", () => {
  assert.throws(() => normalizeOrderItem({ n: "SinPrecio", q: 1 }), (e) => e.validation === true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
