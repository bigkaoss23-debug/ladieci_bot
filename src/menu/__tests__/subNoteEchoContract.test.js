// HARDEN CANONICAL NOTE CONTRACT — the manual note must NEVER be echoed into `sub`.
// Offline: no DB, no LLM, no network. Run: `node src/menu/__tests__/subNoteEchoContract.test.js`
//
// Regression guard for the proven defect: a canonical note-only item persisted as
//   extras=[], notes="Hornear bien", sub="Hornear bien"
// (buildLegacySub appended notes when incoming sub was empty). The canonical
// contract: `sub` = configuration/compatibility text only; the note lives in
// `notes` and is never copied into `sub` for canonical snapshotVersion items.
const assert = require("assert");
const { normalizeOrderItem, SNAPSHOT_VERSION } = require("../menuSnapshot");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("FAIL  " + name + " -> " + e.message); } };

console.log("\n══ SUB / NOTE ECHO CONTRACT ══");

// ── Case 1: canonical extras + note (incoming config-only sub) ──
t("1: canonical extras+note → extras & notes preserved, sub config-only (no note)", () => {
  const o = normalizeOrderItem({
    id: 17, n: "KitKat", classicName: "Pizza KitKat", cat: "Pizzas Dulces",
    p: 11.5, q: 1, baseUnitPrice: 10.5, finalUnitPrice: 11.5,
    extras: [
      { key: "sweet_kitkat", name: "KitKat", price: 0.5, quantity: 1 },
      { key: "sweet_pistacho", name: "Pistacho", price: 0.5, quantity: 1 },
    ],
    notes: "Sin cortar", sub: "+KitKat, +Pistacho",
  });
  assert.equal(o.snapshotVersion, SNAPSHOT_VERSION);
  assert.equal(o.extras.length, 2);
  assert.equal(o.extras[0].name, "KitKat");
  assert.equal(o.extras[1].name, "Pistacho");
  assert.equal(o.notes, "Sin cortar");
  assert.equal(o.sub, "+KitKat, +Pistacho");
  assert.ok(!o.sub.includes("Sin cortar"), "sub must not contain the note");
});

// ── Case 1b: canonical extras + note but EMPTY incoming sub (rebuild path) ──
t("1b: canonical extras+note, empty incoming sub → sub rebuilt from extras only", () => {
  const o = normalizeOrderItem({
    id: 17, n: "KitKat", cat: "Pizzas Dulces", p: 11.5, q: 1,
    baseUnitPrice: 10.5, finalUnitPrice: 11.5,
    extras: [{ key: "sweet_kitkat", name: "KitKat", price: 0.5, quantity: 1 }],
    notes: "Sin cortar", sub: "",
  });
  assert.equal(o.sub, "+KitKat");
  assert.ok(!o.sub.includes("Sin cortar"), "note must not be echoed into rebuilt sub");
  assert.equal(o.notes, "Sin cortar");
});

// ── Case 2: canonical extras only ──
t("2: canonical extras only → extras preserved, notes empty, sub config-only", () => {
  const o = normalizeOrderItem({
    id: 17, n: "KitKat", cat: "Pizzas Dulces", p: 11.5, q: 1,
    baseUnitPrice: 10.5, finalUnitPrice: 11.5,
    extras: [{ key: "sweet_kitkat", name: "KitKat", price: 0.5, quantity: 2 }],
    notes: "", sub: "",
  });
  assert.equal(o.extras.length, 1);
  assert.equal(o.extras[0].quantity, 2);
  assert.equal(o.notes, "");
  assert.equal(o.sub, "+KitKat ×2");
});

// ── Case 3: canonical note only — THE PROVEN DEFECT ──
t("3: canonical note only → extras empty, notes preserved, sub empty (sub != notes)", () => {
  const o = normalizeOrderItem({
    id: 17, n: "KitKat", cat: "Pizzas Dulces", p: 10.5, q: 1,
    baseUnitPrice: 10.5, finalUnitPrice: 10.5,
    extras: [], notes: "Hornear bien", sub: "",
  });
  assert.equal(o.extras.length, 0);
  assert.equal(o.notes, "Hornear bien");
  assert.equal(o.sub, "", "note-only item must persist sub='' (was the defect: sub=notes)");
  assert.notEqual(o.sub, o.notes);
});

