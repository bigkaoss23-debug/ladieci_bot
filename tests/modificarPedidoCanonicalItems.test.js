// tests/modificarPedidoCanonicalItems.test.js — NF-1 / NF-2 (Modificar pedido canonical
// item editing).
//
// 1. Unit: the edit-boundary reconciliation in src/menu/menuSnapshot.js
//    (reconcileEditedOrderItem / normalizeEditedOrderItem / mergeOrderLines).
// 2. Behavioral: the two item-editing writers, real module code against a stubbed Supabase
//    transport (require.cache injection, same harness as economicWriterHardeningV1.test.js —
//    no network, no DB), driven by REAL frontend payloads captured from the Modificar pedido
//    modal: FE 04c2b10 (the editor that caused NF-1/NF-2) and the fixed editor.
//    See tests/fixtures/modificarPedidoModalPayloads.js.
//
// The DB fences are emulated only where a writer cannot see them itself: N-5 (paid order,
// BEFORE UPDATE on totale/delivery_fee/descuento_*) is answered by the stubbed sbUpdate with
// the PostgREST error body the trigger raises. E-1's adjustment case is answered by the
// writer's own anticipated pre-check (order_obligations lookup), exactly as in production.
// Run: node tests/modificarPedidoCanonicalItems.test.js
"use strict";
const path = require("path");

const P = require("./fixtures/modificarPedidoModalPayloads");
const {
  normalizeOrderItem, reconcileEditedOrderItem, normalizeEditedOrderItem, mergeOrderLines,
  sameOrderLineConfiguration, ORDER_ITEM_PAYLOAD_INCONSISTENT,
} = require("../src/menu/menuSnapshot");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (detail ? " — " + detail : "")); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const throwsCode = (fn, field) => {
  try { fn(); return false; } catch (e) { return e.code === ORDER_ITEM_PAYLOAD_INCONSISTENT && (!field || e.field === field); }
};
const tagCounts = (sub) => {
  const counts = {};
  String(sub || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("+")).forEach((tag) => {
    const m = tag.match(/\s*[×x]\s*(\d+)\s*$/i);
    const name = tag.replace(/^\+/, "").replace(/\s*[×x]\s*\d+\s*$/i, "").trim();
    counts[name] = (counts[name] || 0) + (m ? Number(m[1]) : 1);
  });
  return counts;
};

