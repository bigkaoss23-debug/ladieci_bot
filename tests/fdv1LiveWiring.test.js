// tests/fdv1LiveWiring.test.js — [FDV1 LIVE wiring] the dashboard routes that index.js now calls.
// No real DB: src/utils/supabase is replaced via require.cache by a tiny in-memory PostgREST-ish fake;
// giro RPCs go to the shared JS reference model of the SQL (tests/helpers/giroRpcModel.js).

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { createGiroRpcModel } = require("./helpers/giroRpcModel");

const db = { ordenes: [], manual_giros: [], config: [] };
const writes = [];
const model = createGiroRpcModel({ tables: (n) => db[n], madridToday: () => "2026-09-21" });

function parse(query) {
  const f = [];
  for (const p of String(query || "").split("&").filter(Boolean)) {
    const i = p.indexOf("="); const k = p.slice(0, i); const v = decodeURIComponent(p.slice(i + 1));
    if (["select", "order", "limit"].includes(k)) continue;
    if (v.startsWith("eq.")) f.push((r) => String(r[k]) === v.slice(3));
    else if (v.startsWith("in.(")) {
      const vals = v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, "").replace(/""/g, '"'));
      f.push((r) => vals.includes(String(r[k])));
    } else if (v === "is.null") f.push((r) => r[k] == null);
    else if (v === "not.is.null") f.push((r) => r[k] != null);
    else throw new Error("unsupported filter " + p);
  }
  return (r) => f.every((fn) => fn(r));
}
const sup = {
  sbSelect: async (t, q) => db[t].filter(parse(q)).map((r) => ({ ...r })),
  sbUpdate: async (t, q, patch) => { const m = parse(q); for (const r of db[t]) if (m(r)) Object.assign(r, patch); writes.push({ t, q, keys: Object.keys(patch) }); return ""; },
  sbDelete: async (t, q) => { const m = parse(q); db[t] = db[t].filter((r) => !m(r)); writes.push({ t, q, del: true }); return ""; },
  sbInsert: async (t, row) => {
    if (String(t).startsWith("rpc/")) return model.apply(String(t).slice(4), row);   // atomic giro function (one call = one transaction)
    db[t].push(row); return [row];
  },
  sbUpsert: async () => "",
  getConfig: async () => ({}),
};
const supPath = require.resolve("../src/utils/supabase");
require.cache[supPath] = { id: supPath, filename: supPath, loaded: true, exports: sup };

const mg = require("../src/agents/manualGiros");
const dd = require("../src/agents/dashboardDelivery");

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e)); }
}
const reset = () => { db.ordenes = []; db.manual_giros = []; writes.length = 0; };
const ord = (id, extra = {}) => ({ id, tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "21:00", ts: Date.parse("2026-09-21T18:05:00Z"),
  delivery_deadline_at: null, manual_giro_id: null, ui_offset_min: 0, cobrado: false, ya_pagado: false, totale: 14.5, ...extra });

