// tests/manualGiros.test.js — P1C.1 of DELIVERY-MANUAL-GIRO-01 / W5 Packet 01
// Unit tests for src/agents/manualGiros.js. No real DB. Supabase and
// currentOperationalSession are stubbed via require.cache before the
// module-under-test is loaded (same pattern as closingTimeGuard.test.js).
//
// W5 Packet 01: the four public writers (createManualGiro/addOrderToManualGiro/
// removeOrderFromManualGiro/dissolveManualGiro) no longer touch raw DB rows
// directly for membership/state -- each calls exactly ONE Authority RPC via
// sbRpc. This file's job is to prove the WRAPPER layer's own correctness (id
// resolution, exact RPC name/args, response mapping, best-effort legacy
// metadata) against STUBBED, controlled RPC responses -- it does not
// re-simulate the Authority's own decision logic in JS (that is exhaustively
// certified separately by ci/giro-authority-certification/harness/runW5Packet01.js
// against a real ephemeral Postgres, 299/299). autoDissolveIfBelowThreshold/
// countActiveMembers/softDissolveActiveManualGirosForClose remain byte-identical
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
// raw-DB functions (agentOrdini.js dependency) and keep the original fake-DB
// harness below unchanged for them.

const assert = require("assert");

// ─── In-memory fake DB (raw tables — still used by the legacy-support tests) ──
const db = {
  manual_giros: [],
  ordenes: [],
};

const observedSelectQueries = [];
const observedUpdateQueries = [];
const observedRpcCalls = [];
let rpcHandler = null; // (fn, args) => body|null, set per-test

function resetDb() {
  db.manual_giros = [];
  db.ordenes = [];
  observedSelectQueries.length = 0;
  observedUpdateQueries.length = 0;
  observedRpcCalls.length = 0;
  rpcHandler = null;
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
        if (!row.created_at) row.created_at = new Date().toISOString();
        if (row.dissolved_at === undefined) row.dissolved_at = null;
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
    // W5 Packet 01 — the sole mutation transport now. rpcHandler is set per
    // test to a pure (fn, args) => body function; observedRpcCalls records
    // every call for the "exactly one RPC" mechanical proofs.
    sbRpc: async (fn, args) => {
      observedRpcCalls.push({ fn, args });
      if (!rpcHandler) throw new Error(`sbRpc(${fn}) called with no rpcHandler installed`);
      const body = rpcHandler(fn, args);
      return { httpStatus: 200, ok: true, body };
    },
  },
};

const sessionPath = require.resolve("../src/serviceSessions/currentOperationalSession");
let SCOPE_IDS = ["11111111-1111-1111-1111-111111111111"];
let SCOPE_THROWS = false;
require.cache[sessionPath] = {
  id: sessionPath,
  filename: sessionPath,
  loaded: true,
  exports: {
    async getOperationalSessionIds() {
      if (SCOPE_THROWS) throw new Error("scope_unavailable_stub");
      return SCOPE_IDS;
    },
    async getCurrentOperationalSession() { return null; },
    async getCurrentOperationalBusinessDate() { return null; },
    async getPriorDayCarryoverSessionIds() { return []; },
    serviceSessionQuery: () => "",
    serviceSessionsQuery: () => "",
  },
};

// ─── Module under test ───────────────────────────────────────────
const mg = require("../src/agents/manualGiros");

