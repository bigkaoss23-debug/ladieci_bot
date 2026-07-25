// Phase A hardening — Custom pizza configuration survives the backend round-trip.
// Offline: no DB, no LLM, no network.
//   Run: `node src/menu/__tests__/customSnapshotRoundtrip.test.js`
//
// Contract: a canonical Custom item keeps `custom`, `customBase`, `_ingredienti`,
// four structured `extras[]`, explicit `notes`, prices and quantities across
//   frontend item → normalizeOrderItem → JSON.stringify → JSON.parse.
// The generated `sub` configuration summary must NEVER become an operator note.
const assert = require("assert");
const { normalizeOrderItem } = require("../menuSnapshot");
const { normalizeItemsForPersist } = require("../../agents/agentOrdini");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("FAIL  " + name + " -> " + e.message); } };

// Canonical Custom item exactly as the frontend emits it (base Pelusa + 4 ingredients).
const mkCustom = (notes = "") => ({
  custom: true,
  customBase: { id: "base_pelusa", name: "Base Pelusa", price: 12 },
  _ingredienti: [
    { id: "i_tom", n: "Tomates confitados", prezzo: 0.5, e: "🍅" },
    { id: "i_ruc", n: "Rúcula", prezzo: 0.5, e: "🌿" },
    { id: "i_pim", n: "Pimiento", prezzo: 0.5, e: "🫑" },
    { id: "i_ber", n: "Berenjena", prezzo: 0.5, e: "🍆" },
  ],
  extras: [
    { key: "i_tom", name: "Tomates confitados", price: 0.5, emoji: "🍅", quantity: 1 },
    { key: "i_ruc", name: "Rúcula", price: 0.5, emoji: "🌿", quantity: 1 },
    { key: "i_pim", name: "Pimiento", price: 0.5, emoji: "🫑", quantity: 1 },
    { key: "i_ber", name: "Berenjena", price: 0.5, emoji: "🍆", quantity: 1 },
  ],
  notes, sub: "Base Pelusa + Tomates confitados, Rúcula, Pimiento, Berenjena",
  id: "custom_1", n: "Pizza a tu gusto", cat: "Pizzas", classicName: "Pizza a tu gusto",
  q: 1, quantity: 1, baseUnitPrice: 12, finalUnitPrice: 14, lineTotal: 14,
});
const roundtrip = (it) => JSON.parse(JSON.stringify(normalizeOrderItem(it)));

console.log("\n══ CUSTOM SNAPSHOT ROUND-TRIP (backend) ══");

// ── preservation ──
t("custom flag preserved", () => assert.strictEqual(roundtrip(mkCustom()).custom, true));
t("customBase identity + accepted price preserved", () => {
  const o = roundtrip(mkCustom());
  assert.strictEqual(o.customBase.id, "base_pelusa");
  assert.strictEqual(o.customBase.name, "Base Pelusa");
  assert.strictEqual(o.customBase.price, 12);
});
t("_ingredienti preserved (four compatibility records)", () => {
  const o = roundtrip(mkCustom());
  assert.strictEqual(o._ingredienti.length, 4);
  assert.deepStrictEqual(o._ingredienti.map(i => i.n), ["Tomates confitados", "Rúcula", "Pimiento", "Berenjena"]);
  assert.strictEqual(o._ingredienti[0].prezzo, 0.5);
});
t("four structured extras preserved", () => {
  const o = roundtrip(mkCustom());
  assert.strictEqual(o.extras.length, 4);
  assert.deepStrictEqual(o.extras.map(e => e.name), ["Tomates confitados", "Rúcula", "Pimiento", "Berenjena"]);
  assert.strictEqual(o.extras[0].price, 0.5);
});
t("explicit empty notes preserved (NOT derived from sub)", () => {
  const o = roundtrip(mkCustom(""));
  assert.strictEqual(o.notes, "");
  assert.ok(!o.notes.includes("Base Pelusa"));
});
t("manual note preserved exactly", () => {
  const o = roundtrip(mkCustom("Sin cortar"));
  assert.strictEqual(o.notes, "Sin cortar");
});
t("generated sub never becomes notes (empty stays empty)", () => {
  assert.strictEqual(roundtrip(mkCustom("")).notes, "");
});
t("price + quantity preserved", () => {
  const o = roundtrip(mkCustom());
  assert.strictEqual(o.finalUnitPrice, 14);
  assert.strictEqual(o.baseUnitPrice, 12);
  assert.strictEqual(o.q, 1);
  assert.strictEqual(o.quantity, 1);
  assert.strictEqual(o.lineTotal, 14);
});
t("legacy sub retained as readable compatibility summary", () => {
  assert.strictEqual(roundtrip(mkCustom()).sub, "Base Pelusa + Tomates confitados, Rúcula, Pimiento, Berenjena");
});
t("JSON round-trip is lossless for the Custom contract fields", () => {
  const snap = normalizeOrderItem(mkCustom("Sin cortar"));
  const rt = JSON.parse(JSON.stringify(snap));
  for (const k of ["custom", "notes", "finalUnitPrice", "q", "quantity", "lineTotal"]) assert.deepStrictEqual(rt[k], snap[k]);
  assert.deepStrictEqual(rt.customBase, snap.customBase);
  assert.strictEqual(rt.extras.length, snap.extras.length);
  assert.strictEqual(rt._ingredienti.length, snap._ingredienti.length);
});

