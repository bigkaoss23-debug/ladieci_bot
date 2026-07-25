// Phase A — write-boundary proof. Offline: no DB/LLM/network.
// Proves createOrden/modificaOrdine/aggiungiItems normalize items to the
// canonical snapshot before persistence, filter the delivery pseudo-item,
// preserve commercial totals, and abort on a critically malformed item.
// Run: `node src/menu/__tests__/orderWriteBoundary.test.js`
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { normalizeItemsForPersist } = require("../../agents/agentOrdini");
const { calcolaTotaleOrdine } = require("../../utils/helpers");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("FAIL  " + name + " -> " + e.message); } };

const dynItem = {
  productId: "uuid-1", legacyId: 1, legacyKey: "el_pelusa", officialNumber: 1,
  classicName: "Margherita Classica", fantasyName: "El Pelusa", category: "Pizzas", emoji: "🍕",
  quantity: 2, q: 2, baseUnitPrice: 12.0,
  extras: [{ key: "ing_coppa", name: "Coppa", price: 0.5, quantity: 1 }],
  p: 12.5, n: "El Pelusa", sub: "+Coppa",
};
const waItem = { n: "Diavola", p: 13.0, q: 1, cat: "Pizzas" };
const fakeDelivery = { n: "Entrega a domicilio", p: 2.5, q: 1 };

t("delivery pseudo-item is filtered out at the boundary", () => {
  const out = normalizeItemsForPersist([dynItem, fakeDelivery, waItem]);
  assert.equal(out.length, 2);
  assert.ok(!out.some((i) => i.n === "Entrega a domicilio"));
});

t("every persisted item carries the canonical snapshot (snapshotVersion + fields)", () => {
  const out = normalizeItemsForPersist([dynItem, waItem]);
  for (const it of out) {
    assert.equal(it.snapshotVersion, 1);
    for (const k of ["classicName", "fantasyName", "baseUnitPrice", "extrasUnitTotal", "finalUnitPrice", "lineTotal", "extras"]) {
      assert.ok(k in it, "missing canonical " + k);
    }
    // legacy fields still present for current views
    for (const k of ["id", "n", "p", "q", "sub", "cat"]) assert.ok(k in it, "missing legacy " + k);
  }
});

t("commercial totals unchanged by normalization (calcolaTotaleOrdine parity)", () => {
  const before = calcolaTotaleOrdine([dynItem, waItem], "RITIRO");
  const after = calcolaTotaleOrdine(normalizeItemsForPersist([dynItem, waItem]), "RITIRO");
  assert.equal(after, before);
});

t("dynamic item price split is exact; WA item preserves its final price", () => {
  const [dyn, wa] = normalizeItemsForPersist([dynItem, waItem]);
  assert.equal(dyn.baseUnitPrice, 12.0);
  assert.equal(dyn.extrasUnitTotal, 0.5);
  assert.equal(dyn.finalUnitPrice, 12.5);
  assert.equal(dyn.lineTotal, 25.0);       // 12.5 * 2
  assert.equal(wa.finalUnitPrice, 13.0);   // preserved, no reprice
});

t("a critically malformed item aborts the whole batch (controlled error)", () => {
  assert.throws(() => normalizeItemsForPersist([dynItem, { n: "SinPrecio" }]), (e) => e.validation === true);
});

t("empty / non-array input yields empty item list (no throw)", () => {
  assert.deepEqual(normalizeItemsForPersist([]), []);
  assert.deepEqual(normalizeItemsForPersist(undefined), []);
  assert.deepEqual(normalizeItemsForPersist(null), []);
});

// ── wiring proof: the three write boundaries call normalizeItemsForPersist ──
t("createOrden/modificaOrdine/aggiungiItems all call the normalizer", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "agents", "agentOrdini.js"), "utf8");
  // creaOrdine
  const crea = src.slice(src.indexOf("async function creaOrdine"), src.indexOf("async function", src.indexOf("async function creaOrdine") + 1));
  assert.ok(/itemsFinali\s*=\s*normalizeItemsForPersist\(/.test(crea), "creaOrdine not wired");
  // modificaOrdine
  assert.ok(/upd\.items\s*=\s*normalizeItemsForPersist\(updates\.items\)/.test(src), "modificaOrdine not wired");
  // aggiungiItems
  assert.ok(/cleanedNew\s*=\s*normalizeItemsForPersist\(newItems\)/.test(src), "aggiungiItems not wired");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
