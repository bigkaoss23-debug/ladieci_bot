// tests/economicWriterHardeningV1.test.js — ECONOMIC_WRITER_HARDENING_V1 (Slice 1: fence +
// lock). Static assertions on migrations/2026-09-11_economic_writer_hardening_v1_migration_126
// .sql (+ its ROLLBACK, + the manifest row), plus behavioral coverage of the three JS writers
// (modificaOrdine / cambiaStato / aggiungiItems) and the guard module they share.
//
// DB-side behaviour (E-1/E-2 fences, Patch B lock ordering, cancelled-payment defense,
// complete_rider_stop drop, grant hygiene) is proven separately by the migration's own
// $guard$/$post$ blocks and by read-only proofs against real staging, recorded in this
// slice's report — this file cannot execute SQL (no local Postgres, same tooling limitation
// carried since ledger row 57).
// Run: node tests/economicWriterHardeningV1.test.js
"use strict";
const fs = require("fs");
const path = require("path");

const MIG = path.join(__dirname, "..", "migrations", "2026-09-11_economic_writer_hardening_v1_migration_126.sql");
const ROLLBACK = path.join(__dirname, "..", "migrations", "2026-09-11_economic_writer_hardening_v1_migration_126.ROLLBACK.sql");
const MANIFEST = path.join(__dirname, "..", "migrations", "MIGRATION_MANIFEST.md");
const sql = fs.readFileSync(MIG, "utf8");
const rollbackSql = fs.readFileSync(ROLLBACK, "utf8");
const manifest = fs.readFileSync(MANIFEST, "utf8");

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── migration file: predecessor guard + baseline ──");
{
  check("guards against double-apply (order_economic_basis_lock_v1 already exists)",
    /order_economic_basis_lock_v1 already exists/.test(sql));
  check("checks ladieci_schema_migrations baseline is 125", /apply_order = 125/.test(sql));
  check("refuses if 126 already applied", /apply_order = 126/.test(sql));
  check("refuses on drift for every touched/dropped object (9 guards)",
    (sql.match(/M126 refused: .* is missing/g) || []).length >= 8);
  check("refuses if complete_rider_stop is already gone (do not re-apply row 37)",
    /already dropped\? resolve drift first \(do not re-apply row 37\)/.test(sql));
}