// ── write boundaries (creaOrdine / modificaOrdine / aggiungiItems all use this) ──
t("normalizeItemsForPersist preserves the Custom snapshot", () => {
  const [o] = normalizeItemsForPersist([mkCustom("Sin cortar")]);
  assert.strictEqual(o.custom, true);
  assert.strictEqual(o.customBase.name, "Base Pelusa");
  assert.strictEqual(o.extras.length, 4);
  assert.strictEqual(o._ingredienti.length, 4);
  assert.strictEqual(o.notes, "Sin cortar");
});
t("write boundary still filters the delivery pseudo-item", () => {
  const out = normalizeItemsForPersist([{ n: "Entrega a domicilio", p: 2 }, mkCustom()]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].custom, true);
});
t("write boundary throws on invalid item (no partial write)", () => {
  assert.throws(() => normalizeItemsForPersist([mkCustom(), { n: "roto" /* no price */ }]));
});

// ── validation / immutability ──
t("Custom base accepted price is normalized numerically (string → number)", () => {
  const o = roundtrip({ ...mkCustom(), customBase: { id: "base_pelusa", name: "Base Pelusa", price: "12" } });
  assert.strictEqual(o.customBase.price, 12);
});
t("invalid/missing customBase does not throw and is simply omitted", () => {
  const o1 = roundtrip({ ...mkCustom(), customBase: null });
  assert.ok(!("customBase" in o1));
  assert.strictEqual(o1.custom, true); // still a Custom item
  const o2 = roundtrip({ ...mkCustom(), customBase: "garbage" });
  assert.ok(!("customBase" in o2));
});

// ── legacy compatibility ──
t("legacy Custom with only n/p/q/sub remains readable (custom via id)", () => {
  const o = roundtrip({ id: "custom_9", n: "Pizza a tu gusto", p: 13, q: 1, cat: "Pizzas",
    sub: "+Champiñones, +Rúcula", custom: true });
  assert.strictEqual(o.custom, true);
  assert.strictEqual(o.p, 13);
  assert.ok(!("customBase" in o));       // nothing to preserve → omitted, not invented
  assert.ok(!("_ingredienti" in o));
  assert.strictEqual(o.extras.length, 2); // derived from sub, still readable
});
t("previous canonical Custom missing customBase still preserves custom + extras", () => {
  const it = mkCustom(); delete it.customBase;
  const o = roundtrip(it);
  assert.strictEqual(o.custom, true);
  assert.ok(!("customBase" in o));
  assert.strictEqual(o._ingredienti.length, 4);
  assert.strictEqual(o.extras.length, 4);
});
t("unknown Custom base id/name is preserved verbatim (no catalogue rename)", () => {
  const o = roundtrip({ ...mkCustom(), customBase: { id: "base_desconocida", name: "Base Rara", price: 10 } });
  assert.strictEqual(o.customBase.id, "base_desconocida");
  assert.strictEqual(o.customBase.name, "Base Rara");
  assert.strictEqual(o.customBase.price, 10);
});
t("Custom with extras but NO _ingredienti keeps extras; omits _ingredienti", () => {
  const it = mkCustom(); delete it._ingredienti;
  const o = roundtrip(it);
  assert.strictEqual(o.extras.length, 4);
  assert.ok(!("_ingredienti" in o));
  assert.strictEqual(o.custom, true);
});

// ── normal items untouched ──
t("normal (non-Custom) item gains NO custom fields", () => {
  const o = roundtrip({ productId: "uuid-1", n: "Margherita", classicName: "Margherita", cat: "Pizzas", p: 12, q: 1,
    extras: [{ key: "ing_coppa", name: "Coppa", price: 0.5, quantity: 1 }] });
  assert.ok(!("custom" in o));
  assert.ok(!("customBase" in o));
  assert.ok(!("_ingredienti" in o));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