// ─── Tiny test harness ───────────────────────────────────────────
const failures = [];
async function t(name, fn) {
  try {
    resetDb();
    SCOPE_IDS = ["11111111-1111-1111-1111-111111111111"];
    SCOPE_THROWS = false;
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}`);
    console.log(`       ${e && e.message ? e.message : e}`);
  }
}

// Helpers to seed
let uidSeq = 0;
function nextUid() {
  uidSeq += 1;
  return `00000000-0000-0000-0000-${String(uidSeq).padStart(12, "0")}`;
}
function seedOrder(o) {
  const row = {
    id: o.id,
    order_uid: o.order_uid || nextUid(),
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
    giro_day: g.giro_day || "2026-05-25",
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
const orderUid = (id) => db.ordenes.find((o) => o.id === id).order_uid;

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
    assert.strictEqual(mg.isValidHoraRef(null), true);
    assert.strictEqual(mg.isValidHoraRef(undefined), true);
    assert.strictEqual(mg.isValidHoraRef(""), true);
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

  await t("encodeEqValue: URL-encodes", async () => {
    assert.strictEqual(mg.encodeEqValue("mg_260525_1"), "mg_260525_1");
    assert.strictEqual(mg.encodeEqValue("#001"), "%23001");
  });

  // ── createManualGiro (W5: sbRpc giro_authority_create_or_move_v1) ─

  await t("createManualGiro: happy path -> exactly one create_or_move RPC with resolved uids", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    rpcHandler = (fn, args) => {
      assert.strictEqual(fn, "giro_authority_create_or_move_v1");
      assert.deepStrictEqual(args.p_order_uids.sort(), [orderUid("#A"), orderUid("#B")].sort());
      assert.strictEqual(args.p_actor, "pin_dashboard");
      assert.deepStrictEqual(args.p_operational_session_ids, SCOPE_IDS);
      return { ok: true, code: "OK", giro_id: "mg_260525_1", business_date: "2026-05-25", moved_from: [] };
    };
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.id, "mg_260525_1");
    assert.deepStrictEqual(res.giro.order_ids.sort(), ["#A", "#B"]);
    assert.deepStrictEqual(res.moved_from, []);
    assert.strictEqual(observedRpcCalls.filter((c) => c.fn === "giro_authority_create_or_move_v1").length, 1,
      "exactly one create_or_move RPC per logical mutation");
  });

  await t("createManualGiro: writes hora_ref/anchor_order_id/entrega_ref via best-effort legacy metadata update", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    rpcHandler = () => ({ ok: true, code: "OK", giro_id: "mg_260525_1", business_date: "2026-05-25", moved_from: [] });
    const res = await mg.createManualGiro(["#A", "#B"], "9:05", "#A", "18:12");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, "09:05");
    assert.strictEqual(res.giro.anchor_order_id, "#A");
    assert.strictEqual(res.giro.entrega_ref, "18:12");
    const metaUpdate = observedUpdateQueries.find((u) => u.table === "manual_giros");
    assert.ok(metaUpdate, "expected a best-effort manual_giros metadata UPDATE");
    assert.strictEqual(metaUpdate.data.entrega_ref, "18:12");
    assert.strictEqual(metaUpdate.data.anchor_order_id, "#A");
  });

  await t("createManualGiro: retro-compatible without hora_ref/anchor/entrega -> no metadata write, all null", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    rpcHandler = () => ({ ok: true, code: "OK", giro_id: "mg_260525_1", business_date: "2026-05-25", moved_from: [] });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.giro.hora_ref, null);
    assert.strictEqual(res.giro.anchor_order_id, null);
    assert.strictEqual(res.giro.entrega_ref, null);
    assert.strictEqual(observedUpdateQueries.find((u) => u.table === "manual_giros"), undefined,
      "no metadata write when nothing to write");
  });

  await t("createManualGiro: invalid entrega_ref rejected BEFORE any RPC call", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    rpcHandler = () => { throw new Error("must not call the Authority on local validation failure"); };
    const res = await mg.createManualGiro(["#A", "#B"], "17:49", "#B", "25:99");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_entrega_ref");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("createManualGiro: invalid hora_ref rejected BEFORE any RPC call", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    rpcHandler = () => { throw new Error("must not call the Authority"); };
    const res = await mg.createManualGiro(["#A", "#B"], "25:99");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_hora_ref");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("createManualGiro: < 2 orders rejected locally, no RPC", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = () => { throw new Error("must not call the Authority"); };
    const r1 = await mg.createManualGiro(["#A"]);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, "need_at_least_2_orders");
    const r2 = await mg.createManualGiro([]);
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("createManualGiro: duplicate ids collapse to single distinct -> rejected locally, no RPC", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = () => { throw new Error("must not call the Authority"); };
    const res = await mg.createManualGiro(["#A", "#A"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "need_at_least_2_distinct_orders");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("createManualGiro: some_orders_not_found resolved BEFORE calling the Authority (id->uid lookup)", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = () => { throw new Error("must not call the Authority when an id can't be resolved"); };
    const res = await mg.createManualGiro(["#A", "#GHOST"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "some_orders_not_found");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("createManualGiro: Authority ORDER_NOT_ELIGIBLE refusal mapped to invalid_orders", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    rpcHandler = () => ({ ok: false, code: "ORDER_NOT_ELIGIBLE", reason: "NOT_DOMICILIO" });
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_orders");
    assert.strictEqual(res.details, "NOT_DOMICILIO");
  });

  await t("createManualGiro: move-silent -> moved_from reported verbatim from the Authority (one RPC, no JS detach)", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#C" });
    rpcHandler = (fn) => {
      assert.strictEqual(fn, "giro_authority_create_or_move_v1");
      return { ok: true, code: "OK", giro_id: "mg_260525_2", business_date: "2026-05-25", moved_from: ["mg_260525_1"] };
    };
    const res = await mg.createManualGiro(["#A", "#C"]);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.moved_from, ["mg_260525_1"]);
    assert.strictEqual(observedRpcCalls.length, 1, "one RPC handles create + all internal moves atomically");
  });

  await t("createManualGiro: Authority transport failure -> explicit typed error, never a fabricated success", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    rpcHandler = () => null; // simulates a non-2xx/non-JSON transport failure
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "authority_call_failed");
  });

  await t("createManualGiro: scope unavailable -> explicit 503, no RPC call at all", async () => {
    seedOrder({ id: "#A" });
    seedOrder({ id: "#B" });
    SCOPE_THROWS = true;
    rpcHandler = () => { throw new Error("must not call the Authority without a resolved scope"); };
    const res = await mg.createManualGiro(["#A", "#B"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "authority_scope_unavailable");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  // ── addOrderToManualGiro (W5: sbRpc giro_authority_attach_or_move_v1) ─

  await t("addOrderToManualGiro: happy path -> exactly one attach_or_move RPC", async () => {
    seedOrder({ id: "#C" });
    rpcHandler = (fn, args) => {
      assert.strictEqual(fn, "giro_authority_attach_or_move_v1");
      assert.strictEqual(args.p_giro_id, "mg_260525_1");
      assert.strictEqual(args.p_order_uid, orderUid("#C"));
      return { ok: true, code: "OK", giro_id: "mg_260525_1", order_uid: orderUid("#C"), moved_from: null };
    };
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#C");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.moved_from, null);
    assert.strictEqual(observedRpcCalls.filter((c) => c.fn === "giro_authority_attach_or_move_v1").length, 1);
  });

  await t("addOrderToManualGiro: missing args rejected locally, no RPC", async () => {
    rpcHandler = () => { throw new Error("must not call the Authority"); };
    const r1 = await mg.addOrderToManualGiro(null, "#A");
    assert.strictEqual(r1.error, "missing_args");
    const r2 = await mg.addOrderToManualGiro("g", null);
    assert.strictEqual(r2.error, "missing_args");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("addOrderToManualGiro: order not found resolved locally, no RPC", async () => {
    rpcHandler = () => { throw new Error("must not call the Authority"); };
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#GHOST");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "order_not_found");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("addOrderToManualGiro: Authority GIRO_NOT_PLANNED (dissolved/departed) mapped to a 409, not a false success", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = () => ({ ok: false, code: "GIRO_NOT_PLANNED", state_reason: "BELOW_MIN_MEMBERS" });
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#A");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.error, "giro_not_planned");
  });

  await t("addOrderToManualGiro: same giro -> IDEMPOTENT -> no_op", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = () => ({ ok: true, code: "IDEMPOTENT", giro_id: "mg_260525_1" });
    const res = await mg.addOrderToManualGiro("mg_260525_1", "#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.no_op, true);
  });

  await t("addOrderToManualGiro: move (other giro -> target) -> ONE RPC reports moved_from, no JS branching/second call", async () => {
    seedOrder({ id: "#A" });
    let calls = 0;
    rpcHandler = (fn) => {
      calls++;
      assert.strictEqual(fn, "giro_authority_attach_or_move_v1");
      return { ok: true, code: "OK", giro_id: "mg_260525_2", order_uid: orderUid("#A"), moved_from: "mg_260525_1" };
    };
    const res = await mg.addOrderToManualGiro("mg_260525_2", "#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.moved_from, "mg_260525_1");
    assert.strictEqual(calls, 1, "the Authority decides unattached/same-target/other-giro internally -- one call");
  });

  // ── removeOrderFromManualGiro (W5: sbRpc giro_authority_detach_v1) ─

  await t("removeOrderFromManualGiro: order not found resolved locally, no RPC", async () => {
    rpcHandler = () => { throw new Error("must not call the Authority"); };
    const res = await mg.removeOrderFromManualGiro("#GHOST");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "order_not_found");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("removeOrderFromManualGiro: not a member -> IDEMPOTENT -> no_op", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = (fn, args) => {
      assert.strictEqual(fn, "giro_authority_detach_v1");
      assert.strictEqual(args.p_order_uid, orderUid("#A"));
      return { ok: true, code: "IDEMPOTENT", reason: "NOT_A_MEMBER" };
    };
    const res = await mg.removeOrderFromManualGiro("#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.no_op, true);
    assert.strictEqual(res.auto_dissolved, false);
  });

  await t("removeOrderFromManualGiro: detaches, giro stays PLANNED -> auto_dissolved false", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = () => ({ ok: true, code: "OK", giro_id: "mg_260525_1", giro_state_after: "PLANNED" });
    const res = await mg.removeOrderFromManualGiro("#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.auto_dissolved, false);
  });

  await t("removeOrderFromManualGiro: detach drops below threshold -> giro_state_after DISSOLVED -> auto_dissolved true", async () => {
    seedOrder({ id: "#A" });
    rpcHandler = () => ({ ok: true, code: "OK", giro_id: "mg_260525_1", giro_state_after: "DISSOLVED" });
    const res = await mg.removeOrderFromManualGiro("#A");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.auto_dissolved, true);
    assert.strictEqual(observedRpcCalls.length, 1, "one detach RPC -- the Authority derives below-threshold dissolution itself");
  });

  // ── dissolveManualGiro (W5: sbRpc giro_authority_dissolve_v1) ────

  await t("dissolveManualGiro: happy path -> exactly one dissolve RPC", async () => {
    rpcHandler = (fn, args) => {
      assert.strictEqual(fn, "giro_authority_dissolve_v1");
      assert.strictEqual(args.p_giro_id, "mg_260525_1");
      return { ok: true, code: "OK", giro_id: "mg_260525_1" };
    };
    const res = await mg.dissolveManualGiro("mg_260525_1");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(observedRpcCalls.filter((c) => c.fn === "giro_authority_dissolve_v1").length, 1);
  });

  await t("dissolveManualGiro: missing id -> 400, no RPC", async () => {
    rpcHandler = () => { throw new Error("must not call the Authority"); };
    const res = await mg.dissolveManualGiro(null);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "missing_giro_id");
    assert.strictEqual(observedRpcCalls.length, 0);
  });

  await t("dissolveManualGiro: Authority GIRO_NOT_FOUND -> disclosed, safety-motivated 404 (legacy always silently succeeded here)", async () => {
    rpcHandler = () => ({ ok: false, code: "GIRO_NOT_FOUND" });
    const res = await mg.dissolveManualGiro("mg_ghost");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.error, "giro_not_found_or_dissolved");
  });

  await t("dissolveManualGiro: already dissolved -> IDEMPOTENT -> still ok:true", async () => {
    rpcHandler = () => ({ ok: true, code: "IDEMPOTENT", giro_id: "mg_260525_1" });
    const res = await mg.dissolveManualGiro("mg_260525_1");
    assert.strictEqual(res.ok, true);
  });

  // ── autoDissolveIfBelowThreshold / countActiveMembers ─────────────
  // Byte-identical to pre-W5-Packet-01 -- unreachable from the writers above
  // language-guard: allow-legacy agentOrdini.js/cambiaStato are the existing file/function names being cited, not new vocabulary
  // now, kept solely because agentOrdini.js's cambiaStato() still imports and
  // calls autoDissolveIfBelowThreshold directly. Original raw-DB fake-DB
  // harness, unchanged.

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
  // Unchanged since Packet 02B — see tests/manualGiroReads.test.js.

  // ── softDissolveActiveManualGirosForClose ─────────────────────
  // Byte-identical; confirmed zero live callers anywhere (see manualGiros.js's
  // own header) — kept and tested only as a dormant, still-correct artifact.

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
