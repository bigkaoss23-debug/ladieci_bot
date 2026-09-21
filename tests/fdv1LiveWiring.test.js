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

// [FDV1 R3] ± contract v2 depends on "now" (window before the HORA LÍMITE): fixed service clock for this file,
// 2 h before the 19:00Z deadlines used below → every + up to 50 is inside the window unless a test says otherwise.
const FIXED_NOW = Date.parse("2026-09-21T17:00:00.000Z");
Date.now = () => FIXED_NOW;
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
  await t("± standalone: writes ONLY ui_offset_min on that order, −5 allowed, clamp ±50", async () => {
    reset(); db.ordenes.push(ord("#A", { delivery_deadline_at: "2026-09-21T19:00:00.000Z" }));
    let r = await dd.setPriorityOffset("#A", -5);
    assert.ok(r.success && r.scope === "order" && db.ordenes[0].ui_offset_min === -5);
    r = await dd.setPriorityOffset("#A", 99); assert.strictEqual(db.ordenes[0].ui_offset_min, 50);
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

  await t("± boundaries v2: -50 -40 -30 -5 0 +5 +30 +40 +50 exact; beyond ±50 CLAMPED; garbage → 0; RITIRO refused", async () => {
    reset(); db.ordenes.push(ord("#A", { hora: "21:00", delivery_deadline_at: "2026-09-21T19:05:00.000Z" }), ord("#R", { tipo_consegna: "RITIRO", hora: "21:00" }));
    for (const v of [-50, -40, -30, -5, 0, 5, 30, 40, 50]) {
      db.ordenes[0].ui_offset_min = 0;
      const r = await dd.setPriorityOffset("#A", v);
      assert.ok(r.success && r.ui_offset_min === v && db.ordenes[0].ui_offset_min === v, `${v} → ${JSON.stringify(r)}`);
      assert.strictEqual(r.contract.max, 50); assert.strictEqual(r.contract.min, -50);
    }
    for (const [v, exp] of [[51, 50], [60, 50], [999, 50], [-51, -50], [-999, -50], ["abc", 0], [null, 0], [4.6, 5]]) {
      db.ordenes[0].ui_offset_min = 0;
      const r = await dd.setPriorityOffset("#A", v);
      assert.strictEqual(r.ui_offset_min, exp, `${v} → ${JSON.stringify(r)}`);
    }
    const rr = await dd.setPriorityOffset("#R", 5);
    assert.ok(!rr.success && rr.error === "not_delivery" && db.ordenes[1].ui_offset_min === 0);
    const nf = await dd.setPriorityOffset("#NOPE", 5);
    assert.ok(!nf.success && nf.error === "order_not_found");
    assert.strictEqual(db.ordenes[0].delivery_deadline_at, "2026-09-21T19:05:00.000Z"); assert.strictEqual(db.ordenes[0].hora, "21:00");
  });

  await t("± window: + allowed up to the REAL minutes left (no artificial buffer); beyond → 409 offset_exceeds_window, nothing written", async () => {
    reset(); db.ordenes.push(ord("#A", { hora: "21:00", delivery_deadline_at: "2026-09-21T19:05:00.000Z", ts: Date.parse("2026-09-21T18:10:00Z") }));
    const now = Date.parse("2026-09-21T18:35:00.000Z");            // 30 min left → max +30, NOT +20
    const ok30 = await dd.setPriorityOffset("#A", 30, { nowMs: now });
    assert.ok(ok30.success && ok30.ui_offset_min === 30 && ok30.max_allowed === 30, JSON.stringify(ok30));
    db.ordenes[0].ui_offset_min = 0; writes.length = 0;
    for (const v of [40, 50, 31]) {
      const r = await dd.setPriorityOffset("#A", v, { nowMs: now });
      assert.ok(!r.success && r.status === 409 && r.error === "offset_exceeds_window" && r.max_allowed === 30 && r.requested === v, JSON.stringify(r));
    }
    assert.strictEqual(writes.length, 0, "refused + writes nothing");
    assert.strictEqual(db.ordenes[0].ui_offset_min, 0);
    const minus = await dd.setPriorityOffset("#A", -50, { nowMs: now });
    assert.ok(minus.success && minus.ui_offset_min === -50, "− always allowed");
  });

  await t("± window: a fresh +55 order may take +50 and be left URGENTE — URGENTE is visual, not forbidden", async () => {
    reset();
    const created = Date.parse("2026-09-21T18:10:00.000Z");
    db.ordenes.push(ord("#A", { hora: "21:00", delivery_deadline_at: "2026-09-21T19:05:00.000Z", ts: created }));  // ts + 55'
    const justAfter = created + 60000;                              // 54 min left
    const p50 = await dd.setPriorityOffset("#A", 50, { nowMs: justAfter });
    assert.ok(p50.success && p50.ui_offset_min === 50 && p50.max_allowed === 50, JSON.stringify(p50));
    assert.strictEqual(db.ordenes[0].delivery_deadline_at, "2026-09-21T19:05:00.000Z");
    assert.strictEqual(db.ordenes[0].hora, "21:00");
  });

  await t("± window: inside the URGENTE minutes a small + is still allowed; only a real overrun (TARDE) blocks it", async () => {
    reset(); db.ordenes.push(ord("#A", { delivery_deadline_at: "2026-09-21T19:05:00.000Z", ui_offset_min: 30 }));
    const near = Date.parse("2026-09-21T18:57:00.000Z");            // 8 min left → URGENTE, max +8 (no −10 buffer)
    const p8 = await dd.setPriorityOffset("#A", 5, { nowMs: near });
    assert.ok(p8.success && p8.ui_offset_min === 5 && p8.max_allowed === 8, JSON.stringify(p8));
    db.ordenes[0].ui_offset_min = 30;
    const p35 = await dd.setPriorityOffset("#A", 35, { nowMs: near });
    assert.ok(!p35.success && p35.error === "offset_exceeds_window" && p35.max_allowed === 8 && p35.requested === 35, JSON.stringify(p35));
    const down = await dd.setPriorityOffset("#A", 10, { nowMs: near });
    assert.ok(down.success && down.ui_offset_min === 10, "lowering an existing + is always allowed");
    const late = Date.parse("2026-09-21T19:20:00.000Z");            // TARDE = real overrun
    const p = await dd.setPriorityOffset("#A", 15, { nowMs: late });
    assert.ok(!p.success && p.max_allowed === 0);
    const zero = await dd.setPriorityOffset("#A", 0, { nowMs: late });
    assert.ok(zero.success && db.ordenes[0].ui_offset_min === 0);
    const noDl = ord("#N", { hora: "", delivery_deadline_at: null, ts: NaN }); db.ordenes.push(noDl);
    const nd = await dd.setPriorityOffset("#N", 5, { nowMs: near });
    assert.ok(!nd.success && nd.max_allowed === 0, "no provable deadline → no +");
  });

  await t("± window in a giro: limited by the MOST URGENT member; block moves together; deadlines/hora immutable", async () => {
    reset();
    db.ordenes.push(ord("#A", { hora: "20:30", delivery_deadline_at: "2026-09-21T19:00:00.000Z" }), ord("#B", { hora: "21:30", delivery_deadline_at: "2026-09-21T19:40:00.000Z" }));
    const g = (await mg.createManualGiro(["#A", "#B"])).giro.id;
    const snap = JSON.stringify(db.ordenes.map((o) => [o.hora, o.delivery_deadline_at, o.ts]));
    const now = Date.parse("2026-09-21T18:35:00.000Z");            // #A: 25 left → max +25 (#B alone would allow +50)
    const viaB = await dd.setPriorityOffset("#B", 30, { nowMs: now });
    assert.ok(!viaB.success && viaB.max_allowed === 25 && viaB.requested === 30, JSON.stringify(viaB));
    const ok = await dd.setPriorityOffset("#B", 25, { nowMs: now });
    assert.ok(ok.success && ok.scope === "giro" && ok.giro_id === g && ok.max_allowed === 25);
    assert.deepStrictEqual(db.ordenes.map((o) => o.ui_offset_min), [25, 25]);
    assert.strictEqual(JSON.stringify(db.ordenes.map((o) => [o.hora, o.delivery_deadline_at, o.ts])), snap);
  });

  await t("priority contract is exported for the capability read (v2, −50..+50, NO artificial margin)", async () => {
    assert.deepStrictEqual({ ...dd.PRIORITY_CONTRACT }, { version: 2, min: -50, max: 50, margin_min: 0, rule: "plus_within_window_before_deadline" });
    assert.strictEqual(dd.PRIORITY_MARGIN_MIN, 0, "no artificial buffer before the deadline");
    assert.strictEqual(dd.maxPlusAllowed([ord("#Z", { delivery_deadline_at: "2026-09-21T18:00:00.000Z" })], Date.parse("2026-09-21T17:00:00.000Z")), 50);
    assert.strictEqual(dd.maxPlusAllowed([ord("#Z", { delivery_deadline_at: "2026-09-21T17:25:30.000Z" })], Date.parse("2026-09-21T17:00:00.000Z")), 25);
    assert.strictEqual(dd.maxPlusAllowed([ord("#Z", { delivery_deadline_at: "2026-09-21T17:08:00.000Z" })], Date.parse("2026-09-21T17:00:00.000Z")), 8, "URGENTE window is usable");
  });

  await t("RECONCILE realigns a drifted block to the frozen rule (min); DISSOLVE detaches without touching offsets / hora / deadline", async () => {
    reset();
    db.ordenes.push(ord("#A", { delivery_deadline_at: "2026-09-21T19:05:00.000Z" }), ord("#B", { delivery_deadline_at: "2026-09-21T19:10:00.000Z" }));
    const g = (await mg.createManualGiro(["#A", "#B"])).giro.id;
    await dd.setPriorityOffset("#A", 10);
    db.ordenes[1].ui_offset_min = 25;                         // drift written by someone bypassing the functions
    const before = JSON.stringify(db.ordenes.map((o) => [o.hora, o.delivery_deadline_at]));
    const rc = await mg.reconcileManualGiros({ alignOffsets: true });
    assert.ok(rc.ok, JSON.stringify(rc));
    assert.deepStrictEqual(db.ordenes.map((o) => o.ui_offset_min), [10, 10]);
    const d = await mg.dissolveManualGiro(g);
    assert.ok(d.ok); assert.deepStrictEqual(db.ordenes.map((o) => [o.manual_giro_id, o.ui_offset_min]), [[null, 10], [null, 10]]);
    assert.ok(db.manual_giros.find((x) => x.id === g).dissolved_at);
    const d2 = await mg.dissolveManualGiro(g); assert.ok(d2.ok, "dissolve is idempotent");
    assert.strictEqual(JSON.stringify(db.ordenes.map((o) => [o.hora, o.delivery_deadline_at])), before);
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

  await t("warnings: coherent group (spread ≤ 15') → NO warning on anyone, anchor included; deadline_passed names only the passed member", async () => {
    reset(); const now = Date.parse("2026-09-21T18:00:00Z");
    db.ordenes.push(ord("#A", { delivery_deadline_at: new Date(now + 30 * 60000).toISOString() }), ord("#B", { delivery_deadline_at: new Date(now + 40 * 60000).toISOString() }),
      ord("#C", { delivery_deadline_at: new Date(now + 45 * 60000).toISOString() }), ord("#P", { delivery_deadline_at: new Date(now - 60000).toISOString() }));
    const ok1 = await dd.giroWarningsFor({ order_ids: ["#A", "#B", "#C"] }, { nowMs: now });
    assert.deepStrictEqual(ok1.warnings, [], JSON.stringify(ok1.warnings));
    const w2 = await dd.giroWarningsFor({ order_ids: ["#A", "#P"] }, { nowMs: now });
    const passed = w2.warnings.find((w) => w.code === "deadline_passed");
    assert.ok(passed); assert.deepStrictEqual(passed.member_ids, ["#P"]);
    assert.ok(!w2.warnings.some((w) => (w.member_ids || []).includes("#A") && w.code === "deadline_passed"));
  });

  await t("override: confirming a giro with warnings creates it and changes NO deadline / hora; warnings never create or join a giro", async () => {
    reset(); const now = Date.parse("2026-09-21T18:00:00Z");
    db.ordenes.push(ord("#A", { hora: "20:20", delivery_deadline_at: new Date(now + 20 * 60000).toISOString() }), ord("#B", { hora: "21:10", delivery_deadline_at: new Date(now + 70 * 60000).toISOString() }));
    const before = JSON.stringify(db.ordenes.map((o) => [o.hora, o.delivery_deadline_at]));
    const w = await dd.giroWarningsFor({ order_ids: ["#A", "#B"] }, { nowMs: now });
    assert.ok(w.warnings.length > 0);
    assert.ok(db.ordenes.every((o) => o.manual_giro_id == null) && db.manual_giros.length === 0, "warnings are read-only: no auto-aggregation");
    const p = await dd.previewDeliveryV1({ zona: "Q1" }, { nowMs: now });
    assert.ok(db.ordenes.every((o) => o.manual_giro_id == null) && db.manual_giros.length === 0, "preview suggestion is read-only: no auto-aggregation");
    void p;
    const c = await mg.createManualGiro(["#A", "#B"]);        // operator override
    assert.ok(c.ok);
    assert.strictEqual(JSON.stringify(db.ordenes.map((o) => [o.hora, o.delivery_deadline_at])), before);
  });

  await t("duplicate / invalid actions converge: create twice = same giro; add member twice = no-op; remove already removed = no-op; ineligible member refused", async () => {
    reset();
    db.ordenes.push(ord("#A", { delivery_deadline_at: "2026-09-21T19:05:00.000Z" }), ord("#B", { delivery_deadline_at: "2026-09-21T19:10:00.000Z" }),
      ord("#C", { delivery_deadline_at: "2026-09-21T19:15:00.000Z" }), ord("#R", { tipo_consegna: "RITIRO" }), ord("#X", { estado: "RETIRADO" }));
    const c1 = await mg.createManualGiro(["#A", "#B"]); const c2 = await mg.createManualGiro(["#B", "#A"]);
    assert.ok(c1.ok && c2.ok && c2.idempotent && c1.giro.id === c2.giro.id && db.manual_giros.length === 1);
    const a1 = await mg.addOrderToManualGiro(c1.giro.id, "#C"); const a2 = await mg.addOrderToManualGiro(c1.giro.id, "#C");
    assert.ok(a1.ok && a2.ok && a2.no_op);
    const r1 = await mg.removeOrderFromManualGiro("#C"); const r2 = await mg.removeOrderFromManualGiro("#C");
    assert.ok(r1.ok && r2.ok && r2.no_op);
    for (const bad of ["#R", "#X"]) {
      const x = await mg.addOrderToManualGiro(c1.giro.id, bad);
      assert.ok(!x.ok && x.status === 400, `${bad} → ${JSON.stringify(x)}`);
      const y = await mg.createManualGiro(["#C", bad]);
      assert.ok(!y.ok, `${bad} create → ${JSON.stringify(y)}`);
    }
    assert.deepStrictEqual(db.ordenes.map((o) => o.manual_giro_id), [c1.giro.id, c1.giro.id, null, null, null]);
  });

  // ── index.js wiring (static) ────────────────────────────────────────────────────────────
  await t("index.js routes the FDV1 actions (createOrden, setUiOffset, eliminaOrdine, previewDeliveryV1, giroWarnings, reconcileManualGiros)", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    for (const re of [/fdv1\.createOrdenDeliveryV1\(/, /fdv1\.setPriorityOffset\(/, /action === "priorityContract"[\s\S]{0,200}fdv1\.PRIORITY_CONTRACT/, /fdv1\.deleteOrderWithGiroRecompute\(/, /fdv1\.previewDeliveryV1\(/, /fdv1\.giroWarningsFor\(/, /reconcileManualGiros\(\{/])
      assert.ok(re.test(src), "missing " + re);
    assert.ok(!/Math\.min\(20, parseInt\(req\.body\.offset_min\)/.test(src), "legacy 0..20 per-card offset still wired");
  });

  console.log(`\n== fdv1LiveWiring: ${pass} pass / ${fail} fail`);
  if (fail) process.exitCode = 1;
})();