(async () => {
  console.log("fdv1LiveWiring.test.js");

  // ── P1 deadline ──────────────────────────────────────────────────────────────────────────
  const fakeCrea = (tsMs) => async (p) => { const row = { ...ord("#N1"), ...p, ts: tsMs, estado: "POR_CONFIRMAR" }; delete row.operatorManual; db.ordenes.push(row); return { success: true, id: row.id }; };

  await t("createOrden wrapper: hora (client promise) passes UNTOUCHED, FE-only fields stripped, no post-insert patch", async () => {
    reset(); const ts = Date.parse("2026-09-21T18:05:30Z");
    const r = await dd.createOrdenDeliveryV1({ tipo_consegna: "DOMICILIO", delivery_contract: "v1", hora: "20:00" }, { creaOrdine: fakeCrea(ts) });
    assert.ok(r.success);
    const row = db.ordenes[0];
    assert.strictEqual(row.hora, "20:00");
    assert.ok(!("delivery_contract" in row) && !("giro_intent" in row));
    assert.strictEqual(writes.length, 0, "the wrapper never patches hora / deadline after the insert");
  });

  await t("createOrden wrapper: giro_intent { with_order_id } creates the giro atomically after the insert", async () => {
    reset(); db.ordenes.push(ord("#S", { delivery_deadline_at: "2026-09-21T19:00:00.000Z" }));
    const crea = async (p) => { db.ordenes.push({ ...ord("#N2"), ...p, id: "#N2" }); return { success: true, id: "#N2" }; };
    const r = await dd.createOrdenDeliveryV1({ tipo_consegna: "DOMICILIO", hora: "21:00", giro_intent: { with_order_id: "#S" } }, { creaOrdine: crea });
    assert.ok(r.giro && r.giro.applied, JSON.stringify(r));
    const g = db.ordenes.map((o) => o.manual_giro_id); assert.ok(g[0] && g[0] === g[1]);
  });

  // ── ± production priority ───────────────────────────────────────────────────────────────
  await t("± standalone: writes ONLY ui_offset_min on that order, −5 allowed, clamp ±30", async () => {
    reset(); db.ordenes.push(ord("#A", { delivery_deadline_at: "2026-09-21T19:00:00.000Z" }));
    let r = await dd.setPriorityOffset("#A", -5);
    assert.ok(r.success && r.scope === "order" && db.ordenes[0].ui_offset_min === -5);
    r = await dd.setPriorityOffset("#A", 99); assert.strictEqual(db.ordenes[0].ui_offset_min, 30);
    assert.ok(writes.every((w) => w.t === "ordenes" && w.keys.length === 1 && w.keys[0] === "ui_offset_min"));
    assert.strictEqual(db.ordenes[0].delivery_deadline_at, "2026-09-21T19:00:00.000Z");
  });

  await t("± inside a giro: the whole block moves, deadlines/hora/payment untouched", async () => {
    reset(); db.ordenes.push(ord("#A", { delivery_deadline_at: "2026-09-21T19:00:00.000Z" }), ord("#B", { delivery_deadline_at: "2026-09-21T19:10:00.000Z" }));
    const c = await mg.createManualGiro(["#A", "#B"]); assert.ok(c.ok, JSON.stringify(c));
    const snap = JSON.stringify(db.ordenes.map((o) => [o.delivery_deadline_at, o.hora, o.cobrado, o.ya_pagado, o.totale]));
    const r = await dd.setPriorityOffset("#B", 5);
    assert.ok(r.success && r.scope === "giro");
    assert.deepStrictEqual(db.ordenes.map((o) => o.ui_offset_min), [5, 5]);
    assert.strictEqual(JSON.stringify(db.ordenes.map((o) => [o.delivery_deadline_at, o.hora, o.cobrado, o.ya_pagado, o.totale])), snap);
  });

  // ── point 4: where the block offset lives and how it moves ──────────────────────────────
  await t("block offset = ordenes.ui_offset_min on EVERY member; ± = ONE PATCH ordenes?manual_giro_id=eq.<giro>; hora/deadline never written", async () => {
    reset();
    db.ordenes.push(ord("#A", { hora: "21:00", delivery_deadline_at: "2026-09-21T19:05:00.000Z" }), ord("#B", { hora: "21:20", delivery_deadline_at: "2026-09-21T19:20:00.000Z" }),
      ord("#C", { hora: "21:30", delivery_deadline_at: "2026-09-21T19:30:00.000Z" }), ord("#D", { hora: "21:40", delivery_deadline_at: "2026-09-21T19:40:00.000Z" }));
    const frozen = () => JSON.stringify(db.ordenes.map((o) => [o.id, o.hora, o.delivery_deadline_at]));
    const before = frozen();
    const g1 = (await mg.createManualGiro(["#A", "#B"])).giro.id;
    writes.length = 0;
    await dd.setPriorityOffset("#A", 5);
    assert.deepStrictEqual(writes.map((w) => [w.t, decodeURIComponent(w.q), w.keys]), [["ordenes", `manual_giro_id=eq.${g1}`, ["ui_offset_min"]]]);
    const off = () => Object.fromEntries(db.ordenes.map((o) => [o.id, o.ui_offset_min]));
    assert.deepStrictEqual(off(), { "#A": 5, "#B": 5, "#C": 0, "#D": 0 });
    await dd.setPriorityOffset("#B", -5);
    assert.deepStrictEqual(off(), { "#A": -5, "#B": -5, "#C": 0, "#D": 0 });
    await dd.setPriorityOffset("#A", 5);
    // ADD: the giro settles its block offset to the MOST URGENT (min) of its members — frozen FDV1 rule (offset merge = min)
    await mg.addOrderToManualGiro(g1, "#C");
    assert.deepStrictEqual(off(), { "#A": 0, "#B": 0, "#C": 0, "#D": 0 });
    await dd.setPriorityOffset("#C", 10);
    assert.deepStrictEqual(off(), { "#A": 10, "#B": 10, "#C": 10, "#D": 0 });
    // MOVE #C from G1 (3→2) to a new giro with #D: G1 keeps a coherent +10 block; the new block settles to min(10, 0) = 0
    const g2 = (await mg.createManualGiro(["#C", "#D"])).giro.id;
    assert.ok(g2 !== g1);
    assert.deepStrictEqual(off(), { "#A": 10, "#B": 10, "#C": 0, "#D": 0 });
    assert.deepStrictEqual(db.ordenes.map((o) => o.manual_giro_id), [g1, g1, g2, g2]);
    // REMOVE #B (2→1): G1 dissolves; #A and #B keep their last offset as standalone orders
    await mg.removeOrderFromManualGiro("#B");
    assert.ok(db.manual_giros.find((g) => g.id === g1).dissolved_at);
    assert.deepStrictEqual(db.ordenes.map((o) => o.manual_giro_id), [null, null, g2, g2]);
    assert.strictEqual(frozen(), before, "hora / delivery_deadline_at unchanged through create, ±, add, move, remove, dissolve");
  });

  // ── delete + settle ─────────────────────────────────────────────────────────────────────
  await t("eliminaOrdine on a member of a 2-giro dissolves it (no giro monco, no stale anchor)", async () => {
    reset(); db.ordenes.push(ord("#A", { delivery_deadline_at: "2026-09-21T19:00:00.000Z" }), ord("#B", { delivery_deadline_at: "2026-09-21T19:10:00.000Z" }));
    await mg.createManualGiro(["#A", "#B"]);
    const gid = db.ordenes[0].manual_giro_id;
    const r = await dd.deleteOrderWithGiroRecompute("#A");
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(db.ordenes.length, 1); assert.strictEqual(db.ordenes[0].manual_giro_id, null);
    assert.ok(db.manual_giros.find((g) => g.id === gid).dissolved_at);
  });

  // ── P2/P4a read endpoints ───────────────────────────────────────────────────────────────
  await t("previewDeliveryV1: deadline = now + 55' and a compatible single in the same zone within 15' is suggested", async () => {
    reset(); const now = Date.parse("2026-09-21T18:00:00Z");
    db.ordenes.push(ord("#S", { delivery_deadline_at: new Date(now + 50 * 60000).toISOString() }), ord("#F", { zona: "Q5", delivery_deadline_at: new Date(now + 55 * 60000).toISOString() }));
    const r = await dd.previewDeliveryV1({ zona: "Q1" }, { nowMs: now });
    assert.ok(r.ok); assert.strictEqual(r.delivery_deadline_preview, new Date(now + 55 * 60000).toISOString());
    assert.strictEqual(r.giro_suggestion.kind, "ORDINE"); assert.strictEqual(r.giro_suggestion.order_id, "#S");
    assert.strictEqual(writes.length, 0);
  });

  await t("giroWarningsFor: only the member really at risk is named (deadline_much_closer); read-only", async () => {
    reset(); const now = Date.parse("2026-09-21T18:00:00Z");
    db.ordenes.push(ord("#A", { delivery_deadline_at: new Date(now + 20 * 60000).toISOString() }),
      ord("#B", { delivery_deadline_at: new Date(now + 50 * 60000).toISOString() }), ord("#C", { delivery_deadline_at: new Date(now + 55 * 60000).toISOString() }));
    const r = await dd.giroWarningsFor({ order_ids: ["#A", "#B", "#C"] }, { nowMs: now });
    assert.ok(r.ok); const w = r.warnings.find((x) => x.code === "deadline_much_closer");
    assert.ok(w, JSON.stringify(r.warnings)); assert.deepStrictEqual(w.member_ids, ["#A"]);
    const ok = await dd.giroWarningsFor({ order_ids: ["#B", "#C"] }, { nowMs: now });
    assert.deepStrictEqual(ok.warnings, []);
    assert.strictEqual(writes.length, 0);
  });

  await t("giroWarningsFor add/move: existing members of the target giro are included", async () => {
    await mg.createManualGiro(["#B", "#C"]); const gid = db.ordenes.find((o) => o.id === "#B").manual_giro_id;
    const r = await dd.giroWarningsFor({ giro_id: gid, order_ids: ["#A"] }, { nowMs: Date.parse("2026-09-21T18:00:00Z") });
    assert.deepStrictEqual(r.member_ids.sort(), ["#A", "#B", "#C"]);
  });

  // ── index.js wiring (static) ────────────────────────────────────────────────────────────
  await t("index.js routes the FDV1 actions (createOrden, setUiOffset, eliminaOrdine, previewDeliveryV1, giroWarnings, reconcileManualGiros)", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    for (const re of [/fdv1\.createOrdenDeliveryV1\(/, /fdv1\.setPriorityOffset\(/, /fdv1\.deleteOrderWithGiroRecompute\(/, /fdv1\.previewDeliveryV1\(/, /fdv1\.giroWarningsFor\(/, /reconcileManualGiros\(\{/])
      assert.ok(re.test(src), "missing " + re);
    assert.ok(!/Math\.min\(20, parseInt\(req\.body\.offset_min\)/.test(src), "legacy 0..20 per-card offset still wired");
  });

  console.log(`\n== fdv1LiveWiring: ${pass} pass / ${fail} fail`);
  if (fail) process.exitCode = 1;
})();
