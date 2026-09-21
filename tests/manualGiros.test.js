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

// [FDV1 ATOMIC] every giro mutation is ONE call to a database function (POST /rest/v1/rpc/giro_*). The fake routes those calls to the
// shared JS reference model of the SQL (tests/helpers/giroRpcModel.js, kept honest by a differential test against real PostgreSQL 17).
const { createGiroRpcModel } = require("./helpers/giroRpcModel");
const observedRpc = [];
const giroModel = createGiroRpcModel({ tables: (n) => db[n], now: () => new Date().toISOString(), madridToday: () => FAKE_TODAY });

let FAKE_TODAY = "2026-05-25";
let collideOnceOnInsert = false; // (legacy) forces 1 UNIQUE-violation retry path — obsolete with FDV1 atomic create, kept for the replacement test
let rpcTransportOverride = null; // [FDV1 F2] when set, replaces the transport answer of a giro RPC (HTML / empty / truncated JSON / thrown socket errors); may call giroModel.apply first to simulate "COMMIT happened, answer lost"
const observedSelectQueries = [];
const observedUpdateQueries = [];

function resetDb() {
  db.manual_giros = [];
  db.ordenes = [];
  FAKE_TODAY = "2026-05-25";
  collideOnceOnInsert = false;
  rpcTransportOverride = null;
  observedSelectQueries.length = 0;
  observedUpdateQueries.length = 0;
  observedRpc.length = 0;
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
      if (String(table).startsWith("rpc/")) {                       // [FDV1] atomic giro function (one call = one transaction)
        observedRpc.push({ fn: String(table).slice(4), args: JSON.parse(JSON.stringify(data)) });
        if (rpcTransportOverride) return rpcTransportOverride(String(table).slice(4), data || {});
        return JSON.parse(JSON.stringify(giroModel.apply(String(table).slice(4), data || {})));
      }
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
// A test that awaits something that never settles (with no ref'd timer left) makes Node exit 0 in the middle of the run: fail loudly instead of "passing".
let reachedFinalReport = false;
process.on("exit", (code) => { if (!reachedFinalReport && code === 0) { console.error("manualGiros.test.js: the process exited before the final report (a test awaited something that never settled)"); process.exitCode = 1; } });
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
    // [FDV1] optional promise instant: lets a test express the DERIVED anchor / entrega_ref. Default null = unchanged behaviour.
    delivery_deadline_at: o.delivery_deadline_at || null,
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
    entrega_ref: g.entrega_ref || null,
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
    // [FDV1 contract change 1/5] POR_CONFIRMAR is now ELIGIBLE: an order is born POR_CONFIRMAR and AGGREGA/CREA GIRO
    // from Nuevo Pedido must be able to persist immediately (LIVE excluded it, so an aggregation could never stick).
    assert.strictEqual(mg.isOrderEligibleForGiro({ tipo_consegna: "DOMICILIO", estado: "POR_CONFIRMAR" }), true);
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

  // [FDV1 atomic change 1/2] LIVE attached members with a client-side `UPDATE ordenes id=in.("%23001",…)` whose URL encoding of
  // `#` ids mattered. Attach is now INSIDE the single database function call: ids travel as a JSON array argument (no URL, no encoding
  // hazard) and the client issues no ordenes UPDATE at all during create.
  await t("createManualGiro: # ids travel as JSON arguments of ONE atomic RPC call; the client issues no ordenes UPDATE", async () => {
    seedOrder({ id: "#001" });
    seedOrder({ id: "#002" });
    const res = await mg.createManualGiro(["#001", "#002"]);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.giro.order_ids, ["#001", "#002"]);
    const creates = observedRpc.filter(x => x.fn === "giro_create_v1");
    assert.strictEqual(creates.length, 1, "exactly one create call");
    assert.deepStrictEqual(creates[0].args.p_order_ids, ["#001", "#002"]);
    assert.strictEqual(observedUpdateQueries.some(x => x.table === "ordenes"), false, "no client-side attach UPDATE any more");
    assert.strictEqual(db.ordenes.find(o => o.id === "#001").manual_giro_id, "mg_260525_1");
    assert.strictEqual(db.ordenes.find(o => o.id === "#002").manual_giro_id, "mg_260525_1");
  });

  // [FDV1 contract change 2/5] The operator-chosen hora_ref / anchor are RETIRED. hora_ref is never written (null) and
  // anchor_order_id is DERIVED from the members (earliest delivery deadline), whatever the caller passes. The legacy
  // arguments are still accepted and validated (see the invalid_* tests below) but ignored.
  await t("createManualGiro: operator hora_ref/anchor are retired — hora_ref null, anchor derived (earliest deadline)", async () => {
    seedOrder({ id: "#A", delivery_deadline_at: "2026-05-25T19:10:00.000Z" }); // 21:10 Madrid
    seedOrder({ id: "#B", delivery_deadline_at: "2026-05-25T19:30:00.000Z" }); // 21:30 Madrid
    const res = await mg.createManualGiro(["#A", "#B"], "9:05", "#B");         // operator "asks" for #B + 09:05
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, null);
    assert.strictEqual(res.giro.anchor_order_id, "#A");                        // derived, NOT the operator's #B
    const row = db.manual_giros.find(g => g.id === res.giro.id);
    assert.strictEqual(row.hora_ref, null);
    assert.strictEqual(row.anchor_order_id, "#A");
  });

  await t("createManualGiro: retro-compatible without hora_ref → null fields", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, null);
    assert.strictEqual(res.giro.anchor_order_id, null);
    assert.strictEqual(res.giro.entrega_ref, null);
    const row = db.manual_giros.find(g => g.id === res.giro.id);
    assert.strictEqual(row.hora_ref, null);
    assert.strictEqual(row.anchor_order_id, null);
    assert.strictEqual(row.entrega_ref, null);
  });

  // [FDV1 contract change 3/5] entrega_ref is a DERIVED compat copy = min(member deadlines), not an operator-chosen time.
  // An operator value (here "09:05") must not be persisted; hora_ref/anchor are retired as in change 2/5.
  await t("createManualGiro: operator entrega_ref is retired — entrega_ref derived = earliest deadline, hora_ref null", async () => {
    seedOrder({ id: "#A", delivery_deadline_at: "2026-05-25T19:10:00.000Z" }); // 21:10 Madrid
    seedOrder({ id: "#B", delivery_deadline_at: "2026-05-25T19:30:00.000Z" }); // 21:30 Madrid
    const res = await mg.createManualGiro(["#A", "#B"], "17:49", "#B", "9:05");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, null);
    assert.strictEqual(res.giro.anchor_order_id, "#A");
    assert.strictEqual(res.giro.entrega_ref, "21:10");                          // derived, NOT the operator's 09:05
    const row = db.manual_giros.find(g => g.id === res.giro.id);
    assert.strictEqual(row.hora_ref, null);
    assert.strictEqual(row.entrega_ref, "21:10");
  });

  // [FDV1 contract change 4/5] Same rule when ONLY an entrega_ref is supplied: it is ignored, the derived value wins.
  await t("createManualGiro: operator entrega_ref alone is ignored — derived value wins, hora_ref stays null", async () => {
    seedOrder({ id: "#A", delivery_deadline_at: "2026-05-25T19:10:00.000Z" }); // 21:10 Madrid
    seedOrder({ id: "#B", delivery_deadline_at: "2026-05-25T19:30:00.000Z" }); // 21:30 Madrid
    const res = await mg.createManualGiro(["#A", "#B"], null, null, "18:12");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, null);
    assert.strictEqual(res.giro.entrega_ref, "21:10");                          // derived, NOT the operator's 18:12
    const row = db.manual_giros.find(g => g.id === res.giro.id);
    assert.strictEqual(row.hora_ref, null);
    assert.strictEqual(row.entrega_ref, "21:10");
  });

  await t("createManualGiro: invalid entrega_ref rejected, no giro created", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    const res = await mg.createManualGiro(["#A", "#B"], "17:49", "#B", "25:99");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_entrega_ref");
    assert.strictEqual(db.manual_giros.length, 0);
    assert.strictEqual(db.ordenes.find(o => o.id === "#A").manual_giro_id, null);
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

  // [FDV1 atomic change 2/2] LIVE computed MAX(seq)+1 on the client and retried on a UNIQUE(giro_day,seq) collision (race between
  // two backend processes). The seq is now assigned INSIDE the database function under the giro lock: no collision, no client retry.
  await t("createManualGiro: seq is assigned by the DB function under the giro lock (max+1), with NO client-side retry loop", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1 });
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.seq, 2);
    assert.strictEqual(res.giro.id, "mg_260525_2");
    assert.strictEqual(observedRpc.filter(x => x.fn === "giro_create_v1").length, 1, "one call, no retry");
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
    // [FDV1 contract change 5/5] A giro with <2 active members ("giro monco": here mg_260525_2 with only #C) is NEVER
    // shown as an active giro — LIVE listed it. Hidden at read time, whatever a partial failure left in the DB.
    assert.strictEqual(list.length, 1);
    const byId = Object.fromEntries(list.map(g => [g.id, g]));
    assert.deepStrictEqual(byId["mg_260525_1"].order_ids.sort(), ["#A", "#B"]);
    assert.strictEqual(byId["mg_260525_2"], undefined, "single-member giro must not be listed");
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

  await t("getManualGiros: returns entrega_ref alongside hora_ref", async () => {
    seedGiro({ id: "mg_260525_1", seq: 1, hora_ref: "17:49", anchor_order_id: "#B", entrega_ref: "18:12" });
    seedOrder({ id: "#A", manual_giro_id: "mg_260525_1" });
    seedOrder({ id: "#B", manual_giro_id: "mg_260525_1" });
    const list = await mg.getManualGiros();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].hora_ref, "17:49");
    assert.strictEqual(list[0].entrega_ref, "18:12");
    assert.strictEqual(list[0].anchor_order_id, "#B");
    // entrega_ref must be in the select string for real PostgREST
    const q = observedSelectQueries.find(x => x.table === "manual_giros")?.query || "";
    assert.ok(q.includes("entrega_ref"), q);
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

  // ── [FDV1 F2] giroRpc: honest classification when the outcome cannot be known ──────────────────
  // sbFetch drops the HTTP status: a failure is "definite" only when the answer PROVES it (a well-formed PostgREST / PostgreSQL error body with a
  // code raised before COMMIT, or a connection that was never established). Everything else is giro_rpc_outcome_unknown (504), never db_rpc_failed.

  const isUnknown = (r) => r.ok === false && r.status === 504 && r.error === "giro_rpc_outcome_unknown" && r.outcome_unknown === true;
  const sockErr = (code, msg = "fetch failed") => Object.assign(new TypeError(msg), { cause: Object.assign(new Error(`connect ${code}`), { code }) });

  await t("F2 giroRpc: typed answers and PGRST202 are classified as before", async () => {
    const typed = { ok: false, status: 409, error: "giro_full", max: 4 };
    assert.deepStrictEqual(mg.classifyGiroRpcAnswer(typed), typed, "typed ok:false is returned untouched");
    assert.deepStrictEqual(mg.classifyGiroRpcAnswer({ ok: true, giro: { id: "x" } }), { ok: true, giro: { id: "x" } });
    const r = mg.classifyGiroRpcAnswer({ code: "PGRST202", message: "Could not find the function" });
    assert.strictEqual(r.status, 503); assert.strictEqual(r.error, "giro_atomic_unavailable");
  });

  await t("F2 giroRpc: codes that can only be raised BEFORE the commit → 502 db_rpc_failed (definite, outcome_unknown:false)", async () => {
    for (const code of ["42501", "42883", "P0001", "40P01", "40001", "55P03", "57014", "22P02", "23505", "PGRST102", "PGRST303", "PGRST301", "PGRST116"]) {
      const r = mg.classifyGiroRpcAnswer({ code, message: "m", details: null, hint: null });
      assert.ok(r.ok === false && r.status === 502 && r.error === "db_rpc_failed" && r.outcome_unknown === false && r.not_executed === undefined, `${code} → definite`);
      assert.strictEqual(r.details.code, code);
    }
  });

  await t("F2 giroRpc: codes that MAY follow the send (connection / shutdown / internal / pool) → outcome unknown", async () => {
    for (const code of ["08006", "08003", "57P01", "57P02", "57P03", "XX000", "58030", "53300", "PGRST000", "PGRST001", "PGRST002", "PGRST003", "28P01"]) {
      const r = mg.classifyGiroRpcAnswer({ code, message: "m" });
      assert.ok(isUnknown(r), `${code} → unknown`); assert.strictEqual(r.reason, "ambiguous_error_code");
    }
  });

  await t("F2 giroRpc: gateway / mangled / non-JSON bodies → outcome unknown (never a certain failure)", async () => {
    const bodies = {
      "HTML 502": "<html><body><h1>502 Bad Gateway</h1></body></html>", "HTML 504": "<html><body><h1>504 Gateway Timeout</h1></body></html>",
      "empty string": "", "plain text": "upstream request timeout", "JSON cut in half (as text)": '{"ok":true,"giro":{"id":"mg_26092',
      "gateway JSON without a code": { message: "The upstream server is timing out" }, "object with code but no message": { code: "42501" },
      "code that is not a string": { code: 42501, message: "m" }, 'ok is a string, not a boolean': { ok: "true" }, "empty object": {}, "array": [], "array of rows": [{ id: 1 }],
      "null": null, "undefined": undefined, "number": 42, "boolean": true,
    };
    for (const [name, body] of Object.entries(bodies)) { const r = mg.classifyGiroRpcAnswer(body); assert.ok(isUnknown(r), `${name} → unknown, got ${JSON.stringify(r)}`); }
    assert.strictEqual(mg.classifyGiroRpcAnswer("<html>…</html>").reason, "non_json_body");
    assert.strictEqual(mg.classifyGiroRpcAnswer({ message: "x" }).reason, "unrecognised_body");
    assert.ok(mg.classifyGiroRpcAnswer("x".repeat(5000)).details.length <= 200, "the body sample kept for diagnostics is bounded");
  });

  await t("F2 giroRpc: thrown transport errors — connection never established → not executed; anything else → unknown", async () => {
    for (const c of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
      const r = mg.classifyGiroRpcError(sockErr(c));
      assert.ok(r.ok === false && r.status === 502 && r.error === "db_rpc_failed" && r.not_executed === true && r.outcome_unknown === false && r.reason === "connect_failed" && r.code === c, `${c} → provably not executed`);
    }
    const agg = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new AggregateError([Object.assign(new Error("::1"), { code: "ECONNREFUSED" }), Object.assign(new Error("127.0.0.1"), { code: "ECONNREFUSED" })], "x"), { code: "ECONNREFUSED" }) });
    assert.strictEqual(mg.classifyGiroRpcError(agg).not_executed, true, "AggregateError of refused attempts (dual-stack localhost) → not executed");
    const mixed = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" }), Object.assign(new Error("b"), { code: "ECONNRESET" })], "x"), { code: "ECONNREFUSED" }) });
    assert.ok(isUnknown(mg.classifyGiroRpcError(mixed)), "one attempt that is NOT provably pre-connect → unknown");
    for (const c of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "EPIPE", "ERR_SSL_WRONG_VERSION_NUMBER", "UND_ERR_ABORTED"]) assert.ok(isUnknown(mg.classifyGiroRpcError(sockErr(c))), `${c} → unknown (the request may have reached the database)`);
    assert.strictEqual(mg.classifyGiroRpcError(Object.assign(new Error("giro_timeout:insert"), { code: "GIRO_TIMEOUT" })).reason, "timeout");
    assert.ok(isUnknown(mg.classifyGiroRpcError(new TypeError("fetch failed"))), "no error code at all → unknown");
    assert.ok(isUnknown(mg.classifyGiroRpcError(new TypeError("fetch failed", { cause: new Error("bad port") }))), "fetch's own 'bad port' rejection is not claimed as not-executed");
    for (const weird of [undefined, null, "boom", 42, {}]) assert.ok(isUnknown(mg.classifyGiroRpcError(weird)), `non-Error throw (${JSON.stringify(weird)}) → unknown, no crash`);
    const cyc = new Error("cyc"); cyc.cause = cyc; assert.ok(isUnknown(mg.classifyGiroRpcError(cyc)), "cyclic cause chain terminates");
  });

  await t("F2 giroRpc: the local watchdog timeout → unknown / reason timeout (the request may still complete server-side)", async () => {
    const saved = mg.__lock.fetchTimeoutMs; mg.__lock.fetchTimeoutMs = 40;
    const keepAlive = setInterval(() => {}, 1000);      // the watchdog timer inside giroRpc is unref'd (in production the HTTP server keeps the loop alive); here nothing else would
    try { rpcTransportOverride = () => new Promise(() => {}); const r = await mg.createManualGiro(["#A", "#B"]); assert.ok(isUnknown(r)); assert.strictEqual(r.reason, "timeout"); }
    finally { clearInterval(keepAlive); mg.__lock.fetchTimeoutMs = saved; }
  });

  await t("F2 createManualGiro: COMMIT happened, gateway answers 504 HTML → outcome UNKNOWN (not a certain failure); the giro exists; the retry is idempotent", async () => {
    seedOrder({ id: "#A" }); seedOrder({ id: "#B" });
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return "<html><body><h1>504 Gateway Timeout</h1></body></html>"; };   // the DB committed, the answer is a gateway page
    const r1 = await mg.createManualGiro(["#A", "#B"]);
    assert.ok(isUnknown(r1), `first answer: ${JSON.stringify(r1)}`);
    assert.notStrictEqual(r1.error, "db_rpc_failed", "a committed write must never be reported as a certain failure");
    assert.strictEqual(db.manual_giros.length, 1, "the write DID happen"); assert.strictEqual(db.ordenes.filter(o => o.manual_giro_id).length, 2);
    rpcTransportOverride = null;
    const r2 = await mg.createManualGiro(["#A", "#B"]);
    assert.ok(r2.ok === true && r2.idempotent === true, `retry: ${JSON.stringify(r2)}`); assert.strictEqual(db.manual_giros.length, 1, "no duplicate giro");
  });

  await t("F2 createManualGiro: EMPTY body after COMMIT / truncated JSON after COMMIT → unknown, retry idempotent", async () => {
    for (const body of ["", '{"ok":true,"giro":{"id":"mg_2605']) {
      resetDb(); seedOrder({ id: "#A" }); seedOrder({ id: "#B" });
      rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return body; };
      const r1 = await mg.createManualGiro(["#A", "#B"]); assert.ok(isUnknown(r1), JSON.stringify(body)); assert.strictEqual(db.manual_giros.length, 1);
      rpcTransportOverride = null; const r2 = await mg.createManualGiro(["#A", "#B"]); assert.ok(r2.ok && r2.idempotent === true && db.manual_giros.length === 1);
    }
  });

  await t("F2 add / remove / dissolve: answer lost after COMMIT → unknown; a plain retry converges (no_op / ok)", async () => {
    seedOrder({ id: "#A" }); seedOrder({ id: "#B" }); seedOrder({ id: "#C" });
    const g = await mg.createManualGiro(["#A", "#B"]); assert.ok(g.ok); const gid = g.giro.id;
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return "<html>502</html>"; };
    const a1 = await mg.addOrderToManualGiro(gid, "#C"); assert.ok(isUnknown(a1)); assert.strictEqual(db.ordenes.find(o => o.id === "#C").manual_giro_id, gid, "the add DID commit");
    rpcTransportOverride = null; const a2 = await mg.addOrderToManualGiro(gid, "#C"); assert.ok(a2.ok && a2.no_op === true, JSON.stringify(a2));
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return ""; };
    const r1 = await mg.removeOrderFromManualGiro("#C"); assert.ok(isUnknown(r1)); assert.strictEqual(db.ordenes.find(o => o.id === "#C").manual_giro_id, null, "the remove DID commit");
    rpcTransportOverride = null; const r2 = await mg.removeOrderFromManualGiro("#C"); assert.ok(r2.ok && r2.no_op === true, JSON.stringify(r2));
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return null; };
    const d1 = await mg.dissolveManualGiro(gid); assert.ok(isUnknown(d1)); assert.ok(db.manual_giros.find(x => x.id === gid).dissolved_at, "the dissolve DID commit");
    rpcTransportOverride = null; const d2 = await mg.dissolveManualGiro(gid); assert.ok(d2.ok === true, JSON.stringify(d2));
  });

  await t("F2 createManualGiro: connection refused → provably NOT executed (definite), nothing written; retry creates exactly one giro", async () => {
    seedOrder({ id: "#A" }); seedOrder({ id: "#B" });
    rpcTransportOverride = () => { throw sockErr("ECONNREFUSED"); };
    const r1 = await mg.createManualGiro(["#A", "#B"]);
    assert.ok(r1.ok === false && r1.error === "db_rpc_failed" && r1.not_executed === true && r1.outcome_unknown === false, JSON.stringify(r1)); assert.strictEqual(db.manual_giros.length, 0);
    rpcTransportOverride = null; const r2 = await mg.createManualGiro(["#A", "#B"]); assert.ok(r2.ok === true && !r2.idempotent); assert.strictEqual(db.manual_giros.length, 1);
  });

  await t("F2 createManualGiro: socket reset after send (request may have arrived) → unknown, not 'not executed'", async () => {
    seedOrder({ id: "#A" }); seedOrder({ id: "#B" });
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); throw sockErr("ECONNRESET"); };
    const r1 = await mg.createManualGiro(["#A", "#B"]); assert.ok(isUnknown(r1) && r1.not_executed === undefined); assert.strictEqual(db.manual_giros.length, 1);
    rpcTransportOverride = null; const r2 = await mg.createManualGiro(["#A", "#B"]); assert.ok(r2.ok && r2.idempotent === true && db.manual_giros.length === 1);
  });

  // ── [FDV1 F2 / F-R1] PostgREST's own error codes: a POSITIVE list; codes it raises AFTER the COMMIT are "unknown" ───────────────
  // The real PostgREST 16.3 answers PGRST111 / PGRST112 (invalid response.headers / response.status GUC) and PGRST103 (416 out of range with Prefer: count=exact) AFTER the transaction has
  // committed: the write is durable while the HTTP answer is an error. The bodies below were captured from that server (an RPC that writes, then leaves the GUC / the offset in that state).
  const PGRST_AFTER_COMMIT = {
    PGRST111: { code: "PGRST111", details: null, hint: null, message: "response.headers guc must be a JSON array composed of objects with a single key and a string value" },
    PGRST112: { code: "PGRST112", details: null, hint: null, message: "response.status guc must be a valid status code" },
    PGRST103: { code: "PGRST103", details: "An offset of 100 was requested, but there are only 2 rows.", hint: null, message: "Requested range not satisfiable" },
  };
  // measured on the real server to be raised BEFORE the COMMIT (rejected before execution, or rolled back) and never after it; PGRST202 is answered separately (503)
  const PGRST_BEFORE_COMMIT = ["PGRST100", "PGRST101", "PGRST102", "PGRST106", "PGRST107", "PGRST108", "PGRST116", "PGRST118", "PGRST121", "PGRST122", "PGRST123", "PGRST124", "PGRST127", "PGRST128",
    "PGRST200", "PGRST201", "PGRST203", "PGRST300", "PGRST301", "PGRST302", "PGRST303"];

  await t("F-R1 classifier: PGRST111 / PGRST112 / PGRST103 (real bodies) → giro_rpc_outcome_unknown, never db_rpc_failed", async () => {
    for (const [code, body] of Object.entries(PGRST_AFTER_COMMIT)) {
      const r = mg.classifyGiroRpcAnswer(body);
      assert.ok(isUnknown(r), `${code} → unknown, got ${JSON.stringify(r)}`); assert.strictEqual(r.reason, "ambiguous_error_code"); assert.notStrictEqual(r.error, "db_rpc_failed");
      assert.strictEqual(r.not_executed, undefined, `${code}: never claimed as not executed`);
    }
  });

  await t("F-R1 classifier: PostgREST codes are a POSITIVE list — exactly the measured pre-COMMIT codes are definite; every other PGRSTnnn (unlisted, future, connection-level, response stage) is unknown", async () => {
    const definite = [];
    for (let n = 0; n <= 999; n++) {
      const code = "PGRST" + String(n).padStart(3, "0");
      const r = mg.classifyGiroRpcAnswer({ code, message: "m", details: null, hint: null });
      if (code === "PGRST202") { assert.strictEqual(r.status, 503); assert.strictEqual(r.error, "giro_atomic_unavailable"); continue; }
      if (r.error === "db_rpc_failed") { assert.strictEqual(r.outcome_unknown, false, code); definite.push(code); } else assert.ok(isUnknown(r), `${code} → ${JSON.stringify(r)}`);
    }
    assert.deepStrictEqual(definite, PGRST_BEFORE_COMMIT, "the definite PGRST set is EXACTLY the measured list: a wildcard, an added code or a dropped code fails here");
    for (const code of ["PGRST", "PGRST1", "PGRST10", "PGRST1020", "PGRST1O2", "pgrst102", " PGRST102", "PGRST102 ", "PGRSTxxx", "PGRST-102"]) assert.ok(isUnknown(mg.classifyGiroRpcAnswer({ code, message: "m" })), `${JSON.stringify(code)} → unknown (exact match only)`);
    for (const code of ["PGRST102", "PGRST301"]) assert.ok(isUnknown(mg.classifyGiroRpcAnswer({ code })), `${code} without a message → unknown, as for every other code`);
  });

  await t("F-R1 control: a code that IS proven pre-COMMIT (JWT / body / SQLSTATE) still reports a DEFINITE failure, nothing was written, and the retry creates exactly one giro", async () => {
    for (const body of [{ code: "PGRST301", message: "No suitable key or wrong key type", details: null, hint: null }, { code: "PGRST102", message: "Empty or invalid json", details: null, hint: null }, { code: "42501", message: "permission denied for function giro_create_v1", details: null, hint: null }]) {
      resetDb(); seedOrder({ id: "#A" }); seedOrder({ id: "#B" });
      rpcTransportOverride = () => body;                                                     // rejected / rolled back: nothing reached the tables
      const r1 = await mg.createManualGiro(["#A", "#B"]);
      assert.ok(r1.ok === false && r1.error === "db_rpc_failed" && r1.outcome_unknown === false && r1.not_executed === undefined, `${body.code}: ${JSON.stringify(r1)}`); assert.strictEqual(db.manual_giros.length, 0, "nothing written");
      rpcTransportOverride = null; const r2 = await mg.createManualGiro(["#A", "#B"]); assert.ok(r2.ok === true && !r2.idempotent); assert.strictEqual(db.manual_giros.length, 1);
    }
  });

  await t("F-R1 createManualGiro: COMMIT happened, PostgREST answers PGRST111 / PGRST112 / PGRST103 → outcome UNKNOWN (not a certain failure); the giro exists; the retry is idempotent", async () => {
    for (const [code, body] of Object.entries(PGRST_AFTER_COMMIT)) {
      resetDb(); seedOrder({ id: "#A" }); seedOrder({ id: "#B" });
      rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return body; };      // the DB committed; the answer is PostgREST's post-commit error
      const r1 = await mg.createManualGiro(["#A", "#B"]);
      assert.ok(isUnknown(r1), `${code}: ${JSON.stringify(r1)}`); assert.notStrictEqual(r1.error, "db_rpc_failed", `${code}: a committed write must never be reported as a certain failure`);
      assert.strictEqual(db.manual_giros.length, 1, `${code}: the write DID happen`); assert.strictEqual(db.ordenes.filter(o => o.manual_giro_id).length, 2);
      rpcTransportOverride = null;
      const r2 = await mg.createManualGiro(["#A", "#B"]); assert.ok(r2.ok === true && r2.idempotent === true, `${code} retry: ${JSON.stringify(r2)}`); assert.strictEqual(db.manual_giros.length, 1, "no duplicate giro");
    }
  });

  await t("F-R1 add / remove / dissolve / reconcile: COMMIT happened, PostgREST answers PGRST111 / PGRST112 / PGRST103 → unknown; a plain retry converges", async () => {
    seedOrder({ id: "#A" }); seedOrder({ id: "#B" }); seedOrder({ id: "#C" });
    const g = await mg.createManualGiro(["#A", "#B"]); assert.ok(g.ok); const gid = g.giro.id;
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return PGRST_AFTER_COMMIT.PGRST111; };
    const a1 = await mg.addOrderToManualGiro(gid, "#C"); assert.ok(isUnknown(a1), JSON.stringify(a1)); assert.strictEqual(db.ordenes.find(o => o.id === "#C").manual_giro_id, gid, "the add DID commit");
    rpcTransportOverride = null; const a2 = await mg.addOrderToManualGiro(gid, "#C"); assert.ok(a2.ok && a2.no_op === true, JSON.stringify(a2));
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return PGRST_AFTER_COMMIT.PGRST112; };
    const r1 = await mg.removeOrderFromManualGiro("#C"); assert.ok(isUnknown(r1), JSON.stringify(r1)); assert.strictEqual(db.ordenes.find(o => o.id === "#C").manual_giro_id, null, "the remove DID commit");
    rpcTransportOverride = null; const r2 = await mg.removeOrderFromManualGiro("#C"); assert.ok(r2.ok && r2.no_op === true, JSON.stringify(r2));
    seedOrder({ id: "#X", manual_giro_id: "mg_ghost" });                                    // a link to a giro that does not exist: reconcile detaches it
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return PGRST_AFTER_COMMIT.PGRST103; };
    const c1 = await mg.reconcileManualGiros({ alignOffsets: false }); assert.ok(isUnknown(c1), JSON.stringify(c1)); assert.strictEqual(db.ordenes.find(o => o.id === "#X").manual_giro_id, null, "the reconcile DID commit");
    rpcTransportOverride = null; const c2 = await mg.reconcileManualGiros({ alignOffsets: false }); assert.ok(c2.ok === true, JSON.stringify(c2));
    rpcTransportOverride = (fn, data) => { giroModel.apply(fn, data); return PGRST_AFTER_COMMIT.PGRST112; };
    const d1 = await mg.dissolveManualGiro(gid); assert.ok(isUnknown(d1), JSON.stringify(d1)); assert.ok(db.manual_giros.find(x => x.id === gid).dissolved_at, "the dissolve DID commit");
    rpcTransportOverride = null; const d2 = await mg.dissolveManualGiro(gid); assert.ok(d2.ok === true, JSON.stringify(d2));
  });

  // ── final report ──────────────────────────────────────────────
  reachedFinalReport = true;
  if (failures.length) {
    console.error(`\n${failures.length} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nmanualGiros.test.js OK");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
