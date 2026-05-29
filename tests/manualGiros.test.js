// tests/manualGiros.test.js — P1C.1 of DELIVERY-MANUAL-GIRO-01
// Unit tests for src/agents/manualGiros.js. No real DB. Supabase and
// servizio.madridDateStr are stubbed via require.cache before the
// module-under-test is loaded (same pattern as closingTimeGuard.test.js).

const assert = require("assert");

// ─── In-memory fake DB ───────────────────────────────────────────
const db = {
  manual_giros: [],
  ordenes: [],
};

let FAKE_TODAY = "2026-05-25";
let collideOnceOnInsert = false; // forces 1 UNIQUE-violation retry path
const observedSelectQueries = [];
const observedUpdateQueries = [];

function resetDb() {
  db.manual_giros = [];
  db.ordenes = [];
  FAKE_TODAY = "2026-05-25";
  collideOnceOnInsert = false;
  observedSelectQueries.length = 0;
  observedUpdateQueries.length = 0;
}

function simulateUrlSearch(query) {
  return new URL(`https://example.test/rest/v1/ordenes?select=*&${query}`).search.slice(1);
}

// Minimal PostgREST-ish query parser. Supports the operators actually
// used by manualGiros.js: eq., in.(…), is.null, not.is.null + order + limit.
function parseQuery(query) {
  const parts = String(query || "").split("&").filter(Boolean);
  const filters = [];
  let order = null;
  let limit = null;
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = decodeURIComponent(p.slice(eq + 1));
    if (k === "select") continue;
    if (k === "order") { order = v; continue; }
    if (k === "limit") { limit = Number(v); continue; }
    if (v.startsWith("eq.")) {
      filters.push({ field: k, op: "eq", val: v.slice(3) });
    } else if (v.startsWith("in.(") && v.endsWith(")")) {
      const inner = v.slice(4, -1);
      const vals = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (inQ) {
          if (ch === '"' && inner[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') { inQ = false; }
          else cur += ch;
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ",") { vals.push(cur); cur = ""; }
          else cur += ch;
        }
      }
      vals.push(cur);
      filters.push({ field: k, op: "in", val: vals });
    } else if (v === "is.null") {
      filters.push({ field: k, op: "isnull" });
    } else if (v === "not.is.null") {
      filters.push({ field: k, op: "notnull" });
    } else {
      throw new Error(`parseQuery: unsupported predicate "${p}"`);
    }
  }
  return { filters, order, limit };
}

function rowMatches(row, filters) {
  for (const f of filters) {
    const v = row[f.field];
    if (f.op === "eq") { if (String(v) !== String(f.val)) return false; }
    else if (f.op === "in") { if (!f.val.includes(String(v))) return false; }
    else if (f.op === "isnull") { if (v != null) return false; }
    else if (f.op === "notnull") { if (v == null) return false; }
  }
  return true;
}

// ─── Cache stubs (must be installed BEFORE require of manualGiros) ─