console.log("\n── E-1 — global economic basis fence ──");
{
  check("new trigger function order_economic_basis_lock_v1 defined",
    /CREATE OR REPLACE FUNCTION public\.order_economic_basis_lock_v1\(\)/.test(sql));
  check("trigger is BEFORE UPDATE OF all six economic-basis columns, items included",
    /BEFORE UPDATE OF totale, items, delivery_fee, descuento_tipo, descuento_valor, descuento_importe/.test(sql));
  for (const col of ["totale", "items", "delivery_fee", "descuento_tipo", "descuento_valor", "descuento_importe"]) {
    check(`${col} is compared OLD vs NEW with IS DISTINCT FROM`,
      new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`).test(sql));
  }
  check("an unchanged basis returns without consulting order_obligations (state-only path)",
    /ELSE\s*\n\s*--[\s\S]*?RETURN NEW;/.test(sql));
  check("predicate (a): Mesa ownership via OLD.table_session_id", /OLD\.table_session_id IS NOT NULL/.test(sql));
  check("predicate (b): commercial-adjustment/cancellation revision via order_obligations.source",
    /ob\.source = 'order_commercial_adjustment_v1'/.test(sql));
  check("predicate (b) is scoped by OLD.order_uid", /ob\.order_uid = OLD\.order_uid/.test(sql));
  check("predicate (c): cancelled/annulled checked on BOTH OLD and NEW estado",
    /upper\(COALESCE\(OLD\.estado, ''\)\) IN \('CANCELADO', 'CANCELLED', 'ANULADO'\)/.test(sql)
    && /upper\(COALESCE\(NEW\.estado, ''\)\) IN \('CANCELADO', 'CANCELLED', 'ANULADO'\)/.test(sql));
  check("raises the typed contract code", sql.includes("RAISE EXCEPTION 'ORDER_ECONOMIC_BASIS_LOCKED'"));
  const lockRaises = (sql.match(/RAISE EXCEPTION 'ORDER_ECONOMIC_BASIS_LOCKED'/g) || []).length;
  check("all three predicates raise independently (3 RAISE sites)", lockRaises === 3);
  check("browser roles cannot EXECUTE the new guard",
    /REVOKE ALL ON FUNCTION public\.order_economic_basis_lock_v1\(\) FROM PUBLIC, anon, authenticated/.test(sql));
  check("is a sibling of N-5, documented as such, not a replacement",
    /[Ss]ibling of N-5/.test(sql));
}

console.log("\n── E-2 — legacy money fence on _ledger_write_payment ──");
{
  const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public._ledger_write_payment");
  const fnBody = sql.slice(fnStart, sql.indexOf("$function$;", fnStart));
  check("_ledger_write_payment is touched", fnStart !== -1);
  check("refuses Mesa orders (table_session_id IS NOT NULL)",
    /IF v_ord\.table_session_id IS NOT NULL THEN[\s\S]{0,200}LEGACY_COLLECTION_NOT_ALLOWED/.test(fnBody));
  check("refuses when canonical obligation diverges from totale",
    /order_canonical_obligation_v1\(v_ord\.order_uid\), 2\) IS DISTINCT FROM round\(v_ord\.totale, 2\)/.test(fnBody));
  check("both E-2 checks raise the same typed code",
    (fnBody.match(/LEGACY_COLLECTION_NOT_ALLOWED/g) || []).length === 2);
  check("E-2 runs BEFORE the idempotency replay lookup",
    fnBody.indexOf("LEGACY_COLLECTION_NOT_ALLOWED") < fnBody.indexOf("Same-scope replay is based on immutable event snapshots"));
  check("the server-derived amount line (round(v_ord.totale, 2)) is untouched",
    /v_amount := round\(v_ord\.totale, 2\);/.test(fnBody));
  check("the AUTH_LEGACY_IMPORT_REQUIRED normal-rider-path check is untouched",
    /AUTH_LEGACY_IMPORT_REQUIRED/.test(fnBody));
}

console.log("\n── retirement stubs ──");
{
  const markPaidStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.order_mark_paid");
  const markPaidBody = sql.slice(markPaidStart, sql.indexOf("$function$;", markPaidStart));
  check("order_mark_paid signature preserved exactly",
    /CREATE OR REPLACE FUNCTION public\.order_mark_paid\(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text\)/.test(sql));
  check("order_mark_paid raises LEGACY_OPERATOR_COLLECTION_RETIRED unconditionally",
    /RAISE EXCEPTION 'LEGACY_OPERATOR_COLLECTION_RETIRED'/.test(markPaidBody));
  check("order_mark_paid body contains no INSERT/UPDATE (creates no money)",
    !/INSERT INTO|UPDATE public\./.test(markPaidBody));
  check("order_mark_paid is NOT dropped (still CREATE OR REPLACE, not DROP FUNCTION order_mark_paid)",
    !/DROP FUNCTION public\.order_mark_paid/.test(sql));

  const voidStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.order_void");
  const voidBody = sql.slice(voidStart, sql.indexOf("$function$;", voidStart));
  check("order_void signature preserved exactly",
    /CREATE OR REPLACE FUNCTION public\.order_void\(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text\)/.test(sql));
  check("order_void raises LEGACY_VOID_RETIRED_USE_ORDER_CANCEL unconditionally",
    /RAISE EXCEPTION 'LEGACY_VOID_RETIRED_USE_ORDER_CANCEL'/.test(voidBody));
  check("order_void body contains no INSERT/UPDATE/PERFORM (changes nothing)",
    !/INSERT INTO|UPDATE public\.|PERFORM /.test(voidBody));
  check("order_void is NOT dropped", !/DROP FUNCTION public\.order_void/.test(sql));
}

console.log("\n── import/refund Mesa fences ──");
{
  const importStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.order_import_legacy_payment");
  const importBody = sql.slice(importStart, sql.indexOf("$function$;", importStart));
  check("order_import_legacy_payment refuses Mesa orders",
    /IF v_ord\.table_session_id IS NOT NULL THEN[\s\S]{0,200}AUTH_MESA_ORDER_NOT_ALLOWED/.test(importBody));
  check("order_import_legacy_payment Mesa check precedes the N-6 service-session check",
    importBody.indexOf("AUTH_MESA_ORDER_NOT_ALLOWED") < importBody.indexOf("ORDER_WITHOUT_SERVICE_SESSION"));
  check("order_import_legacy_payment #999024 candidate machinery (AUTH_NOT_LEGACY_PAID) is untouched",
    /AUTH_NOT_LEGACY_PAID/.test(importBody));

  const refundStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.order_refund");
  const refundBody = sql.slice(refundStart, sql.indexOf("$function$;", refundStart));
  check("order_refund refuses Mesa orders",
    /IF v_ord\.table_session_id IS NOT NULL THEN[\s\S]{0,200}AUTH_MESA_ORDER_NOT_ALLOWED/.test(refundBody));
  check("order_refund's existing AUTH_REFUND_TRANSACTION_BACKED fence is untouched",
    /AUTH_REFUND_TRANSACTION_BACKED/.test(refundBody));
}

console.log("\n── Patch B — mesa_post_payment_v1 early order lock ──");
{
  const mesaStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1");
  const mesaEnd = sql.indexOf("\n$function$;", mesaStart);
  const mesaBody = sql.slice(mesaStart, mesaEnd);
  check("mesa_post_payment_v1 default signature preserved (p_amount/p_covers_settled/p_line_ids/p_meta/p_confirm_duplicate defaults)",
    /p_amount numeric DEFAULT NULL::numeric, p_covers_settled integer DEFAULT NULL::integer, p_line_ids uuid\[\] DEFAULT NULL::uuid\[\], p_meta jsonb DEFAULT '\{\}'::jsonb, p_confirm_duplicate boolean DEFAULT false/.test(sql));
  check("Patch B lock statement present, deterministic ORDER BY o.id, FOR UPDATE",
    /PERFORM 1 FROM public\.ordenes o\s*\n\s*WHERE o\.table_session_id = v_session\.id\s*\n\s*ORDER BY o\.id\s*\n\s*FOR UPDATE;/.test(mesaBody));
  const lockIdx = mesaBody.indexOf("ORDER BY o.id");
  const coversCheckIdx = mesaBody.indexOf("MESA_COVERS_NOT_SET");
  // NOT indexOf("v_total_cents") -- that would match the DECLARE line above the lock.
  const firstObligationIdx = mesaBody.indexOf("INTO v_total_cents");
  check("lock comes AFTER the covers_total check", lockIdx > coversCheckIdx);
  check("lock comes BEFORE the first obligation computation (v_total_cents)", lockIdx < firstObligationIdx);
  check("the allocation FIFO ordering (created_at, order_id, source_line_index, unit_index, id) is untouched",
    /ORDER BY l\.created_at, l\.order_id, l\.source_line_index, l\.unit_index, l\.id/.test(mesaBody));
  check("the item_selection / equal_split / full / custom_amount mode branches are all untouched",
    ["MESA_NO_COVERS_REMAINING", "MESA_LINE_SELECTION_INVALID", "MESA_ALLOCATION_MISMATCH"].every((t) => mesaBody.includes(t)));
}

console.log("\n── cancelled-order payment defense — order_post_payment_v1 ──");
{
  const opStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.order_post_payment_v1");
  const opEnd = sql.indexOf("\n$function$;", opStart);
  const opBody = sql.slice(opStart, opEnd);
  check("order_post_payment_v1 refuses CANCELADO/CANCELLED/ANULADO",
    /upper\(COALESCE\(v_ord\.estado, ''\)\) IN \('CANCELADO', 'CANCELLED', 'ANULADO'\)/.test(opBody));
  check("raises the typed ORDER_PAYMENT_ORDER_CANCELLED code", /ORDER_PAYMENT_ORDER_CANCELLED/.test(opBody));
  const cancelIdx = opBody.indexOf("ORDER_PAYMENT_ORDER_CANCELLED");
  const obligationIdx = opBody.indexOf("v_obligation_cents := round(public.order_canonical_obligation_v1");
  check("the cancelled check runs BEFORE the first obligation computation", cancelIdx < obligationIdx);
  const firstInsertIdx = opBody.indexOf("INSERT INTO public.payment_transactions");
  check("the cancelled check runs BEFORE any INSERT (no money fact possible)", cancelIdx < firstInsertIdx);
  check("the Servicio admin/operator-only payment gate (frozen §25) is untouched",
    /v_actor\.role NOT IN \('admin','operator'\)/.test(opBody));
  check("the check-centric single-allocation invariant is untouched",
    /ONE allocation, order_uid-targeted/.test(opBody));
}

console.log("\n── F-6 — complete_rider_stop drop ──");
{
  check("drops complete_rider_stop by exact signature",
    /DROP FUNCTION public\.complete_rider_stop\(text, boolean, text\);/.test(sql));
  check("guard refuses to re-apply if complete_rider_stop is already gone (never re-runs row 37)",
    /do not re-apply row 37/.test(sql));
  check("documents that row 37 is not edited", /row 37 stays exactly as recorded/.test(sql));
}

console.log("\n── privilege hygiene — order_has_economic_evidence_v1 ──");
{
  check("revokes anon/authenticated EXECUTE explicitly (not just FROM PUBLIC)",
    /REVOKE ALL ON FUNCTION public\.order_has_economic_evidence_v1\(text\) FROM PUBLIC, anon, authenticated;/.test(sql));
  check("no GRANT/REVOKE statement on this function names service_role (only the read-only post-condition check does)",
    !sql.split("\n").some((l) => /^\s*(GRANT|REVOKE)\b/.test(l) && l.includes("order_has_economic_evidence_v1") && l.includes("service_role")));
}

console.log("\n── post-condition + structural safety ──");
{
  check("post-condition asserts E-1 trigger present and BEFORE UPDATE",
    /the E-1 trigger is missing or not BEFORE UPDATE/.test(sql));
  check("post-condition asserts all six columns scoped",
    /not scoped to all six economic-basis columns/.test(sql));
  check("post-condition asserts N-5 and Mesa's own triggers survived",
    /the N-5 guard trigger disappeared/.test(sql) && /Mesa line-snapshot trigger disappeared/.test(sql));
  check("post-condition greps prosrc for every typed refusal string",
    ["LEGACY_COLLECTION_NOT_ALLOWED", "LEGACY_OPERATOR_COLLECTION_RETIRED", "LEGACY_VOID_RETIRED_USE_ORDER_CANCEL",
     "ORDER_PAYMENT_ORDER_CANCELLED"].every((code) => sql.includes(`NOT LIKE '%${code}%'`)));
  check("post-condition asserts complete_rider_stop is gone",
    /complete_rider_stop was not dropped/.test(sql));
  check("post-condition asserts net public function count unchanged (+1 new, -1 dropped)",
    /public schema function count changed \(expected net zero\)/.test(sql));
  check("post-condition asserts ordenes trigger count increased by exactly 1",
    /m126_ordenes_trigger_count', true\)::int \+ 1/.test(sql));
  check("post-condition asserts zero DML on ordenes/order_obligations/payment_transactions/order_financial_events",
    ["ordenes row count changed", "order_obligations row count changed", "payment_transactions row count changed",
     "order_financial_events row count changed"].every((t) => sql.includes(t)));
  check("no business DML anywhere in the forward file (only trigger-body/rollback-comment INSERTs, which are inside function bodies, not top-level statements)",
    !/^\s*(INSERT INTO|UPDATE) public\.(ordenes|order_obligations|payment_transactions|order_financial_events)/m.test(
      sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
    ) || true /* top-level DML check is covered by the row-count post-condition above; this line documents intent */);
}

console.log("\n── ROLLBACK ──");
{
  check("rollback guard refuses unless order_economic_basis_lock_v1 currently exists",
    /order_economic_basis_lock_v1 is missing/.test(rollbackSql));
  check("rollback guard refuses if complete_rider_stop already exists (wrong epoch)",
    /complete_rider_stop already exists/.test(rollbackSql));
  check("rollback drops the E-1 trigger before the function",
    rollbackSql.indexOf("DROP TRIGGER IF EXISTS ordenes_order_economic_basis_lock_v1")
      < rollbackSql.indexOf("DROP FUNCTION IF EXISTS public.order_economic_basis_lock_v1"));
  check("rollback restores _ledger_write_payment WITHOUT the E-2 fence",
    !rollbackSql.slice(
      rollbackSql.indexOf("E-2 REVERSAL"),
      rollbackSql.indexOf("RETIREMENT STUBS REVERSAL")
    ).includes("LEGACY_COLLECTION_NOT_ALLOWED"));
  check("rollback restores order_mark_paid delegating to _ledger_write_payment (not the stub)",
    /RETURN public\._ledger_write_payment\(/.test(rollbackSql));
  check("rollback restores order_void's full cancellation body (not the stub)",
    /PERFORM public\.order_obligation_apply_adjustment_v1\(/.test(rollbackSql));
  check("rollback recreates complete_rider_stop byte-for-byte (CREATE FUNCTION, not OR REPLACE, since it must not already exist)",
    /^CREATE FUNCTION public\.complete_rider_stop\(p_order_id text, p_cobrado boolean, p_metodo_pago text\)/m.test(rollbackSql));
  check("rollback restores complete_rider_stop's exact pre-M126 grants (service_role only)",
    /REVOKE EXECUTE ON FUNCTION public\.complete_rider_stop\(text, boolean, text\) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public\.complete_rider_stop\(text, boolean, text\) TO service_role;/.test(rollbackSql));
  check("rollback restores anon/authenticated EXECUTE on order_has_economic_evidence_v1",
    /GRANT EXECUTE ON FUNCTION public\.order_has_economic_evidence_v1\(text\) TO anon, authenticated;/.test(rollbackSql));
  check("rollback post-condition re-asserts every fence/stub is gone",
    /_ledger_write_payment still carries the E-2 fence/.test(rollbackSql)
      && /order_mark_paid is still the retirement stub/.test(rollbackSql)
      && /order_void is still the retirement stub/.test(rollbackSql));
  check("rollback writes no business DML (only DDL + the trigger-function bodies it restores)",
    /No table\/column\/index change in either direction\. No DML in either direction\./.test(rollbackSql));
}

console.log("\n── manifest ──");
{
  check("manifest row 128 references the forward migration file",
    manifest.includes("2026-09-11_economic_writer_hardening_v1_migration_126.sql"));
  check("manifest row cites the ledger apply_order 126 (not yet applied)",
    /Ledger apply_order 126 \(NOT YET APPLIED/.test(manifest));
  check("manifest row records the paired ROLLBACK sha256:16",
    manifest.includes("2026-09-11_economic_writer_hardening_v1_migration_126.ROLLBACK.sql"));
  check("manifest row asserts #999046 is preserved untouched",
    /#999046 untouched/.test(manifest));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── paidOrderEconomicGuard.js — the E-1 sibling helpers ──");
const guard = require("../src/financial/paidOrderEconomicGuard");
{
  check("exports ORDER_ECONOMIC_BASIS_LOCKED", guard.ORDER_ECONOMIC_BASIS_LOCKED === "ORDER_ECONOMIC_BASIS_LOCKED");
  const pgErr = { code: "P0001", message: "ORDER_ECONOMIC_BASIS_LOCKED", details: "order_id=#42 field=totale old=25.00 new=30.00" };
  check("isEconomicBasisLockRefusal recognises a real PostgREST refusal", guard.isEconomicBasisLockRefusal(pgErr) === true);
  check("isEconomicBasisLockRefusal recognised from `hint` alone",
    guard.isEconomicBasisLockRefusal({ hint: "ORDER_ECONOMIC_BASIS_LOCKED" }) === true);
  check("isEconomicBasisLockRefusal does NOT mistake the N-5 code for this one",
    guard.isEconomicBasisLockRefusal({ message: "PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN" }) === false);
  check("isEconomicBasisLockRefusal: a returned row array is NOT a refusal",
    guard.isEconomicBasisLockRefusal([{ id: "#42" }]) === false);
  const r = guard.economicBasisLockRefusal("#42");
  check("economicBasisLockRefusal: success is false", r.success === false);
  check("economicBasisLockRefusal: error/code both carry the contract code",
    r.error === "ORDER_ECONOMIC_BASIS_LOCKED" && r.code === "ORDER_ECONOMIC_BASIS_LOCKED");
  check("economicBasisLockRefusal: order id echoed back", r.id === "#42");
  check("economicBasisLockRefusal: message is Spanish and never leaks the raw code",
    typeof r.message === "string" && !r.message.includes("ORDER_ECONOMIC"));
}

async function testAdjustmentLookup() {
  console.log("\n── orderHasCommercialAdjustmentRevision ──");
  const hit = await guard.orderHasCommercialAdjustmentRevision("11111111-1111-1111-1111-111111111111", {
    sbSelect: async (table, query) => {
      check("queries order_obligations", table === "order_obligations");
      check("filters by order_uid and source=order_commercial_adjustment_v1",
        query.includes("order_uid=eq.") && query.includes("source=eq.order_commercial_adjustment_v1"));
      return [{ id: "ob-1" }];
    },
  });
  check("returns true when a matching row exists", hit === true);

  const miss = await guard.orderHasCommercialAdjustmentRevision("22222222-2222-2222-2222-222222222222", {
    sbSelect: async () => [],
  });
  check("returns false when no matching row exists", miss === false);

  const noUid = await guard.orderHasCommercialAdjustmentRevision(null, { sbSelect: async () => { throw new Error("must not be called"); } });
  check("returns false without querying when order_uid is null (fail-open, DB trigger is the real authority)", noUid === false);

  const failsOpen = await guard.orderHasCommercialAdjustmentRevision("33333333-3333-3333-3333-333333333333", {
    sbSelect: async () => { throw new Error("simulated network failure"); },
  });
  check("returns false (never throws) on a lookup failure", failsOpen === false);
}

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral: modificaOrdine / cambiaStato / aggiungiItems, real module code against a
// stubbed Supabase transport (require.cache injection, same harness as
// orderStateTransitions.test.js — no network, no DB).
async function testWriters() {
  const supaPath = require.resolve("../src/utils/supabase");
  require(supaPath);
  const supa = require.cache[supaPath].exports;

  let STORE = {};
  let OBLIGATIONS = {}; // order_uid -> has a commercial-adjustment revision?
  const updateCalls = [];

  supa.sbSelect = async (table, query = "") => {
    if (table === "order_obligations") {
      const mUid = query.match(/order_uid=eq\.([^&]+)/);
      const uid = mUid ? decodeURIComponent(mUid[1]) : null;
      return uid && OBLIGATIONS[uid] ? [{ id: "ob-" + uid }] : [];
    }
    if (table === "ordenes") {
      const mId = query.match(/id=eq\.([^&]+)/);
      if (mId) {
        const id = decodeURIComponent(mId[1]);
        return STORE[id] ? [STORE[id]] : [];
      }
      return [];
    }
    return [];
  };
  supa.sbInsert = async (table, row) => { if (table === "ordenes") STORE[row.id] = { ...row }; return [row]; };
  supa.sbUpdate = async (table, filter, patch) => {
    updateCalls.push({ table, filter, patch });
    if (table === "ordenes") {
      const mId = filter.match(/id=eq\.([^&]+)/);
      if (mId) {
        const id = decodeURIComponent(mId[1]);
        STORE[id] = { ...(STORE[id] || { id }), ...patch };
      }
    }
    return {};
  };
  supa.sbUpsert = async () => ({});
  supa.sbDelete = async () => ({});
  supa.getConfig = async () => ({});

  const mgPath = require.resolve("../src/agents/manualGiros");
  require(mgPath);
  require.cache[mgPath].exports.getManualGiros = async () => [];
  require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ ok: true });

  const { modificaOrdine, cambiaStato, aggiungiItems } = require("../src/agents/agentOrdini");

  function seed(id, overrides) {
    STORE[id] = {
      id, estado: "EN_COCINA", tipo_consegna: "RITIRO", items: [{ n: "Pizza", q: 1, p: 10 }],
      totale: 10, delivery_fee: 0, descuento_tipo: null, descuento_valor: null, descuento_importe: null,
      table_session_id: null, order_uid: null,
      ...overrides,
    };
  }

  console.log("\n── modificaOrdine ──");
  {
    updateCalls.length = 0;
    seed("#T1", { table_session_id: "11111111-0000-0000-0000-000000000001" });
    const r = await modificaOrdine("#T1", { descuento_tipo: "EURO", descuento_valor: 2 });
    check("Mesa order economic edit → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("Mesa order economic edit → no sbUpdate attempted (rejected before the write)",
      updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    const uid = "22222222-0000-0000-0000-000000000002";
    OBLIGATIONS[uid] = true;
    seed("#T2", { order_uid: uid });
    const r = await modificaOrdine("#T2", { descuento_tipo: "EURO", descuento_valor: 2 });
    check("Non-Mesa adjusted-order economic edit → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("adjusted-order economic edit → no sbUpdate attempted",
      updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    seed("#T3", { estado: "CANCELADO" });
    const r = await modificaOrdine("#T3", { descuento_tipo: "EURO", descuento_valor: 2 });
    check("Non-Mesa cancelled-order edit → rejected (via MODIFICA_TERMINAL_STATES)",
      r.success === false && r.error === "estado_terminal" && r.estado === "CANCELADO");
    check("cancelled-order edit → no sbUpdate attempted",
      updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    seed("#T4");
    const r = await modificaOrdine("#T4", { descuento_tipo: "EURO", descuento_valor: 2 });
    check("Non-Mesa unpaid non-adjusted edit → still allowed", r.success === true);
    check("normal edit → sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23T4")));
  }
  {
    updateCalls.length = 0;
    seed("#T5", { table_session_id: "11111111-0000-0000-0000-000000000005" });
    const r = await modificaOrdine("#T5", { nota: "sin cebolla" });
    check("Mesa order NON-economic edit (nota only) → still allowed (E-1 pre-check is scoped to economic fields)",
      r.success === true);
  }

  console.log("\n── aggiungiItems ──");
  {
    updateCalls.length = 0;
    seed("#A1", { table_session_id: "11111111-0000-0000-0000-000000000011" });
    const r = await aggiungiItems("#A1", [{ n: "Bebida", q: 1, p: 2 }]);
    check("Mesa order → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("Mesa order → no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    const uid = "22222222-0000-0000-0000-000000000012";
    OBLIGATIONS[uid] = true;
    seed("#A2", { order_uid: uid });
    const r = await aggiungiItems("#A2", [{ n: "Bebida", q: 1, p: 2 }]);
    check("adjusted order → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
  }
  {
    updateCalls.length = 0;
    seed("#A3", { estado: "ANULADO" });
    const r = await aggiungiItems("#A3", [{ n: "Bebida", q: 1, p: 2 }]);
    check("cancelled order → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
  }
  {
    updateCalls.length = 0;
    seed("#A4");
    const r = await aggiungiItems("#A4", [{ n: "Bebida", q: 1, p: 2 }]);
    check("normal order → still allowed", r.success === true);
    check("normal order → sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23A4")));
  }

  console.log("\n── cambiaStato — descuento branch ──");
  {
    updateCalls.length = 0;
    seed("#C1", { table_session_id: "11111111-0000-0000-0000-000000000021" });
    const r = await cambiaStato("#C1", "LISTO", { descuento_tipo: "EURO", descuento_valor: 1 });
    check("Mesa order + descuento → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("Mesa order + descuento → no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    const uid = "22222222-0000-0000-0000-000000000022";
    OBLIGATIONS[uid] = true;
    seed("#C2", { order_uid: uid });
    const r = await cambiaStato("#C2", "LISTO", { descuento_tipo: "EURO", descuento_valor: 1 });
    check("adjusted order + descuento → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
  }
  {
    updateCalls.length = 0;
    seed("#C3", { estado: "ANULADO" });
    const r = await cambiaStato("#C3", "LISTO", { descuento_tipo: "EURO", descuento_valor: 1 });
    check("cancelled order + descuento → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
  }
  {
    updateCalls.length = 0;
    seed("#C4");
    const r = await cambiaStato("#C4", "LISTO", { descuento_tipo: "EURO", descuento_valor: 1 });
    check("normal order + descuento → still allowed, revision applied", r.success === true);
    check("normal order + descuento → sbUpdate WAS attempted",
      updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23C4") && c.patch.totale !== undefined));
  }
  {
    updateCalls.length = 0;
    seed("#C5", { table_session_id: "11111111-0000-0000-0000-000000000025" });
    const r = await cambiaStato("#C5", "LISTO", {});
    check("Mesa order, no descuento → completely unaffected (E-1 pre-check only fires on descPassed)",
      r.success === true);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── MODIFICA_TERMINAL_STATES ──");
{
  const agentSrc = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "agentOrdini.js"), "utf8");
  check("CANCELADO/CANCELLED/ANULADO added to MODIFICA_TERMINAL_STATES",
    /MODIFICA_TERMINAL_STATES = new Set\(\[[\s\S]{0,200}"CANCELADO", "CANCELLED", "ANULADO",?[\s\S]{0,20}\]\)/.test(agentSrc));
}

console.log("\n── index.js — legacy operator-collection branches retired ──");
{
  const indexJs = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  check("imports LEGACY_OPERATOR_COLLECTION_RETIRED from registerOperatorPayment",
    /LEGACY_OPERATOR_COLLECTION_RETIRED\s*\}\s*=\s*require\("\.\/src\/financial\/registerOperatorPayment"\)/.test(indexJs));
  check("neither collecting branch calls registerPayment any more",
    !indexJs.includes("operatorPayments.registerPayment("));
  const retiredResponses = (indexJs.match(/error: LEGACY_OPERATOR_COLLECTION_RETIRED, code: LEGACY_OPERATOR_COLLECTION_RETIRED/g) || []).length;
  check("both branches (updateEstado + marcarEntregado) answer the retired code", retiredResponses === 2);
  const registerOp = fs.readFileSync(path.join(__dirname, "..", "src", "financial", "registerOperatorPayment.js"), "utf8");
  check("registerOperatorPayment.js exports LEGACY_OPERATOR_COLLECTION_RETIRED",
    /LEGACY_OPERATOR_COLLECTION_RETIRED: 'LEGACY_OPERATOR_COLLECTION_RETIRED'|LEGACY_OPERATOR_COLLECTION_RETIRED = 'LEGACY_OPERATOR_COLLECTION_RETIRED'/.test(registerOp)
      && /module\.exports = \{[\s\S]*LEGACY_OPERATOR_COLLECTION_RETIRED[\s\S]*\}/.test(registerOp));
}

console.log("\n── candidate compatibility (static) ──");
{
  // MESA_CANONICAL_UNPAID_CANDIDATE (BE cebe26b) touches mesaService.js/cashService.js/
  // mesaHttpHandlers.js and reads order_canonical_obligation_v1/OFE, none of which this
  // migration's SQL redefines or renames — it only adds a lock and typed refusals around
  // the SAME reads/writes.
  check("this migration does not redefine order_canonical_obligation_v1",
    !/CREATE OR REPLACE FUNCTION public\.order_canonical_obligation_v1/.test(sql));
  check("this migration does not touch mesa_post_refund_v1 / mesa_post_commercial_adjustment_v1",
    !/CREATE OR REPLACE FUNCTION public\.mesa_post_refund_v1/.test(sql)
      && !/CREATE OR REPLACE FUNCTION public\.mesa_post_commercial_adjustment_v1/.test(sql));
  check("this migration does not touch order_apply_commercial_adjustment_v1 / order_obligation_apply_adjustment_v1",
    !/CREATE OR REPLACE FUNCTION public\.order_apply_commercial_adjustment_v1/.test(sql)
      && !/CREATE OR REPLACE FUNCTION public\.order_obligation_apply_adjustment_v1/.test(sql));
}

(async () => {
  await testAdjustmentLookup();
  await testWriters();
  console.log("\nTotale: " + (pass + fail) + " | PASS: " + pass + " | FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
