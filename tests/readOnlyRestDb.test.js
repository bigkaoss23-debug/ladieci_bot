// tests/readOnlyRestDb.test.js
// ===============================================================
// Read-only REST DB adapter — contract + safety.
// Run: node tests/readOnlyRestDb.test.js
//
// Boundary:
//   - select-only, sbSelect is the ONLY DB access, no write methods.
//   - allowlist tables (ordenes, manual_giros), PII fields blocked.
//   - the REST queryString from plannerSnapshot is forwarded UNCHANGED.
//   - no real DB: sbSelect is a recording stub.
// ===============================================================
"use strict";

const { createReadOnlyRestDb } = require("../src/core/delivery/readOnlyRestDb");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const section = (s) => console.log(`\n── ${s} ──`);

// Recording sbSelect stub. Never hits a real DB.
function makeSbSelect(rows = []) {
  const calls = [];
  const fn = async (table, query) => {
    calls.push({ table, query });
    return rows;
  };
  fn.calls = calls;
  return fn;
}

// Real-ish queryStrings emitted by plannerSnapshot.buildOrdersQuery / buildManualGirosQuery.
const ORDERS_QS =
  "select=id,tipo_consegna,estado,zona,hora,durata_andata_min,items,manual_giro_id," +
  "forzado,forzado_hora,promesa_precisa,created_at,forno_out,salida_driver_estimada," +
  "entrega_estimada,retraso_estimado_min,conflicto_driver" +
  "&created_at=gte.2026-06-07T00%3A00%3A00&created_at=lt.2026-06-08T00%3A00%3A00" +
  "&order=created_at.asc&limit=1000";
const GIROS_QS =
  "select=id,type,order_ids,route_order,block_start,manual_duration_min," +
  "created_by_operator,force,hora_ref" +
  "&dissolved_at=is.null&order=created_at.asc&limit=1000";

async function expectSafeError(fnPromise, codeRe) {
  try {
    await fnPromise();
    return { ok: false, reason: "did_not_throw" };
  } catch (e) {
    const code = String(e && (e.code || e.message) || "");
    const safe = e && e.safe === true;
    return { ok: codeRe.test(code) && safe, reason: `code=${code} safe=${safe}` };
  }
}