const supabasePath = require.resolve("../src/utils/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    sbSelect: async (table, query = "") => {
      observedSelectQueries.push({ table, query });
      const { filters, order, limit } = parseQuery(simulateUrlSearch(query));
      let rows = db[table].filter(r => rowMatches(r, filters)).map(r => ({ ...r }));
      if (order) {
        const [field, dir] = order.split(".");
        rows.sort((a, b) => {
          if (a[field] === b[field]) return 0;
          const cmp = a[field] < b[field] ? -1 : 1;
          return dir === "desc" ? -cmp : cmp;
        });
      }
      if (limit != null) rows = rows.slice(0, limit);
      return rows;
    },
    sbInsert: async (table, data) => {
      const row = { ...data };
      if (table === "manual_giros") {
        if (collideOnceOnInsert) {
          // Simulate a concurrent inserter that wins the race: push a
          // phantom row with the same (giro_day, seq) and return the
          // PostgREST UNIQUE-violation code. The retry loop in
          // createManualGiro will recompute the seq and succeed.
          collideOnceOnInsert = false;
          db.manual_giros.push({
            id: `phantom_${row.seq}`,
            seq: row.seq,
            giro_day: row.giro_day,
            created_at: new Date().toISOString(),
            created_by: "concurrent_tester",
            dissolved_at: null,
          });
          return { code: "23505" };
        }
        if (!row.created_at) row.created_at = new Date().toISOString();
        if (row.dissolved_at === undefined) row.dissolved_at = null;
        const dup = db.manual_giros.find(
          r => r.giro_day === row.giro_day && r.seq === row.seq
        );
        if (dup) return { code: "23505" };
      }
      db[table].push(row);
      return [{ ...row }];
    },
    sbUpdate: async (table, query, data) => {
      observedUpdateQueries.push({ table, query, data });
      const { filters } = parseQuery(simulateUrlSearch(query));
      const updated = [];
      for (const r of db[table]) {
        if (rowMatches(r, filters)) {
          Object.assign(r, data);
          updated.push({ ...r });
        }
      }
      return "";
    },
    sbDelete: async (table, query) => {
      const { filters } = parseQuery(simulateUrlSearch(query));
      const kept = [];
      const removed = [];
      for (const r of db[table]) {
        if (rowMatches(r, filters)) removed.push(r);
        else kept.push(r);
      }
      db[table] = kept;
      return removed;
    },
    sbUpsert: async () => [],
    getConfig: async () => ({}),
  },
};

const servizioPath = require.resolve("../src/utils/servizio");
require.cache[servizioPath] = {
  id: servizioPath,
  filename: servizioPath,
  loaded: true,
  exports: {
    madridDateStr: () => FAKE_TODAY,
  },
};

// ─── Module under test ───────────────────────────────────────────
const mg = require("../src/agents/manualGiros");

