'use strict';

// MESA_SEND_TO_KITCHEN_P0_FIX (2026-08-14) — COMPLEX_CANONICAL_CART_TO_MESA_
// PAYLOAD. Feeds the REAL canonical-picker item shapes (0e3f934, the
// deployed frontend baseline for this fix) straight through the REAL
// normalizeOrderItem/normalizeItemsForPersist boundary (no mocking) --
// proving the exact payload a complex Mesa draft produces is accepted and
// faithfully persisted, not merely that some abstract shape would be.
//
// Covers every canonical picker feature in one draft: a duplicate-quantity
// line (Goal 5 aggregation), a split-on-edit pair (Goal 5's "IMPORTANT --
// EDITING A QUANTITY > 1 LINE" rule -- one plain + one configured line from
// the same original product), extras + a removed base ingredient, a Custom
// pizza with a multi-quantity ingredient (Goal 11), and a beverage.

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeOrderItem } = require('../src/menu/menuSnapshot');
const { createMesaService, MesaServiceError } = require('../src/tables/mesaService');

const ctx = (overrides = {}) => ({
  actor: 'operator_primary', role: 'operator', workspaceId: 'ws-1',
  sessionVersion: 1, sid: 'sid', ...overrides,
});

// ── Exact shapes MesaOrderBuilder.jsx's buildEmittedItem / the Custom
// builder emit (see useOrderCart.js / PizzaCustomBuilder.jsx). ──────────────

// 1) Duplicate-quantity line: two bare taps on the same product merge (Goal
// 5) into ONE line at q=2 before ever reaching the backend.
const marinaraQty2 = {
  id: 3, databaseId: undefined, legacyKey: undefined, n: 'O Rei',
  classicName: 'Marinara Classica', fantasyName: 'O Rei',
  baseUnitPrice: 10, extras: [], notes: '', removedIngredients: [],
  q: 2, quantity: 2, p: 10, cat: 'Pizzas', sub: '',
};

// 2) Split-on-edit pair: originally "2× Margherita Classica", operator
// edited ONE unit (+extra, removed a base ingredient) -- must split into
// 1× plain + 1× configured, never silently apply to both units.
const margheritaPlain = {
  id: 1, n: 'El Pelusa', classicName: 'Margherita Classica', fantasyName: 'El Pelusa',
  baseUnitPrice: 12, extras: [], notes: '', removedIngredients: [],
  q: 1, quantity: 1, p: 12, cat: 'Pizzas', sub: '',
};
const margheritaConfigured = {
  id: 1, n: 'El Pelusa', classicName: 'Margherita Classica', fantasyName: 'El Pelusa',
  baseUnitPrice: 12, extras: [{ key: 'ing_jamon', name: 'Jamón cocido', price: 0.5, emoji: '🍖', quantity: 1 }],
  notes: 'poco hecha', removedIngredients: ['Albahaca fresca'],
  q: 1, quantity: 1, p: 12.5, cat: 'Pizzas', sub: '+Jamón cocido, poco hecha',
};

// 3) Custom pizza with a multi-quantity ingredient (Goal 11) -- the exact
// shape PizzaCustomBuilder.jsx's handleAdd() emits.
const customPizzaQty2Ingredient = {
  id: 'custom_1723660000000', custom: true, n: 'Pizza a tu gusto', e: '⭐', cat: 'Pizzas',
  q: 1, quantity: 1,
  customBase: { id: 'base_pelusa', name: 'Base Pelusa', price: 12 },
  baseUnitPrice: 12, p: 13, finalUnitPrice: 13,
  _ingredienti: [{ id: 'ing_albahaca', n: 'Albahaca fresca', e: '🌿', prezzo: 0.5, quantity: 2 }],
  extras: [{ key: 'ing_albahaca', name: 'Albahaca fresca', price: 0.5, emoji: '🌿', quantity: 2 }],
  notes: '', removedIngredients: [],
  sub: 'Base Pelusa + Albahaca fresca ×2', ing: 'Base Pelusa + Albahaca fresca ×2',
};

// 4) A beverage -- the simplest legitimate item shape.
const beverage = {
  id: 46, n: 'Aquarius Naranja', classicName: '', fantasyName: 'Aquarius Naranja',
  baseUnitPrice: 2, extras: [], notes: '', removedIngredients: [],
  q: 1, quantity: 1, p: 2, cat: 'Bebidas', sub: '',
};