async function main() {
  // 1. only select exposed
  section("1 — surface: only select");
  {
    const db = createReadOnlyRestDb({ sbSelect: makeSbSelect() });
    const keys = Object.keys(db);
    check("exposes exactly one method: select", keys.length === 1 && keys[0] === "select", JSON.stringify(keys));
    check("no write methods", ["insert", "update", "upsert", "delete", "remove"].every((m) => typeof db[m] !== "function"));
    check("select is a function", typeof db.select === "function");
  }

  // 2. ordenes safe → queryString forwarded UNCHANGED
  section("2 — ordenes select forwards queryString unchanged");
  {
    const sb = makeSbSelect([{ id: "#1" }]);
    const db = createReadOnlyRestDb({ sbSelect: sb });
    const rows = await db.select("ordenes", ORDERS_QS);
    check("returns rows from sbSelect", Array.isArray(rows) && rows[0] && rows[0].id === "#1", JSON.stringify(rows));
    check("sbSelect called once", sb.calls.length === 1, JSON.stringify(sb.calls.length));
    check("table forwarded as-is", sb.calls[0].table === "ordenes");
    check("queryString forwarded UNCHANGED", sb.calls[0].query === ORDERS_QS, sb.calls[0].query);
  }

  // 3. manual_giros safe
  section("3 — manual_giros select forwards queryString");
  {
    const sb = makeSbSelect([{ id: "g1" }]);
    const db = createReadOnlyRestDb({ sbSelect: sb });
    const rows = await db.select("manual_giros", GIROS_QS);
    check("returns rows", Array.isArray(rows) && rows[0].id === "g1");
    check("queryString unchanged", sb.calls[0].query === GIROS_QS, sb.calls[0].query);
  }

  // 4. table not allowlisted blocked
  section("4 — non-allowlisted table blocked");
  {
    const sb = makeSbSelect();
    const db = createReadOnlyRestDb({ sbSelect: sb });
    const r = await expectSafeError(() => db.select("clientes", "select=id,nombre"), /table_not_allowed/);
    check("clientes blocked with safe error", r.ok, r.reason);
    check("sbSelect NOT called for blocked table", sb.calls.length === 0, JSON.stringify(sb.calls));
  }

  // 5. PII fields blocked
  section("5 — PII fields blocked");
  {
    for (const pii of ["nombre", "telefono", "direccion", "wa_id"]) {
      const sb = makeSbSelect();
      const db = createReadOnlyRestDb({ sbSelect: sb });
      const r = await expectSafeError(
        () => db.select("ordenes", `select=id,${pii}&order=created_at.asc`),
        /pii_field_blocked|field_not_allowed/,
      );
      check(`select with ${pii} blocked`, r.ok, r.reason);
      check(`sbSelect NOT called when ${pii} requested`, sb.calls.length === 0);
    }
  }

  // 6. missing select= handled safe + wildcard blocked
  section("6 — missing select= / wildcard blocked");
  {
    const sb = makeSbSelect();
    const db = createReadOnlyRestDb({ sbSelect: sb });
    const r1 = await expectSafeError(() => db.select("ordenes", "order=created_at.asc&limit=10"), /select_required/);
    check("missing select= blocked safe", r1.ok, r1.reason);
    const r2 = await expectSafeError(() => db.select("ordenes", "select=*&limit=10"), /select_wildcard_not_allowed/);
    check("wildcard select=* blocked safe", r2.ok, r2.reason);
    check("sbSelect never called on unsafe select", sb.calls.length === 0, JSON.stringify(sb.calls));
  }

  // 7. sbSelect throw → safe error, no leak
  section("7 — sbSelect failure becomes safe error");
  {
    const boom = async () => { throw new Error("connect ECONNREFUSED https://xxx.supabase.co key=SECRET"); };
    const db = createReadOnlyRestDb({ sbSelect: boom });
    const r = await expectSafeError(() => db.select("ordenes", ORDERS_QS), /db_select_failed/);
    check("sbSelect error wrapped safe", r.ok, r.reason);
    check("safe error does not leak secret/url", !/SECRET|supabase\.co|ECONNREFUSED/.test(r.reason), r.reason);
  }

  // 8. missing sbSelect → safe error
  section("8 — missing sbSelect dependency");
  {
    const db = createReadOnlyRestDb();
    const r = await expectSafeError(() => db.select("ordenes", ORDERS_QS), /sbselect_missing/);
    check("missing sbSelect safe error", r.ok, r.reason);
  }

  // 9. no real DB used → sbSelect is the ONLY db access (stub-only)
  section("9 — sbSelect is the only DB access");
  {
    const sb = makeSbSelect([]);
    const db = createReadOnlyRestDb({ sbSelect: sb });
    await db.select("ordenes", ORDERS_QS);
    await db.select("manual_giros", GIROS_QS);
    check("all access went through injected sbSelect", sb.calls.length === 2, JSON.stringify(sb.calls.length));
  }

  // 10. compatible with plannerSnapshot real query builders
  section("10 — compatible with plannerSnapshot queryStrings");
  {
    let buildOrdersQuery, buildManualGirosQuery;
    try {
      const mod = require("../src/core/delivery/plannerSnapshot");
      // builders are not exported; reconstruct via loadPlannerSnapshot path instead.
      buildOrdersQuery = mod.buildOrdersQuery;
      buildManualGirosQuery = mod.buildManualGirosQuery;
    } catch (_) { /* ignore */ }

    // Drive the REAL loadPlannerSnapshot with our adapter wrapping a stub sbSelect:
    // proves the queryStrings plannerSnapshot emits pass our allowlist/PII guard.
    const { loadPlannerSnapshot } = require("../src/core/delivery/plannerSnapshot");
    const sb = makeSbSelect([]);
    const db = createReadOnlyRestDb({ sbSelect: sb });
    let threw = null;
    try {
      await loadPlannerSnapshot({ db, date: "2026-06-07", now: "20:00", includePii: false });
    } catch (e) { threw = e; }
    check("loadPlannerSnapshot runs through adapter without safe-block", threw === null, threw && String(threw.code || threw.message));
    check("adapter issued reads for ordenes + manual_giros",
      sb.calls.some((c) => c.table === "ordenes") && sb.calls.some((c) => c.table === "manual_giros"),
      JSON.stringify(sb.calls.map((c) => c.table)));
    check("every forwarded query carried an explicit select=",
      sb.calls.every((c) => /(^|&)select=/.test(c.query)), JSON.stringify(sb.calls.map((c) => c.query)));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNEXPECTED ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