// ─── Tiny test harness ───────────────────────────────────────────
const failures = [];
async function t(name, fn) {
  try {
    resetDb();
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}`);
    console.log(`       ${e && e.message ? e.message : e}`);
  }
}

// Helpers to seed
function seedOrder(o) {
  const row = {
    id: o.id,
    tipo_consegna: o.tipo_consegna || "DOMICILIO",
    estado: o.estado || "EN_COCINA",
    manual_giro_id: o.manual_giro_id || null,
  };
  db.ordenes.push(row);
  return row;
}
function seedGiro(g) {
  const row = {
    id: g.id,
    seq: g.seq,
    giro_day: g.giro_day || FAKE_TODAY,
    created_at: g.created_at || new Date().toISOString(),
    created_by: g.created_by || "pin_dashboard",
    dissolved_at: g.dissolved_at || null,
    hora_ref: g.hora_ref || null,
    anchor_order_id: g.anchor_order_id || null,
  };
  db.manual_giros.push(row);
  return row;
}

(async () => {
  // ── Pure helpers ───────────────────────────────────────────────

  await t("generateManualGiroId: format mg_yymmdd_seq", async () => {
    assert.strictEqual(mg.generateManualGiroId("2026-05-25", 1), "mg_260525_1");
    assert.strictEqual(mg.generateManualGiroId("2026-12-31", 42), "mg_261231_42");
  });

  await t("isOrderEligibleForGiro: DOMICILIO + selectable estado only", async () => {
    assert.strictEqual(mg.isOrderEligibleForGiro({ tipo_consegna: "DOMICILIO", estado: "EN_COCINA" }), true);
    assert.strictEqual(mg.isOrderEligibleForGiro({ tipo_consegna: "DOMICILIO", estado: "LISTO" }), true);
    assert.strictEqual(mg.isOrderEligibleForGiro({ tipo_consegna: "DOMICILIO", estado: "EN_ENTREGA" }), true);
    assert.strictEqual(mg.isOrderEligibleForGiro({ tipo_consegna: "RITIRO", estado: "EN_COCINA" }), false);
    assert.strictEqual(mg.isOrderEligibleForGiro({ tipo_consegna: "DOMICILIO", estado: "ENTREGADO" }), false);
    assert.strictEqual(mg.isOrderEligibleForGiro({ tipo_consegna: "DOMICILIO", estado: "POR_CONFIRMAR" }), false);
    assert.strictEqual(mg.isOrderEligibleForGiro(null), false);
  });

  await t("isStatusLeavingGiro: true iff status is outside selectable set", async () => {
    assert.strictEqual(mg.isStatusLeavingGiro("EN_COCINA"), false);
    assert.strictEqual(mg.isStatusLeavingGiro("LISTO"), false);
    assert.strictEqual(mg.isStatusLeavingGiro("EN_ENTREGA"), false);
    assert.strictEqual(mg.isStatusLeavingGiro("ENTREGADO"), true);
    assert.strictEqual(mg.isStatusLeavingGiro("CANCELADO"), true);
    assert.strictEqual(mg.isStatusLeavingGiro(""), true);
    assert.strictEqual(mg.isStatusLeavingGiro(null), true);
  });

  await t("isValidHoraRef: accepts HH:MM 24h and empty, rejects junk", async () => {
    assert.strictEqual(mg.isValidHoraRef("21:30"), true);
    assert.strictEqual(mg.isValidHoraRef("9:05"), true);
    assert.strictEqual(mg.isValidHoraRef("00:00"), true);
    assert.strictEqual(mg.isValidHoraRef("23:59"), true);
    // empty / null = "no operational time" → valid (optional field)
    assert.strictEqual(mg.isValidHoraRef(null), true);
    assert.strictEqual(mg.isValidHoraRef(undefined), true);
    assert.strictEqual(mg.isValidHoraRef(""), true);
    // invalid
    assert.strictEqual(mg.isValidHoraRef("25:99"), false);
    assert.strictEqual(mg.isValidHoraRef("24:00"), false);
    assert.strictEqual(mg.isValidHoraRef("21:60"), false);
    assert.strictEqual(mg.isValidHoraRef("21h30"), false);
    assert.strictEqual(mg.isValidHoraRef("abc"), false);
    assert.strictEqual(mg.isValidHoraRef("2130"), false);
    assert.strictEqual(mg.isValidHoraRef(2130), false);
  });

  await t("normalizeHoraRef: zero-pads hour, empty → null", async () => {
    assert.strictEqual(mg.normalizeHoraRef("9:05"), "09:05");
    assert.strictEqual(mg.normalizeHoraRef("21:30"), "21:30");
    assert.strictEqual(mg.normalizeHoraRef(""), null);
    assert.strictEqual(mg.normalizeHoraRef(null), null);
  });

  await t("encodeIdList: CSV-quoted with escaped inner quotes", async () => {
    assert.strictEqual(mg.encodeIdList(["#001", "#002"]), '"%23001","%23002"');
    assert.strictEqual(mg.encodeIdList([`a"b`]), '"a%22%22b"');
    assert.strictEqual(mg.encodeIdList([]), "");
    assert.strictEqual(mg.encodeIdList(null), "");
  });

  await t("validateManualGiroOrders: # ids remain intact through URL parsing", async () => {
    seedOrder({ id: "#001" });
    seedOrder({ id: "#002" });
    const res = await mg.validateManualGiroOrders(["#001", "#002"]);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.uniqIds, ["#001", "#002"]);
    const q = observedSelectQueries.find(x => x.table === "ordenes")?.query || "";
    assert.ok(q.includes('id=in.("%23001","%23002")'), q);
    assert.strictEqual(new URL(`https://example.test/rest/v1/ordenes?select=*&${q}`).hash, "");
  });

  await t("encodeEqValue: URL-encodes", async () => {
    assert.strictEqual(mg.encodeEqValue("mg_260525_1"), "mg_260525_1");
    assert.strictEqual(mg.encodeEqValue("#001"), "%23001");
  });

  // ── createManualGiro ───────────────────────────────────────────

  await t("createManualGiro: happy path 2 fresh orders", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.id, "mg_260525_1");
    assert.strictEqual(res.giro.seq, 1);
    assert.deepStrictEqual(res.giro.order_ids.sort(), ["#A", "#B"]);
    assert.strictEqual(res.giro.created_by, "pin_dashboard");
    assert.deepStrictEqual(res.moved_from, []);
    assert.strictEqual(db.manual_giros.length, 1);
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, "mg_260525_1");
    assert.strictEqual(db.ordenes.find(o => o.id === "#B").manual_giro_id, "mg_260525_1");
  });

  await t("createManualGiro: attach UPDATE supports # ids with PostgREST empty body", async () => {
    seedOrder({ id: "#001" });
    seedOrder({ id: "#002" });
    const res = await mg.createManualGiro(["#001", "#002"]);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.giro.order_ids, ["#001", "#002"]);
    const q = observedUpdateQueries.find(x => x.table === "ordenes" && x.query.startsWith("id=in."))?.query || "";
    assert.strictEqual(q, 'id=in.("%23001","%23002")');
    assert.strictEqual(new URL(`https://example.test/rest/v1/ordenes?select=*&${q}`).hash, "");
    assert.strictEqual(db.ordenes.find(o => o.id === "#001").manual_giro_id, "mg_260525_1");
    assert.strictEqual(db.ordenes.find(o => o.id === "#002").manual_giro_id, "mg_260525_1");
  });

  await t("createManualGiro: writes hora_ref + anchor_order_id (normalized)", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    const res = await mg.createManualGiro(["#A", "#B"], "9:05", "#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, "09:05");
    assert.strictEqual(res.giro.anchor_order_id, "#A");
    const row = db.manual_giros.find(g => g.id === res.giro.id);
    assert.strictEqual(row.hora_ref, "09:05");
    assert.strictEqual(row.anchor_order_id, "#A");
  });

  await t("createManualGiro: retro-compatible without hora_ref → null fields", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, null);
    assert.strictEqual(res.giro.anchor_order_id, null);
    const row = db.manual_giros.find(g => g.id === res.giro.id);
    assert.strictEqual(row.hora_ref, null);
    assert.strictEqual(row.anchor_order_id, null);
  });

  await t("createManualGiro: invalid hora_ref rejected, no giro created", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    const res = await mg.createManualGiro(["#A", "#B"], "25:99");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_hora_ref");
    assert.strictEqual(db.manual_giros.length, 0);
    // orders untouched
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, null);
  });

  await t("createManualGiro: < 2 orders rejected", async () => {
    seedOrder({ id: "#A" });
    const r1 = await mg.createManualGiro(["#A"]);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, "need_at_least_2_orders");
    const r2 = await mg.createManualGiro([]);
    assert.strictEqual(r2.ok, false);
  });

  await t("createManualGiro: duplicate ids collapse to single distinct → rejected", async () => {
    seedOrder({ id: "#A" });
    const res = await mg.createManualGiro(["#A", "#A"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "need_at_least_2_distinct_orders");
  });

  await t("createManualGiro: some_orders_not_found", async () => {
    seedOrder({ id: "#A" });
    const res = await mg.createManualGiro(["#A", "#GHOST"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "some_orders_not_found");
  });

  await t("createManualGiro: invalid_orders (non-DOMICILIO)", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B", tipo_consegna: "RITIRO" });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_orders");
    assert.deepStrictEqual(res.details, ["#B"]);
  });

  await t("createManualGiro: invalid_orders (non-selectable estado)", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B", estado: "ENTREGADO" });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_orders");
  });

  await t("createManualGiro: move-silent + auto-dissolve prev giro orphan", async () => {
    // Seed prev giro with 2 members (#A,#B). Creating new giro from
    // (#A, #C) must move #A out of prev → prev has only #B left
    // (still >=2? no, 1) → prev auto-dissolves.
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#C" });

    const res = await mg.createManualGiro(["#A", "#C"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.seq, 2);
    assert.deepStrictEqual(res.moved_from, ["mg_260525_1"]);

    const prev = db.manual_giros.find(g => g.id === "mg_260525_1");
    assert.ok(prev.dissolved_at, "prev giro must be soft-dissolved");
    // #B should have been detached by autoDissolveIfBelowThreshold
    assert.strictEqual(db.ordenes.find(o => o.id === "#B").manual_giro_id, null);
    // #A now belongs to the new giro
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, "mg_260525_2");
  });

  await t("createManualGiro: move-silent keeps prev alive when it still has >=2", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#C", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#D" });

    const res = await mg.createManualGiro(["#A", "#D"]);
    assert.strictEqual(res.ok, true);
    const prev = db.manual_giros.find(g => g.id === "mg_260525_1");
    assert.strictEqual(prev.dissolved_at, null, "prev giro must stay alive (B,C remain)");
    assert.strictEqual(db.ordenes.find(o => o.id === "#B").manual_giro_id, "mg_260525_1");
    assert.strictEqual(db.ordenes.find(o => o.id === "#C").manual_giro_id, "mg_260525_1");
  });

  await t("createManualGiro: retries on UNIQUE(giro_day,seq) violation", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    collideOnceOnInsert = true;
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, true);
    // Phantom inserted seq=1, retry computed seq=2.
    assert.strictEqual(res.giro.seq, 2);
    assert.strictEqual(res.giro.id, "mg_260525_2");
  });

  // ── addOrderToManualGiro ──────────────────────────────────────

  await t("addOrderToManualGiro: happy path attaches order", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#C" });
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#C");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.moved_from, null);
    assert.strictEqual(db.ordenes.find(o => o.id === "#C").manual_giro_id, "mg_260525_1");
  });

  await t("addOrderToManualGiro: missing args", async () => {
    const r1 = await mg.addOrderToManualGiro(null, "#A");
    assert.strictEqual(r1.error, "missing_args");
    const r2 = await mg.addOrderToManualGiro("g", null);
    assert.strictEqual(r2.error, "missing_args");
  });

  await t("addOrderToManualGiro: dissolved giro → 404", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1, dissolved_at: new Date().toISOString() });
    seedOrder({ id: "#A" });
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#A");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "giro_not_found_or_dissolved");
  });

  await t("addOrderToManualGiro: ineligible order", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", estado: "ENTREGADO" });
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#A");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "order_not_eligible");
  });

  await t("addOrderToManualGiro: same giro → no_op", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.no_op, true);
  });

  await t("addOrderToManualGiro: move-silent triggers prev auto-dissolve when prev<2", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedGiro({ id: "mg_260525_2", seq: 2 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#C", manual_giro_id: "mg_260525_2" });
    seedOrder({ id: "#D", manual_giro_id: "mg_260525_2" });

    const res = await mg.addOrderToManualGiro("mg_260525_2", "#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.moved_from, "mg_260525_1");
    assert.strictEqual(res.auto_dissolved_prev, true);
    const prev = db.manual_giros.find(g => g.id === "mg_260525_1");
    assert.ok(prev.dissolved_at);
  });

  // ── removeOrderFromManualGiro ─────────────────────────────────

  await t("removeOrderFromManualGiro: no manual_giro_id → no_op", async () => {
    seedOrder({ id: "#A" });
    const res = await mg.removeOrderFromManualGiro("#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.no_op, true);
  });

  await t("removeOrderFromManualGiro: detaches and keeps giro alive if >=2 remain", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#C", manual_giro_id: "mg_260525_1" });
    const res = await mg.removeOrderFromManualGiro("#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.auto_dissolved, false);
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, null);
    const giro = db.manual_giros.find(g => g.id === "mg_260525_1");
    assert.strictEqual(giro.dissolved_at, null);
  });

  await t("removeOrderFromManualGiro: triggers auto-dissolve when prev<2", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    const res = await mg.removeOrderFromManualGiro("#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.auto_dissolved, true);
    const giro = db.manual_giros.find(g => g.id === "mg_260525_1");
    assert.ok(giro.dissolved_at);
    assert.strictEqual(db.ordenes.find(o => o.id === "#B").manual_giro_id, null);
  });

  await t("removeOrderFromManualGiro: order_not_found", async () => {
    const res = await mg.removeOrderFromManualGiro("#GHOST");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "order_not_found");
  });

  // ── dissolveManualGiro ────────────────────────────────────────

  await t("dissolveManualGiro: detaches all + soft-dissolves", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    const res = await mg.dissolveManualGiro("mg_260525_1");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, null);
    assert.strictEqual(db.ordenes.find(o => o.id === "#B").manual_giro_id, null);
    assert.ok(db.manual_giros.find(g => g.id === "mg_260525_1").dissolved_at);
  });

  await t("dissolveManualGiro: missing id → 400", async () => {
    const res = await mg.dissolveManualGiro(null);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "missing_giro_id");
  });

  // ── autoDissolveIfBelowThreshold ──────────────────────────────

  await t("autoDissolveIfBelowThreshold: no-op when >=2 active", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    const r = await mg.autoDissolveIfBelowThreshold("mg_260525_1");
    assert.strictEqual(r, false);
    assert.strictEqual(db.manual_giros[0].dissolved_at, null);
  });

  await t("autoDissolveIfBelowThreshold: dissolves when <2 active", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1", estado: "ENTREGADO" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    const r = await mg.autoDissolveIfBelowThreshold("mg_260525_1");
    assert.strictEqual(r, true);
    assert.ok(db.manual_giros[0].dissolved_at);
    // All orders detached, even the non-active one
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, null);
    assert.strictEqual(db.ordenes.find(o => o.id === "#B").manual_giro_id, null);
  });

  await t("autoDissolveIfBelowThreshold: null giroId → false", async () => {
    const r = await mg.autoDissolveIfBelowThreshold(null);
    assert.strictEqual(r, false);
  });

  await t("countActiveMembers: counts only selectable states", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1", estado: "EN_COCINA" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1", estado: "EN_ENTREGA" });
    seedOrder({ id: "#C", manual_giro_id: "mg_260525_1", estado: "ENTREGADO" });
    const n = await mg.countActiveMembers("mg_260525_1");
    assert.strictEqual(n, 2);
  });

  // ── getManualGiros ────────────────────────────────────────────

  await t("getManualGiros: returns active giros with order_ids", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedGiro({ id: "mg_260525_2", seq: 2 });
    seedGiro({ id: "mg_260525_3", seq: 3, dissolved_at: new Date().toISOString() });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#C", manual_giro_id: "mg_260525_2" });
    const list = await mg.getManualGiros();
    assert.strictEqual(list.length, 2);
    const byId = Object.fromEntries(list.map(g => [g.id, g]));
    assert.deepStrictEqual(byId["mg_260525_1"].order_ids.sort(), ["#A", "#B"]);
    assert.deepStrictEqual(byId["mg_260525_2"].order_ids, ["#C"]);
  });

  await t("getManualGiros: returns hora_ref + anchor_order_id", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1, hora_ref: "21:30", anchor_order_id: "#A" });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    const list = await mg.getManualGiros();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].hora_ref, "21:30");
    assert.strictEqual(list[0].anchor_order_id, "#A");
  });

  await t("getManualGiros: onlyActive=false includes dissolved", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1, dissolved_at: new Date().toISOString() });
    const list = await mg.getManualGiros({ onlyActive: false });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, "mg_260525_1");
  });

  await t("getManualGiros: empty list when no giros for day", async () => {
    const list = await mg.getManualGiros({ day: "2026-05-26" });
    assert.deepStrictEqual(list, []);
  });

  // ── softDissolveActiveManualGirosForClose ─────────────────────

  await t("softDissolveActiveManualGirosForClose: detaches + dissolves all", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedGiro({ id: "mg_260525_2", seq: 2 });
    seedGiro({ id: "mg_260525_old", seq: 1, giro_day: "2026-05-24", dissolved_at: new Date().toISOString() });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_2" });
    seedOrder({ id: "#C" });
    const r = await mg.softDissolveActiveManualGirosForClose();
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.detached_count, 2);
    assert.strictEqual(r.dissolved_count, 2); // not the already-dissolved one
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, null);
    assert.strictEqual(db.ordenes.find(o => o.id === "#B").manual_giro_id, null);
    assert.ok(db.manual_giros.find(g => g.id === "mg_260525_1").dissolved_at);
    assert.ok(db.manual_giros.find(g => g.id === "mg_260525_2").dissolved_at);
  });

  // ── final report ──────────────────────────────────────────────
  if (failures.length) {
    console.error(`\n${failures.length} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nmanualGiros.test.js OK");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