const complexCart = [marinaraQty2, margheritaPlain, margheritaConfigured, customPizzaQty2Ingredient, beverage];

test('COMPLEX_CANONICAL_CART_TO_MESA_PAYLOAD: every canonical picker item shape survives normalizeOrderItem without throwing', () => {
  const normalized = complexCart.map((item) => normalizeOrderItem(item));
  assert.equal(normalized.length, 5);
});

test('duplicate-quantity line keeps its quantity, no silent collapse to 1', () => {
  const snap = normalizeOrderItem(marinaraQty2);
  assert.equal(snap.quantity, 2);
  assert.equal(snap.q, 2);
  assert.equal(snap.lineTotal, 20);
});

test('split-on-edit pair: the plain unit and the configured unit stay genuinely distinct after normalization', () => {
  const plain = normalizeOrderItem(margheritaPlain);
  const configured = normalizeOrderItem(margheritaConfigured);
  assert.equal(plain.quantity, 1);
  assert.equal(configured.quantity, 1);
  assert.deepEqual(plain.extras, []);
  assert.equal(configured.extras.length, 1);
  assert.equal(configured.extras[0].name, 'Jamón cocido');
  assert.deepEqual(plain.removedIngredients, []);
  assert.deepEqual(configured.removedIngredients, ['Albahaca fresca']);
  assert.equal(plain.notes, '');
  assert.equal(configured.notes, 'poco hecha');
  // Neither unit's price/notes leaked into the other -- the exact defect
  // "silently apply the edit to both units" would produce.
  assert.equal(plain.finalUnitPrice, 12);
  assert.equal(configured.finalUnitPrice, 12.5);
});

test('Custom pizza with a multi-quantity ingredient (Goal 11) survives with its real quantity and structured base intact', () => {
  const snap = normalizeOrderItem(customPizzaQty2Ingredient);
  assert.equal(snap.custom, true);
  assert.equal(snap.customBase.id, 'base_pelusa');
  assert.equal(snap.customBase.price, 12);
  assert.equal(snap.extras.length, 1);
  assert.equal(snap.extras[0].name, 'Albahaca fresca');
  assert.equal(snap.extras[0].quantity, 2);
  assert.equal(snap._ingredienti[0].quantity, 2);
  // GOAL 16 -- the "Base Pelusa" bug: notes must be genuinely empty, never
  // the legacy description text ("Base Pelusa + Albahaca fresca ×2").
  assert.equal(snap.notes, '');
  assert.equal(snap.finalUnitPrice, 13);
});

test('the beverage line normalizes cleanly with no phantom extras/removals', () => {
  const snap = normalizeOrderItem(beverage);
  assert.deepEqual(snap.extras, []);
  assert.deepEqual(snap.removedIngredients, []);
  assert.equal(snap.finalUnitPrice, 2);
});

test('the whole complex cart is accepted end-to-end by mesaService.addCommand (real createOrder call shape, no mock shortcuts on validation)', async () => {
  let insertedItems = null;
  const service = createMesaService({
    dao: { getSession: async () => ({ id: 'session-1', status: 'open', covers_total: 4 }) },
    createOrder: async (payload) => {
      // language-guard: allow-legacy agentOrdini/creaOrdine are the existing backend module/function names this test exercises, not new vocabulary
      // Mirrors agentOrdini.creaOrdine's own first real step: normalize
      // every item before insert (Phase A -- "throws -> order not saved").
      insertedItems = payload.items.map((it) => normalizeOrderItem(it));
      return { success: true, id: '#900' };
    },
  });
  const result = await service.addCommand({
    context: ctx(), tableSessionId: 'session-1', items: complexCart, clientRequestId: 'complex-cart-0001',
  });
  assert.equal(result.orderId, '#900');
  assert.equal(insertedItems.length, 5);
  const total = insertedItems.reduce((sum, it) => sum + it.lineTotal, 0);
  // 20 + 12 + 12.5 + 13 + 2 = 59.5
  assert.equal(Math.round(total * 100) / 100, 59.5);
});

test('a malformed item (no usable price at all) is rejected -- proves the boundary genuinely validates, not a no-op pass-through', () => {
  assert.throws(
    () => normalizeOrderItem({ n: 'Ghost item', cat: 'Pizzas' }),
    (error) => error.name === 'OrderItemValidationError',
  );
});
