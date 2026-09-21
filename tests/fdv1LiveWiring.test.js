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

  await t("P1 v1 DOMICILIO: delivery_deadline_at = stored ts + 55' and hora mirrors it (Europe/Madrid)", async () => {
    reset(); const ts = Date.parse("2026-09-21T18:05:30Z");
    const r = await dd.createOrdenDeliveryV1({ tipo_consegna: "DOMICILIO", delivery_contract: "v1", hora: "20:00" }, { creaOrdine: fakeCrea(ts), nowMs: ts - 400 });
    assert.ok(r.success);
    const row = db.ordenes[0];
    assert.strictEqual(row.delivery_deadline_at, new Date(ts + 55 * 60000).toISOString());
    assert.strictEqual(row.hora, "21:00");
    assert.ok(!("delivery_contract" in row) && !("giro_intent" in row));
  });

  await t("P1 replay (same stored ts) never extends the deadline and writes nothing", async () => {
    const before = db.ordenes[0].delivery_deadline_at; writes.length = 0;
    const crea = async () => ({ success: true, id: "#N1", idempotent: true });
    await dd.createOrdenDeliveryV1({ tipo_consegna: "DOMICILIO", delivery_contract: "v1" }, { creaOrdine: crea, nowMs: Date.now() + 3600e3 });
    assert.strictEqual(db.ordenes[0].delivery_deadline_at, before);
    assert.strictEqual(writes.length, 0);
  });

  await t("P1 without the v1 flag (old FE / bot) and for RITIRO: no deadline, hora untouched", async () => {
    reset(); const ts = Date.now();
    await dd.createOrdenDeliveryV1({ tipo_consegna: "DOMICILIO", hora: "22:10" }, { creaOrdine: fakeCrea(ts) });
    assert.strictEqual(db.ordenes[0].delivery_deadline_at, null); assert.strictEqual(db.ordenes[0].hora, "22:10");
    reset();
    await dd.createOrdenDeliveryV1({ tipo_consegna: "RITIRO", delivery_contract: "v1", hora: "22:10" }, { creaOrdine: fakeCrea(ts) });
    assert.strictEqual(db.ordenes[0].delivery_deadline_at, null); assert.strictEqual(db.ordenes[0].hora, "22:10");
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

  // ── delete + settle ─────────────────────────────────────────────────────────────────────
  await t("eliminaOrdine on a member of a 2-giro dissolves it (no giro monco, no stale anchor)", async () => {
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