// ── Case 4: canonical neither ──
t("4: canonical neither → no phantom sub, no phantom notes", () => {
  const o = normalizeOrderItem({
    id: 17, n: "KitKat", cat: "Pizzas Dulces", p: 10.5, q: 1,
    baseUnitPrice: 10.5, finalUnitPrice: 10.5,
    extras: [], notes: "", sub: "",
  });
  assert.equal(o.sub, "");
  assert.equal(o.notes, "");
  assert.equal(o.extras.length, 0);
});

// ── Case 5: canonical Custom ──
t("5: canonical Custom → base/ingredients/note separated, generated config sub kept, note NOT in sub", () => {
  const o = normalizeOrderItem({
    id: "custom_1", custom: true, n: "Pizza a tu gusto", classicName: "Pizza a tu gusto",
    cat: "Pizzas", p: 12, q: 1, baseUnitPrice: 8, finalUnitPrice: 12,
    customBase: { id: "base_pelusa", name: "Base Pelusa", price: 8 },
    _ingredienti: [{ id: "i_tom", n: "Tomate", prezzo: 1, e: "🍅" }],
    extras: [{ key: "i_tom", name: "Tomate", price: 1, emoji: "🍅", quantity: 1 }],
    notes: "Sin cortar", sub: "Base Pelusa + Tomate",
  });
  assert.equal(o.custom, true);
  assert.equal(o.customBase.name, "Base Pelusa");
  assert.equal(o.customBase.price, 8);
  assert.ok(Array.isArray(o._ingredienti) && o._ingredienti.length === 1);
  assert.equal(o.notes, "Sin cortar");
  assert.equal(o.sub, "Base Pelusa + Tomate", "generated Custom config sub preserved verbatim");
  assert.ok(!o.sub.includes("Sin cortar"), "manual note must not be duplicated into Custom sub");
});

// ── Case 5b: canonical Custom, empty incoming sub → note still not echoed ──
t("5b: canonical Custom with empty sub → note NOT echoed into rebuilt sub", () => {
  const o = normalizeOrderItem({
    id: "custom_2", custom: true, n: "Pizza a tu gusto", cat: "Pizzas", p: 12, q: 1,
    baseUnitPrice: 8, finalUnitPrice: 12,
    customBase: { id: "base_pelusa", name: "Base Pelusa", price: 8 },
    extras: [{ key: "i_tom", name: "Tomate", price: 1, quantity: 1 }],
    notes: "Sin cortar", sub: "",
  });
  assert.equal(o.notes, "Sin cortar");
  assert.ok(!o.sub.includes("Sin cortar"), "note not echoed into Custom rebuilt sub");
  assert.equal(o.sub, "+Tomate"); // rebuilt from extras only
});

// ── Case 6: legacy sub-only item remains readable/compatible ──
t("6: legacy sub-only item → original sub preserved verbatim (readable, no rewrite)", () => {
  const o = normalizeOrderItem({ id: 8, n: "Il Tulipano Nero", sub: "+Provolone, sin cebolla", p: 15, q: 1, cat: "Pizzas", e: "🧀", num: 8 });
  assert.equal(o.sub, "+Provolone, sin cebolla", "legacy sub preserved for frontend fallback");
  // notes derived from legacy sub free-text (frontend fallback contract)
  assert.equal(o.notes, "sin cebolla");
});

// ── quantity / price / lineTotal untouched by the sub fix ──
t("prices & quantities unchanged by the sub/note fix", () => {
  const o = normalizeOrderItem({
    id: 17, n: "KitKat", cat: "Pizzas Dulces", p: 11.5, q: 3,
    baseUnitPrice: 10.5, finalUnitPrice: 11.5,
    extras: [{ key: "sweet_kitkat", name: "KitKat", price: 0.5, quantity: 1 }],
    notes: "Sin cortar", sub: "",
  });
  assert.equal(o.q, 3);
  assert.equal(o.quantity, 3);
  assert.equal(o.finalUnitPrice, 11.5);
  assert.equal(o.lineTotal, 34.5);
  assert.equal(o.extras[0].price, 0.5);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