// Every persisted line is internally coherent, and the order total derives from its lines.
function economics(items, { deliveryFee = 0, discount = 0 } = {}) {
  const lines = items.map((it) => ({
    name: it.n, quantity: it.quantity, unitPrice: it.finalUnitPrice, extrasAmount: it.extrasUnitTotal, lineTotal: it.lineTotal,
  }));
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  return { lines, subtotal, deliveryFee, discount, total: round2(subtotal + deliveryFee - discount) };
}
function coherent(items) {
  return items.every((it) => {
    const extrasSum = round2((it.extras || []).reduce((s, e) => s + e.price * e.quantity, 0));
    const tags = tagCounts(it.sub);
    const structured = {};
    (it.extras || []).forEach((e) => { structured[e.name] = (structured[e.name] || 0) + e.quantity; });
    const tagsMatch = it.custom === true || JSON.stringify(Object.entries(tags).sort()) === JSON.stringify(Object.entries(structured).sort());
    return it.q === it.quantity
      && it.p === it.finalUnitPrice
      && it.extrasUnitTotal === extrasSum
      && it.finalUnitPrice === round2(it.baseUnitPrice + extrasSum)
      && it.lineTotal === round2(it.finalUnitPrice * it.quantity)
      && tagsMatch;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── unit: reconcileEditedOrderItem (quantity) ──");
{
  const saved = clone(P.savedOrders.R0.items[0]);
  const r = reconcileEditedOrderItem({ ...saved, q: 2 });
  check("B1 unit: q=2 + stale quantity=1 (lineTotal still the saved snapshot) → quantity 2", r.quantity === 2 && r.q === 2);
  const r2 = reconcileEditedOrderItem({ ...saved, quantity: 2 });
  check("canonical field edited, working mirror stale → quantity 2", r2.quantity === 2 && r2.q === 2);
  check("q=2, quantity=3, lineTotal matching neither → refused (field quantity)",
    throwsCode(() => reconcileEditedOrderItem({ ...saved, q: 2, quantity: 3 }), "quantity"));
  check("q≠quantity without a lineTotal to tell them apart → refused",
    throwsCode(() => reconcileEditedOrderItem({ ...saved, q: 2, lineTotal: undefined }), "quantity"));
  check("a coherent saved line passes through untouched",
    JSON.stringify(normalizeEditedOrderItem(saved)) === JSON.stringify(normalizeOrderItem(saved)));
  check("coherent q/quantity with a stale lineTotal → refused (field lineTotal)",
    throwsCode(() => reconcileEditedOrderItem({ ...saved, q: 2, quantity: 2, lineTotal: 14.5 }), "lineTotal"));
}

console.log("\n── unit: reconcileEditedOrderItem (structured price) ──");
{
  const saved = clone(P.savedOrders.R0.items[0]);
  const withExtra = { ...saved, extras: [{ key: "ing_albahaca", name: "Albahaca fresca", price: 0.5, emoji: "🌿", quantity: 1 }], extrasUnitTotal: 0.5, finalUnitPrice: 15, p: 15, lineTotal: 15, sub: "+Albahaca fresca" };
  const n = normalizeEditedOrderItem(withExtra);
  check("B3 unit: structured extra → finalUnitPrice = base + extras (15)", n.finalUnitPrice === 15 && n.p === 15 && n.extrasUnitTotal === 0.5 && n.lineTotal === 15);
  check("B5 unit: p raised but extras[] stale (the old editor) → refused (field p)",
    throwsCode(() => reconcileEditedOrderItem({ ...saved, p: 15, sub: "+Albahaca fresca" }), "p"));
  check("B5 unit: finalUnitPrice disagreeing with base + extras → refused (field finalUnitPrice)",
    throwsCode(() => reconcileEditedOrderItem({ ...withExtra, p: undefined, finalUnitPrice: 14.5, lineTotal: 14.5 }), "finalUnitPrice"));
  check("B5 unit: extrasUnitTotal disagreeing with extras[] → refused (field extrasUnitTotal)",
    throwsCode(() => reconcileEditedOrderItem({ ...withExtra, extrasUnitTotal: 0 }), "extrasUnitTotal"));
  check("B5 unit: a '+tag' in sub with no structured extra (price unchanged) → refused (field sub)",
    throwsCode(() => reconcileEditedOrderItem({ ...saved, sub: "+Albahaca fresca" }), "sub"));
  check("B5 unit: a structured extra missing from the sub tags → refused (field sub)",
    throwsCode(() => reconcileEditedOrderItem({ ...withExtra, sub: "" }), "sub"));
  check("a note next to the tags is fine",
    normalizeEditedOrderItem({ ...withExtra, sub: "bien hecha, +Albahaca fresca" }).finalUnitPrice === 15);
  check("tags written as '+Name ×2' match a structured quantity 2",
    normalizeEditedOrderItem({ ...saved, extras: [{ key: null, name: "Rúcula", price: 0.5, quantity: 2 }], extrasUnitTotal: 1, finalUnitPrice: 15.5, p: 15.5, lineTotal: 15.5, sub: "+Rúcula ×2" }).finalUnitPrice === 15.5);
  const custom = clone(P.savedLines.customPizza);
  check("a Custom pizza (generated description in sub) is not held to the tag rule",
    normalizeEditedOrderItem(custom).finalUnitPrice === 13.5);
}

console.log("\n── unit: every saved staging line shape is a no-op through the edit boundary ──");
{
  const shapes = [...P.savedOrders.R0.items, ...P.savedLines.order999014];
  const same = shapes.every((it) => JSON.stringify(normalizeEditedOrderItem(it)) === JSON.stringify(normalizeOrderItem(it)));
  check(`${shapes.length} real saved lines (#999008, #999014 incl. Custom) normalize identically through the edit boundary`, same);
  const idempotent = shapes.every((it) => {
    const once = normalizeEditedOrderItem(it);
    return JSON.stringify(normalizeEditedOrderItem(clone(once))) === JSON.stringify(once);
  });
  check("the edit boundary is idempotent (save → reload → save)", idempotent);
}

console.log("\n── unit: mergeOrderLines / sameOrderLineConfiguration ──");
{
  const saved = clone(P.savedOrders.R0.items);
  const plainAddition = normalizeOrderItem({ n: "Il Tulipano Nero", p: 14.5, q: 1, id: 8 });
  check("same product, same configuration → same line", sameOrderLineConfiguration(normalizeOrderItem(saved[0]), plainAddition));
  const merged = mergeOrderLines(saved, [{ n: "Il Tulipano Nero", p: 14.5, q: 1, id: 8 }]);
  check("B9 unit: identical plain line sums its canonical quantity (q, quantity, lineTotal)",
    merged.length === 2 && merged[0].quantity === 2 && merged[0].q === 2 && merged[0].lineTotal === 29);
  const withExtra = mergeOrderLines(saved, [{ n: "Il Tulipano Nero", p: 15, q: 1, id: 8, sub: "+Albahaca fresca" }]);
  check("B10 unit: same product with an extra stays its own line", withExtra.length === 3 && withExtra[0].quantity === 1);
  const withNote = mergeOrderLines(saved, [{ n: "Il Tulipano Nero", p: 14.5, q: 1, id: 8, sub: "sin cebolla" }]);
  check("same product with a note stays its own line", withNote.length === 3);
  const dupRows = clone(P.savedOrders.R_dup.items);
  const intoPlain = mergeOrderLines(dupRows, [{ n: "Il Tulipano Nero", p: 14.5, q: 1, id: 8 }]);
  check("a plain addition goes to the plain row, never to the configured row of the same product",
    intoPlain.length === 3 && intoPlain[0].quantity === 2 && intoPlain[1].quantity === 1);
  check("a Custom pizza never merges", sameOrderLineConfiguration(P.savedLines.customPizza, P.savedLines.customPizza) === false);
}

// ═══════════════════════════════════════════════════════════════════════════
async function testWriters() {
  const supaPath = require.resolve("../src/utils/supabase");
  require(supaPath);
  const supa = require.cache[supaPath].exports;

  let STORE = {};
  let ADJUSTED = {}; // order_uid -> carries a commercial-adjustment revision
  let PAID = {};     // order id -> payment evidence (N-5 answers in the DB)
  const updateCalls = [];
  const moves = (row, patch, fields) => fields.some((f) => patch[f] !== undefined
    && (patch[f] == null ? null : Number(patch[f])) !== (row[f] == null ? null : Number(row[f])));

  supa.sbSelect = async (table, query = "") => {
    if (table === "order_obligations") {
      const m = query.match(/order_uid=eq\.([^&]+)/);
      const uid = m ? decodeURIComponent(m[1]) : null;
      return uid && ADJUSTED[uid] ? [{ id: "ob-" + uid }] : [];
    }
    if (table === "ordenes") {
      const m = query.match(/id=eq\.([^&]+)/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        return STORE[id] ? [clone(STORE[id])] : [];
      }
    }
    return [];
  };
  supa.sbUpdate = async (table, filter, patch) => {
    updateCalls.push({ table, filter, patch: clone(patch) });
    if (table === "ordenes") {
      const m = filter.match(/id=eq\.([^&]+)/);
      const id = m ? decodeURIComponent(m[1]) : null;
      const row = id && STORE[id];
      if (row && PAID[id] && moves(row, patch, ["totale", "delivery_fee", "descuento_valor", "descuento_importe"])) {
        return { code: "P0001", message: "PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN", details: `order_id=${id}`, hint: null };
      }
      if (row) STORE[id] = { ...row, ...clone(patch) };
    }
    return [];
  };
  supa.sbInsert = async () => [];
  supa.sbUpsert = async () => ({});
  supa.sbDelete = async () => ({});
  supa.getConfig = async () => ({});

  const mgPath = require.resolve("../src/agents/manualGiros");
  require(mgPath);
  require.cache[mgPath].exports.getManualGiros = async () => [];
  require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ ok: true });

  // language-guard: allow-legacy agentOrdini is the existing module path, required once here
  const writers = require(path.join("..", "src", "agents", "agentOrdini"));
  // language-guard: allow-legacy modificaOrdine is the existing exported writer name, aliased once here
  const { modificaOrdine: editOrder, aggiungiItems: addToOrder } = writers;

  function seed(key, overrides = {}) {
    const row = clone(P.savedOrders[key]);
    STORE[row.id] = { ...row, ...overrides };
    updateCalls.length = 0;
    return row.id;
  }
  const ordenesPatches = () => updateCalls.filter((c) => c.table === "ordenes");
  // index.js updateOrden dispatcher: the edit writer, 409 on a typed refusal.
  async function dispatch(body) {
    const result = await editOrder(body.id, { ...clone(body), operatorManual: true });
    return { status: result && result.success === false ? 409 : 200, result };
  }
  function expectEdit(label, id, res, { quantities, total, lineChecks }) {
    const row = STORE[id];
    const eco = economics(row.items);
    check(`${label} → 200 success`, res.status === 200 && res.result.success === true, JSON.stringify(res.result));
    check(`${label} → persisted quantities ${JSON.stringify(quantities)}`, JSON.stringify(row.items.map((i) => i.quantity)) === JSON.stringify(quantities),
      JSON.stringify(row.items.map((i) => [i.n, i.q, i.quantity])));
    check(`${label} → every line coherent (q=quantity, p=finalUnitPrice=base+extras, lineTotal, tags=extras)`, coherent(row.items));
    check(`${label} → order total ${total} = lines subtotal + delivery fee ${eco.deliveryFee} − discount ${eco.discount}`,
      Number(row.totale) === total && eco.total === total, `totale=${row.totale} eco=${JSON.stringify(eco)}`);
    if (lineChecks) lineChecks(row.items);
  }
  function expectRefused(label, id, res, code, before) {
    check(`${label} → 409 ${code}`, res.status === 409 && res.result.error === code && res.result.code === code, JSON.stringify(res.result));
    check(`${label} → row unchanged (no economic write)`, JSON.stringify(STORE[id]) === JSON.stringify(before));
  }

  console.log("\n── NF-1: quantity through the edit writer ──");
  {
    const id = seed("R0");
    expectEdit("B1: broken editor payload q=2 / stale quantity=1", id, await dispatch(P.brokenEditor.plusOne),
      { quantities: [2, 1], total: 34, lineChecks: (items) => check("B1: line 1 lineTotal 29 at unit 14.50", items[0].lineTotal === 29 && items[0].finalUnitPrice === 14.5) });
  }
  {
    const id = seed("R0");
    expectEdit("B1: fixed editor payload +1", id, await dispatch(P.fixedEditor.plusOne), { quantities: [2, 1], total: 34 });
  }
  {
    const id = seed("R_q2");
    expectEdit("fixed editor −1 on a ×2 line", id, await dispatch(P.fixedEditor.minusOne), { quantities: [1, 1], total: 19.5 });
  }
  {
    const id = seed("R_q2");
    expectEdit("broken editor −1 on a ×2 line (stale quantity=2)", id, await dispatch(P.brokenEditor.minusOne), { quantities: [1, 1], total: 19.5 });
  }
  {
    const id = seed("R_dup");
    expectEdit("fixed editor: two rows of the same product, +1 on the configured row", id, await dispatch(P.fixedEditor.twoRowsPlusSecond),
      { quantities: [1, 2, 1], total: 49.5 });
  }
  {
    const id = seed("R0");
    const before = clone(STORE[id]);
    const body = clone(P.fixedEditor.plusOne);
    // lineTotal 20 reproduces neither q=2 (29) nor quantity=3 (43.5) at 14.50: nothing tells
    // which one was edited, so the writer must refuse rather than pick one.
    body.items[0] = { ...body.items[0], q: 2, quantity: 3, lineTotal: 20 };
    expectRefused("irreconcilable quantity (q=2, quantity=3, lineTotal 20)", id, await dispatch(body), ORDER_ITEM_PAYLOAD_INCONSISTENT, before);
    check("irreconcilable quantity → no sbUpdate attempted", ordenesPatches().length === 0);
  }

  console.log("\n── B2 / B8: metadata-only edits stay allowed and move nothing economic ──");
  for (const [editor, payload] of [["broken", P.brokenEditor.notaOnly], ["fixed", P.fixedEditor.notaOnly]]) {
    const id = seed("R0");
    const beforeItems = JSON.stringify(clone(STORE[id].items).map((it) => normalizeOrderItem(it)));
    const res = await dispatch({ ...payload, nota: "TEST-NF nota" });
    const patch = ordenesPatches()[0].patch;
    check(`B2 (${editor} editor): nota-only → 200`, res.status === 200 && res.result.success === true);
    check(`B2 (${editor} editor): items byte-identical to the saved snapshot`, JSON.stringify(patch.items) === beforeItems);
    check(`B2 (${editor} editor): totale unchanged (19.5)`, patch.totale === 19.5 && Number(STORE[id].totale) === 19.5);
  }
  {
    const id = seed("R0", { order_uid: "22222222-0000-0000-0000-00000000aa01" });
    ADJUSTED[STORE[id].order_uid] = true;
    const res = await dispatch({ ...P.fixedEditor.notaOnly, nota: "TEST-NF nota" });
    check("B8: adjusted order + metadata only → still allowed", res.status === 200 && res.result.success === true);
    ADJUSTED = {};
  }
  {
    const id = seed("R0");
    PAID[id] = true;
    const res = await dispatch({ ...P.fixedEditor.notaOnly, nota: "TEST-NF nota" });
    check("B8: paid order + metadata only → still allowed (N-5 sees no economic move)", res.status === 200 && res.result.success === true);
    PAID = {};
  }

  console.log("\n── NF-2: structured extras through the edit writer ──");
  {
    const id = seed("R0");
    expectEdit("B3: fixed editor adds +Albahaca fresca (0.50)", id, await dispatch(P.fixedEditor.extraAdded), {
      quantities: [1, 1], total: 20,
      lineChecks: (items) => check("B3: extras[] holds the priced extra, finalUnitPrice 15",
        items[0].extras.length === 1 && items[0].extras[0].name === "Albahaca fresca" && items[0].extras[0].price === 0.5 && items[0].finalUnitPrice === 15),
    });
  }
  {
    const id = seed("R0");
    expectEdit("fixed editor adds two extras", id, await dispatch(P.fixedEditor.twoExtras), { quantities: [1, 1], total: 20.5 });
  }
  {
    const id = seed("R0");
    expectEdit("fixed editor: extra + quantity 2 (extra charged per unit)", id, await dispatch(P.fixedEditor.extraAndPlus), {
      quantities: [2, 1], total: 35,
      lineChecks: (items) => check("line: unit 15, lineTotal 30, extra quantity 1", items[0].finalUnitPrice === 15 && items[0].lineTotal === 30 && items[0].extras[0].quantity === 1),
    });
  }
  {
    const id = seed("R0");
    expectEdit("fixed editor: '+Rúcula' typed in Variaciones becomes a priced extra", id, await dispatch(P.fixedEditor.typedTag), { quantities: [1, 1], total: 20 });
  }
  {
    const id = seed("R_extra");
    expectEdit("B4: fixed editor removes a saved structured extra", id, await dispatch(P.fixedEditor.structuredExtraRemoved), {
      quantities: [1, 1], total: 19.5,
      lineChecks: (items) => check("B4: 4 extras left, finalUnitPrice 14.50, note kept",
        items[0].extras.length === 4 && !items[0].extras.some((e) => e.name === "Aceitunas negras") && items[0].finalUnitPrice === 14.5 && items[0].notes === "Nera"),
    });
  }
  {
    const id = seed("R_extra");
    expectEdit("fixed editor adds an extra to a line that already has structured extras", id, await dispatch(P.fixedEditor.extraAddedToStructured), { quantities: [1, 1], total: 20.5 });
  }
  {
    const id = seed("R0");
    const first = await dispatch(P.fixedEditor.reloadFirstSave);
    const afterFirst = clone(STORE[id]);
    const second = await dispatch({ ...P.fixedEditor.reloadSecondSave, id });
    check("F8 end-to-end: save → reload in the editor → save again → same persisted items and total",
      first.status === 200 && second.status === 200
      && JSON.stringify(STORE[id].items) === JSON.stringify(afterFirst.items) && Number(STORE[id].totale) === Number(afterFirst.totale) && Number(afterFirst.totale) === 35);
  }
  for (const [label, key, fixture] of [
    ["B5: broken editor adds an extra (p 15, finalUnitPrice 14.5, extras [])", "extraAdded", "R0"],
    ["B5: broken editor extra + quantity", "extraAndPlus", "R0"],
    ["B5: broken editor removes a structured extra (p 14.5, finalUnitPrice 15)", "structuredExtraRemoved", "R_extra"],
    ["B5: broken editor adds to a line with structured extras", "extraAddedToStructured", "R_extra"],
  ]) {
    const id = seed(fixture);
    const before = clone(STORE[id]);
    expectRefused(label, id, await dispatch(P.brokenEditor[key]), ORDER_ITEM_PAYLOAD_INCONSISTENT, before);
    check(`${label} → no sbUpdate attempted`, ordenesPatches().length === 0);
  }

  console.log("\n── B6 / B7: paid and adjusted orders keep their fences ──");
  for (const [label, payload] of [["B6: real quantity change", P.fixedEditor.plusOne], ["B7: real extra change", P.fixedEditor.extraAdded]]) {
    {
      const id = seed("R0");
      PAID[id] = true;
      const before = clone(STORE[id]);
      expectRefused(`${label} on a paid order`, id, await dispatch(payload), "PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN", before);
      PAID = {};
    }
    {
      const id = seed("R0", { order_uid: "22222222-0000-0000-0000-00000000aa02" });
      ADJUSTED[STORE[id].order_uid] = true;
      const before = clone(STORE[id]);
      expectRefused(`${label} on an adjusted order`, id, await dispatch(payload), "ORDER_ECONOMIC_BASIS_LOCKED", before);
      check(`${label} on an adjusted order → no sbUpdate attempted`, ordenesPatches().length === 0);
      ADJUSTED = {};
    }
  }

  console.log("\n── WhatsApp addition paths ──");
  {
    const id = seed("R0");
    expectEdit("frontend adición, old in-place merge (q bumped, quantity stale) through the edit writer", id,
      await dispatch({ action: "updateOrden", id, items: P.whatsappAddition.brokenMerge, nota: "", hora: "11:41" }), { quantities: [2, 1], total: 34 });
  }
  {
    const id = seed("R0");
    const res = await dispatch({ action: "updateOrden", id, items: P.whatsappAddition.fixedMerge, nota: "", hora: "11:41" });
    const customerTotal = round2(P.whatsappAddition.fixedMerge.reduce((s, it) => s + it.p * it.q, 0));
    expectEdit("frontend adición, fixed canonical merge", id, res, { quantities: [2, 1], total: 34 });
    check("frontend adición: the total told to the customer equals the persisted total", customerTotal === Number(STORE[id].totale));
  }
  {
    const id = seed("R0");
    const r = await addToOrder(id, [{ n: "Il Tulipano Nero", p: 14.5, q: 1, id: 8 }]);
    const row = STORE[id];
    check("B9: bot addition of the same plain product → success", r.success === true);
    check("B9: one line, canonical quantity 2 (q, quantity, lineTotal)", row.items.length === 2 && row.items[0].quantity === 2 && row.items[0].q === 2 && row.items[0].lineTotal === 29);
    check("B9: lines coherent, totale 34 = lines subtotal", coherent(row.items) && Number(row.totale) === 34 && economics(row.items).total === 34);
    const nota = await dispatch({ action: "updateOrden", id, items: clone(row.items), nota: "TEST-NF nota", hora: "11:41" });
    check("B9: a later metadata-only save keeps quantity 2 and totale 34 (no silent drop)",
      nota.status === 200 && STORE[id].items[0].quantity === 2 && Number(STORE[id].totale) === 34);
  }
  {
    const id = seed("R0");
    const r = await addToOrder(id, [{ n: "Il Tulipano Nero", p: 15, q: 1, id: 8, sub: "+Albahaca fresca" }]);
    const row = STORE[id];
    check("B10: bot addition of the same product WITH an extra → its own line", r.success === true && row.items.length === 3);
    check("B10: saved line untouched (quantity 1, 14.50)", row.items[0].quantity === 1 && row.items[0].finalUnitPrice === 14.5);
    check("B10: totale 34.5 = 14.50 + 5.00 + 15.00", Number(row.totale) === 34.5 && economics(row.items).total === 34.5);
  }
  {
    const id = seed("R0", { order_uid: "22222222-0000-0000-0000-00000000aa03" });
    ADJUSTED[STORE[id].order_uid] = true;
    const r = await addToOrder(id, [{ n: "Il Tulipano Nero", p: 14.5, q: 1, id: 8 }]);
    check("bot addition on an adjusted order → ORDER_ECONOMIC_BASIS_LOCKED, no write", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED" && ordenesPatches().length === 0);
    ADJUSTED = {};
  }
}

testWriters()
  .catch((e) => { fail++; console.log("  ✗ writer suite crashed — " + (e && e.stack || e)); })
  .finally(() => {
    console.log(`\nmodificarPedidoCanonicalItems: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
