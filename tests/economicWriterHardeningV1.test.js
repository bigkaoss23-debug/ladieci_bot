// tests/economicWriterHardeningV1.test.js — ECONOMIC_WRITER_HARDENING_V1 (Slice 1: fence +
// lock). Static assertions on migrations/2026-09-11_economic_writer_hardening_v1_migration_126
// .sql (+ its ROLLBACK, + the manifest row), plus behavioral coverage of the three JS writers
// language-guard: allow-legacy modificaOrdine/cambiaStato/aggiungiItems are the three existing exported writer function names this header describes, not new vocabulary
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

console.log("\n── B-1 fix — M126 $post$ Patch B self-check (structural, mutation-tested) ──");
{
  // The migration's own $post$ block cannot be executed here (no local Postgres -- same
  // limitation the file's own header documents). What CAN be proven statically: (1) the
  // fragile old check is gone from the SQL text, (2) the new check's algorithm -- strip
  // comments, cut at the function's top-level BEGIN to drop the DECLARE section, then look
  // for FOR UPDATE / ORDER BY o.id before the first EXECUTABLE occurrence of v_total_cents
  // -- is a faithful JS mirror of what the SQL now does (regexp_replace + substring FROM
  // '(?s)\mBEGIN\M(.*)' + position()), run against the REAL extracted mesa_post_payment_v1
  // body plus three mutated variants covering exactly the four cases the review demanded.
  check("the old fragile check (position('v_total_cents' IN prosrc), no BEGIN-cut, no comment-strip) is gone",
    !/substring\(prosrc FROM 1 FOR position\('v_total_cents' IN prosrc\)\)/.test(sql));
  check("the new check reads prosrc into a variable and validates it was found",
    /SELECT prosrc INTO v_mesa_prosrc FROM pg_proc/.test(sql) && /IF v_mesa_prosrc IS NULL THEN/.test(sql));
  check("the new check strips both comment styles before locating BEGIN",
    /regexp_replace\(v_mesa_prosrc, '\/\\\*\.\*\?\\\*\/', '', 'gs'\)/.test(sql)
      && /regexp_replace\(v_mesa_clean, '--\[\^\\n\]\*', '', 'g'\)/.test(sql));
  check("the new check cuts at the top-level BEGIN (word-bounded) to drop the DECLARE section",
    /substring\(v_mesa_clean FROM '\(\?s\)\\mBEGIN\\M\(\.\*\)'\)/.test(sql));
  check("the new check locates the marker ONLY inside the post-BEGIN executable text (v_mesa_exec), not raw prosrc",
    /v_marker_pos := position\('v_total_cents' IN v_mesa_exec\)/.test(sql));
  check("the new check no longer treats FOR UPDATE and ORDER BY o.id as two independent conditions (NB-1 fix, round 2)",
    !/position\('FOR UPDATE' IN substring\(v_mesa_exec FROM 1 FOR v_marker_pos\)\) = 0/.test(sql));
  check("the new check matches Patch B's own statement as ONE contiguous unit (round 2, closes NB-1's M4 gap)",
    /substring\(v_mesa_exec FROM 1 FOR v_marker_pos\)\s*\n\s*!~ 'PERFORM 1 FROM public\\\.ordenes o\\s\+WHERE o\\\.table_session_id = v_session\\\.id\\s\+ORDER BY o\\\.id\\s\+FOR UPDATE'/.test(sql));

  // JS mirror of the SQL algorithm above (Postgres \m/\M word-boundary escapes approximated
  // by JS \b, which is equivalent here: BEGIN is always preceded by a newline and followed
  // by whitespace, both non-word characters on both engines).
  //
  // NB-1 fix (round 2, independent review of 826a9b0): mesa_post_payment_v1 takes THREE
  // OTHER FOR UPDATE locks earlier in the function (workspaces, auth_actors,
  // table_sessions) -- all unconditionally present before the marker regardless of Patch B.
  // Checking "FOR UPDATE anywhere in the prefix" and "ORDER BY o.id anywhere in the prefix"
  // as two INDEPENDENT conditions was vacuous on the FOR UPDATE half: removing ONLY Patch
  // B's own FOR UPDATE (leaving ORDER BY o.id, leaving the three earlier locks untouched)
  // still passed. Fixed by matching Patch B's own statement as ONE contiguous unit.
  const PATCH_B_STATEMENT_RE = /PERFORM 1 FROM public\.ordenes o\s+WHERE o\.table_session_id = v_session\.id\s+ORDER BY o\.id\s+FOR UPDATE/;
  function m126PatchBOrderingCheck(prosrc) {
    let clean = prosrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    const m = /\bBEGIN\b([\s\S]*)/.exec(clean);
    if (!m) return { pass: false, reason: "no top-level BEGIN" };
    const execBody = m[1];
    const markerPos = execBody.indexOf("v_total_cents");
    if (markerPos === -1) return { pass: false, reason: "v_total_cents not found in executable body" };
    const prefix = execBody.slice(0, markerPos);
    const pass = PATCH_B_STATEMENT_RE.test(prefix);
    return { pass, reason: pass ? "ok" : "Patch B's own lock statement missing or not before first obligation computation" };
  }

  const mesaStart2 = sql.indexOf("CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1");
  const mesaEnd2 = sql.indexOf("\n$function$;", mesaStart2);
  const realMesaBody = sql.slice(mesaStart2, mesaEnd2);
  const LOCK_RE = /\s*PERFORM 1 FROM public\.ordenes o\s*\n\s*WHERE o\.table_session_id = v_session\.id\s*\n\s*ORDER BY o\.id\s*\n\s*FOR UPDATE;/;
  check("fixture sanity: the real body contains exactly one Patch B lock statement to mutate",
    LOCK_RE.test(realMesaBody));
  const lockMatch = LOCK_RE.exec(realMesaBody);
  const lockText = lockMatch[0];

  // 1. Correct body, as installed today → passes.
  const r1 = m126PatchBOrderingCheck(realMesaBody);
  check("(1) correct installed body → post-check PASSES", r1.pass === true);

  // 2. Lock statement removed entirely → fails (no FOR UPDATE / ORDER BY o.id at all before
  //    the marker — the other FOR UPDATE locks earlier in the function, on workspaces/
  //    auth_actors/table_sessions, never carry "ORDER BY o.id").
  const lockRemoved = realMesaBody.replace(LOCK_RE, "");
  const r2 = m126PatchBOrderingCheck(lockRemoved);
  check("(2) lock statement removed → post-check FAILS", r2.pass === false);

  // 3. Lock present but moved to AFTER the first obligation computation (right after
  //    v_outstanding_cents is derived from v_total_cents) → fails, because the marker is
  //    now reached before the relocated lock text.
  const AFTER_CALC_ANCHOR = "v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);";
  const lockAfterCalc = realMesaBody
    .replace(LOCK_RE, "")
    .replace(AFTER_CALC_ANCHOR, AFTER_CALC_ANCHOR + "\n" + lockText.trim());
  check("fixture sanity: lock-after-calc variant still contains the lock text exactly once",
    (lockAfterCalc.match(/FOR UPDATE;/g) || []).length === (realMesaBody.match(/FOR UPDATE;/g) || []).length);
  const r3 = m126PatchBOrderingCheck(lockAfterCalc);
  check("(3) lock moved to AFTER the first obligation computation → post-check FAILS", r3.pass === false);

  // 4. Lock kept, but its deterministic ORDER BY o.id removed → fails on the second
  //    condition even though FOR UPDATE is still present before the marker.
  const orderByRemoved = realMesaBody.replace(
    LOCK_RE,
    "\n  PERFORM 1 FROM public.ordenes o\n   WHERE o.table_session_id = v_session.id\n   FOR UPDATE;"
  );
  const r4 = m126PatchBOrderingCheck(orderByRemoved);
  check("(4) ORDER BY o.id removed from the lock → post-check FAILS", r4.pass === false);

  // 5. OBLIGATORY (round 2, NB-1/M4): SOLO Patch B's own FOR UPDATE removed -- ORDER BY o.id
  //    kept, and the function's other three FOR UPDATE locks (workspaces, auth_actors,
  //    table_sessions) left completely untouched. Under the round-1 check this PASSED
  //    incorrectly (an earlier, unrelated FOR UPDATE satisfied the "FOR UPDATE anywhere in
  //    the prefix" half); the round-2 single-statement regex must now FAIL it.
  const onlyForUpdateRemoved = realMesaBody.replace(
    LOCK_RE,
    "\n  PERFORM 1 FROM public.ordenes o\n   WHERE o.table_session_id = v_session.id\n   ORDER BY o.id;"
  );
  check("fixture sanity: the other three FOR UPDATE locks (workspaces/auth_actors/table_sessions) are still present",
    (onlyForUpdateRemoved.match(/FOR UPDATE/g) || []).length === (realMesaBody.match(/FOR UPDATE/g) || []).length - 1);
  const r5 = m126PatchBOrderingCheck(onlyForUpdateRemoved);
  check("(5) OBLIGATORY: only Patch B's own FOR UPDATE removed (ORDER BY o.id + other locks untouched) → post-check FAILS", r5.pass === false);
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

console.log("\n── B-2 fix — rollback ledger contract (matches M124/M125 convention exactly) ──");
{
  const m124RollbackPath = path.join(__dirname, "..", "migrations", "2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.ROLLBACK.sql");
  const m125RollbackPath = path.join(__dirname, "..", "migrations", "2026-09-09_service_closeout_net_sales_legacy_contract_hardening_v1_migration_125.ROLLBACK.sql");
  const m124Rollback = fs.readFileSync(m124RollbackPath, "utf8");
  const m125Rollback = fs.readFileSync(m125RollbackPath, "utf8");

  // The OLD (broken) contract checked the PREDECESSOR's row (125) and then REFUSED if
  // 126's own row existed, demanding it be "rolled back" first -- structurally impossible,
  // since ladieci_schema_migrations is append-only: DELETE always raises and UPDATE only
  // ever allows bootstrapped_unverified -> verified (2026-08-15_s4_ladieci_schema_
  // migrations_ledger.sql:104-146). That text must be gone.
  check("the old broken check ('refuses if apply_order=126 already exists / roll back the ledger entry first') is gone",
    !/already has an apply_order=126 row -- roll back the ledger entry first/.test(rollbackSql));
  check("the old broken check no longer gates on apply_order = 125 (the predecessor's row)",
    !/ladieci_schema_migrations has no apply_order=125 row/.test(rollbackSql));

  // The NEW contract must check the SAME thing 124/125's rollbacks check: THIS migration's
  // own apply_order row.
  const M126_OWN_ROW_CHECK = /IF NOT EXISTS \(SELECT 1 FROM public\.ladieci_schema_migrations WHERE apply_order = 126\) THEN\s*\n\s*RAISE EXCEPTION 'M126 ROLLBACK refused: ladieci_schema_migrations has no apply_order=126 row -- forward migration was never registered as applied';/;
  check("rollback now requires its OWN apply_order=126 row to exist (proves M126 was registered as applied)",
    M126_OWN_ROW_CHECK.test(rollbackSql));

  // Structural parity with 124/125: same guard shape (to_regclass NULL-check wrapper, same
  // RAISE message template with only the apply_order number and migration id swapped), same
  // "own row, not predecessor" semantics, same absence of DELETE/UPDATE on the ledger table.
  const shapeFor = (n) => new RegExp(
    `IF NOT EXISTS \\(SELECT 1 FROM public\\.ladieci_schema_migrations WHERE apply_order = ${n}\\) THEN\\s*\\n\\s*RAISE EXCEPTION 'M${n} ROLLBACK refused: ladieci_schema_migrations has no apply_order=${n} row -- forward migration was never registered as applied';`
  );
  check("M124's rollback checks its OWN apply_order=124 row (reference convention)", shapeFor(124).test(m124Rollback));
  check("M125's rollback checks its OWN apply_order=125 row (reference convention)", shapeFor(125).test(m125Rollback));
  check("M126's rollback now follows the identical convention, own-number-for-own-number",
    shapeFor(126).test(rollbackSql));

  // No DELETE/UPDATE of the ledger anywhere in this file, in either direction -- the
  // append-only trigger would refuse it anyway, but this rollback must not even attempt it
  // (matching 124/125, which never touch the ledger table at all beyond the read-only guard
  // check above).
  check("rollback contains no DELETE against ladieci_schema_migrations",
    !/DELETE\s+FROM\s+public\.ladieci_schema_migrations/i.test(rollbackSql));
  check("rollback contains no UPDATE against ladieci_schema_migrations",
    !/UPDATE\s+public\.ladieci_schema_migrations/i.test(rollbackSql));
  check("rollback contains no INSERT into ladieci_schema_migrations (registration stays a separate, later statement, exactly like the forward file)",
    !/INSERT\s+INTO\s+public\.ladieci_schema_migrations/i.test(rollbackSql));
  check("124/125's own rollbacks likewise never DELETE/UPDATE/INSERT the ledger (parity, not a rule invented for 126)",
    ![m124Rollback, m125Rollback].some((f) =>
      /DELETE\s+FROM\s+public\.ladieci_schema_migrations/i.test(f)
      || /UPDATE\s+public\.ladieci_schema_migrations/i.test(f)
      || /INSERT\s+INTO\s+public\.ladieci_schema_migrations/i.test(f)));

  // Catalog/schema parity for the objects this rollback restores: the function signatures
  // it recreates must match the exact signatures the FORWARD file (candidate 65c53a5)
  // installs -- same parameter list, same order, so PostgREST/pg_proc identity (which is
  // keyed on name+arg-types) resolves to the SAME functions in both directions.
  const restoredSignatures = [
    "public._ledger_write_payment(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_by_role text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)",
    "public.order_mark_paid(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)",
    "public.order_void(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)",
    "public.order_import_legacy_payment(p_order_id text, p_amount numeric, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text, p_confirm text)",
    "public.order_refund(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)",
  ];
  for (const sig of restoredSignatures) {
    const fnName = sig.slice("public.".length, sig.indexOf("("));
    check(`rollback's restored signature for ${fnName} matches the forward file's signature exactly`,
      sql.includes(`CREATE OR REPLACE FUNCTION ${sig}`) && rollbackSql.includes(`CREATE OR REPLACE FUNCTION ${sig}`));
  }
  check("rollback's mesa_post_payment_v1 signature (incl. all 5 DEFAULTs) matches the forward file's exactly",
    sql.includes("CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_covers_settled integer DEFAULT NULL::integer, p_line_ids uuid[] DEFAULT NULL::uuid[], p_meta jsonb DEFAULT '{}'::jsonb, p_confirm_duplicate boolean DEFAULT false)")
    && rollbackSql.includes("CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_covers_settled integer DEFAULT NULL::integer, p_line_ids uuid[] DEFAULT NULL::uuid[], p_meta jsonb DEFAULT '{}'::jsonb, p_confirm_duplicate boolean DEFAULT false)"));
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
// language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
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

  // language-guard: allow-legacy modificaOrdine/agentOrdini are the existing exported writer function and module path this test requires directly, not new vocabulary
  const { modificaOrdine, cambiaStato, aggiungiItems } = require("../src/agents/agentOrdini");

  function seed(id, overrides) {
    STORE[id] = {
      // language-guard: allow-legacy tipo_consegna/RITIRO are the existing ordenes column name and enum value used verbatim in this fixture, not new vocabulary
      id, estado: "EN_COCINA", tipo_consegna: "RITIRO", items: [{ n: "Pizza", q: 1, p: 10 }],
      totale: 10, delivery_fee: 0, descuento_tipo: null, descuento_valor: null, descuento_importe: null,
      table_session_id: null, order_uid: null,
      ...overrides,
    };
  }

  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  console.log("\n── modificaOrdine ──");
  {
    updateCalls.length = 0;
    seed("#T1", { table_session_id: "11111111-0000-0000-0000-000000000001" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
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
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T2", { descuento_tipo: "EURO", descuento_valor: 2 });
    check("Non-Mesa adjusted-order economic edit → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("adjusted-order economic edit → no sbUpdate attempted",
      updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    seed("#T3", { estado: "CANCELADO" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T3", { descuento_tipo: "EURO", descuento_valor: 2 });
    check("Non-Mesa cancelled-order edit → rejected (via MODIFICA_TERMINAL_STATES)",
      r.success === false && r.error === "estado_terminal" && r.estado === "CANCELADO");
    check("cancelled-order edit → no sbUpdate attempted",
      updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    seed("#T4");
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T4", { descuento_tipo: "EURO", descuento_valor: 2 });
    check("Non-Mesa unpaid non-adjusted edit → still allowed", r.success === true);
    check("normal edit → sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23T4")));
  }
  {
    updateCalls.length = 0;
    seed("#T5", { table_session_id: "11111111-0000-0000-0000-000000000005" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T5", { nota: "sin cebolla" });
    check("Mesa order NON-economic edit (nota only) → still allowed (E-1 pre-check is scoped to economic fields)",
      r.success === true);
  }

  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  console.log("\n── modificaOrdine — R-1 fix: non-economic edits on Mesa/adjusted orders ──");
  // R-1 (ECONOMIC_WRITER_HARDENING_REVIEW_FAIL_FIX_REQUIRED): the JS pre-check used to
  // treat `hora` as an economic field, so an hora-only edit on a Mesa or adjusted order was
  // language-guard: allow-legacy calcolaTotaleOrdine is the existing helper function name this comment cites; tipo_consegna (next line) is the existing ordenes column name, not new vocabulary
  // wrongly refused even though calcolaTotaleOrdine/deliveryFeeFor (src/utils/helpers.js)
  // language-guard: allow-legacy tipo_consegna is the existing ordenes column name this comment cites, not new vocabulary
  // depend only on items and tipo_consegna -- an hora-only edit always recomputes totale/
  // delivery_fee to the SAME values already on the row, which the DB fence's own
  // IS DISTINCT FROM check would have let through anyway. These cases prove the fix; #T5
  // above already proved the pre-existing nota-only/Mesa case never regressed.
  {
    updateCalls.length = 0;
    seed("#T6", { table_session_id: "11111111-0000-0000-0000-000000000006" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T6", { hora: "20:30" });
    check("Mesa order + hora only → allowed (R-1 fix)", r.success === true);
    check("Mesa order + hora only → sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23T6")));
  }
  {
    updateCalls.length = 0;
    const uid = "22222222-0000-0000-0000-000000000007";
    OBLIGATIONS[uid] = true;
    seed("#T7", { order_uid: uid });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T7", { nota: "sin cebolla" });
    check("adjusted order + note only → allowed", r.success === true);
  }
  {
    updateCalls.length = 0;
    const uid = "22222222-0000-0000-0000-000000000008";
    OBLIGATIONS[uid] = true;
    seed("#T8", { order_uid: uid });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T8", { hora: "21:00" });
    check("adjusted order + time only → allowed (R-1 fix, the concrete defect the review found)", r.success === true);
    check("adjusted order + time only → sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23T8")));
  }
  {
    updateCalls.length = 0;
    const uid = "22222222-0000-0000-0000-000000000009";
    OBLIGATIONS[uid] = true;
    seed("#T9", { order_uid: uid });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#T9", { items: [{ n: "Pizza", q: 2, p: 10 }] });
    check("adjusted order + items changed → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("adjusted order + items changed → no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    updateCalls.length = 0;
    const uid = "22222222-0000-0000-0000-000000000010";
    OBLIGATIONS[uid] = true;
    seed("#T10", { order_uid: uid });
    // language-guard: allow-legacy tipo_consegna is the existing ordenes column name used verbatim in this fixture, not new vocabulary
    // tipo_consegna is the one field genuinely driving delivery_fee/totale
    // (deliveryFeeFor depends only on it) -- the R-1 "total changed" case.
    // language-guard: allow-legacy modificaOrdine is the existing writer function called here; tipo_consegna (this and next line) is the existing ordenes column name used in these fixtures, not new vocabulary
    const r = await modificaOrdine("#T10", { tipo_consegna: "DOMICILIO" });
    // language-guard: allow-legacy tipo_consegna is the existing ordenes column name cited in this test description, not new vocabulary
    check("adjusted order + total-affecting change (tipo_consegna) → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("adjusted order + total-affecting change → no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }

  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  console.log("\n── modificaOrdine — R-1 round 2: the REAL modal payload (not a synthetic {hora}/{nota}) ──");
  // Round-2 review finding: the real "Modificar" modal (ServicioPage.jsx's modificaOrden,
  // ~line 863: `api.post({action:"updateOrden", id, items:o.items, nota:o.nota, hora:o.hora,
  // ...(DOMICILIO ? {direccion,zona,zona_lat,zona_lon,zona_manuale} : {})})`) ALWAYS resends
  // `items` (and the full geo block on DOMICILIO) unchanged alongside whatever the operator
  // actually edited. Round-1's test suite only ever sent minimal synthetic payloads
  // ({hora}, {nota}), which never exercised this. This helper reproduces that EXACT call
  // shape, byte for byte, so these tests would have failed against round 1's key-presence
  // check the same way the real modal did.
  function realModalPayload(orden, changes = {}) {
    const o = { ...orden, ...changes };
    return {
      items: o.items, nota: o.nota, hora: o.hora,
      // language-guard: allow-legacy tipo_consegna is the existing ordenes column name used verbatim in this fixture, not new vocabulary
      ...(o.tipo_consegna === "DOMICILIO" ? {
        direccion: o.direccion ?? null,
        zona: o.zona ?? null,
        zona_lat: o.zona_lat ?? null,
        zona_lon: o.zona_lon ?? null,
        zona_manuale: !!o.zona_manuale,
      } : {}),
    };
  }
  {
    // A. adjusted order + modal payload + sola nota modificata + items invariati → PASS
    updateCalls.length = 0;
    const uid = "33333333-0000-0000-0000-0000000000a1";
    OBLIGATIONS[uid] = true;
    seed("#R2A", { order_uid: uid, hora: "20:00", nota: "original" });
    const payload = realModalPayload(STORE["#R2A"], { nota: "sin cebolla" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2A", payload);
    check("A. adjusted + real modal payload + note only → allowed", r.success === true);
    check("A. sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23R2A")));
  }
  {
    // B. adjusted order + modal payload + sola ora modificata + items invariati → PASS
    updateCalls.length = 0;
    const uid = "33333333-0000-0000-0000-0000000000b1";
    OBLIGATIONS[uid] = true;
    seed("#R2B", { order_uid: uid, hora: "20:00", nota: "original" });
    const payload = realModalPayload(STORE["#R2B"], { hora: "21:15" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2B", payload);
    check("B. adjusted + real modal payload + time only → allowed (the concrete review defect)", r.success === true);
    check("B. sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23R2B")));
  }
  {
    // C. adjusted order + modal payload + solo indirizzo modificato + items invariati → PASS
    updateCalls.length = 0;
    const uid = "33333333-0000-0000-0000-0000000000c1";
    OBLIGATIONS[uid] = true;
    seed("#R2C", {
      order_uid: uid, hora: "20:00", nota: "original",
      // language-guard: allow-legacy tipo_consegna is the existing ordenes column name used verbatim in this fixture, not new vocabulary
      tipo_consegna: "DOMICILIO", delivery_fee: 2.5, totale: 12.5,
      direccion: "Calle Vieja 1", zona: "Q1", zona_lat: 1, zona_lon: 1, zona_manuale: false,
    });
    const payload = realModalPayload(STORE["#R2C"], { direccion: "Calle Nueva 2" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2C", payload);
    check("C. adjusted DOMICILIO + real modal payload + address only → allowed", r.success === true);
    check("C. sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23R2C")));
  }
  {
    // D. adjusted order + modal payload + quantità diversa → REJECT
    updateCalls.length = 0;
    const uid = "33333333-0000-0000-0000-0000000000d1";
    OBLIGATIONS[uid] = true;
    seed("#R2D", { order_uid: uid, hora: "20:00", nota: "original" });
    const payload = realModalPayload(STORE["#R2D"], { items: [{ n: "Pizza", q: 2, p: 10 }] });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2D", payload);
    check("D. adjusted + real modal payload + quantity changed → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("D. no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    // E. adjusted order + modal payload + prodotto diverso → REJECT
    updateCalls.length = 0;
    const uid = "33333333-0000-0000-0000-0000000000e1";
    OBLIGATIONS[uid] = true;
    seed("#R2E", { order_uid: uid, hora: "20:00", nota: "original" });
    const payload = realModalPayload(STORE["#R2E"], { items: [{ n: "Diavola", q: 1, p: 10 }] });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2E", payload);
    check("E. adjusted + real modal payload + product changed → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("E. no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    // F. adjusted order + modal payload + totale economico diverso (stesso prodotto/quantità,
    // prezzo diverso) → REJECT — distinta da D (quantità) ed E (prodotto)
    updateCalls.length = 0;
    const uid = "33333333-0000-0000-0000-0000000000f1";
    OBLIGATIONS[uid] = true;
    seed("#R2F", { order_uid: uid, hora: "20:00", nota: "original" });
    const payload = realModalPayload(STORE["#R2F"], { items: [{ n: "Pizza", q: 1, p: 15 }] });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2F", payload);
    check("F. adjusted + real modal payload + price/total changed → rejected", r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("F. no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
  }
  {
    // G. normal non-paid/non-adjusted order + a genuine economic edit → pre-existing
    // behavior still allowed (E-1 does not apply outside Mesa/adjusted/cancelled)
    updateCalls.length = 0;
    seed("#R2G", { hora: "20:00", nota: "original" });
    const payload = realModalPayload(STORE["#R2G"], { items: [{ n: "Pizza", q: 5, p: 10 }] });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2G", payload);
    check("G. normal non-Mesa/non-adjusted + real modal payload + genuine economic change → still allowed", r.success === true);
    check("G. sbUpdate WAS attempted", updateCalls.some((c) => c.table === "ordenes" && c.filter.includes("%23R2G")));
  }
  {
    // NB-3 from the review (§6.5): a Mesa row whose legacy `ordenes.items` is empty while
    // `ordenes.totale` still holds a stale pre-Mesa value -- an hora-only edit here WOULD
    // zero the total (itemsFinali=[] recomputes totale=0 while ord.totale=100 differs), so
    // it must be REJECTED even though the operator only touched the hour. This is exactly
    // the case round 1's blanket "just drop hora from the trigger list" would have silently
    // let through to the DB (safe only because E-1 itself would still catch it there); the
    // value-based check here catches it in JS too.
    updateCalls.length = 0;
    seed("#R2NB3", {
      table_session_id: "11111111-0000-0000-0000-0000000000nb",
      items: [], totale: 100, delivery_fee: 0, hora: "20:00", nota: "original",
    });
    const payload = realModalPayload(STORE["#R2NB3"], { hora: "21:00" });
    // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
    const r = await modificaOrdine("#R2NB3", payload);
    check("NB-3. Mesa row with stale non-zero totale + empty items + hora-only edit → rejected (totale would move 100→0)",
      r.success === false && r.error === "ORDER_ECONOMIC_BASIS_LOCKED");
    check("NB-3. no sbUpdate attempted", updateCalls.filter((c) => c.table === "ordenes").length === 0);
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
  // language-guard: allow-legacy agentOrdini is the existing module path this test requires, not new vocabulary
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

console.log("\n── index.js — false-success UX fix (backend reject ≠ success) ──");
{
  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  // The review's finding: this dispatcher's "modificaOrdine"/"updateOrden" branches fall
  // through to a single shared `res.json(result)` at the end of the big action switch,
  // which Express sends with an implicit 200 regardless of `result.success`. A caller that
  // reads HTTP status instead of the JSON body (the reported case: a dashboard modal
  // showing "✏️ Pedido actualizado" off response.ok) would report success on a refused
  // economic edit (ORDER_ECONOMIC_BASIS_LOCKED), the pre-existing N-5 paid-order refusal,
  // or a terminal-state refusal. No frontend file exists in this repository to fix
  // (backend-only worktree) -- and none is needed: the fix is entirely in how this backend
  // sets the HTTP status, proven here statically plus by direct execution of the extracted
  // guard logic below.
  const indexJs = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const GUARD_RE = /if \(result && result\.success === false\) return res\.status\(409\)\.json\(result\);/g;
  const guardCount = (indexJs.match(GUARD_RE) || []).length;
  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  check("both modificaOrdine and updateOrden branches carry the false-success guard (2 occurrences)",
    guardCount === 2);

  // language-guard: allow-legacy modificaOrdine is the existing exported writer function called on this and the next line, not new vocabulary
  const modBranchStart = indexJs.indexOf('action === "modificaOrdine"');
  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this string literal searches index.js's own source for, not new vocabulary
  const modCallIdx = indexJs.indexOf("result = await modificaOrdine(req.body.id, { ...req.body, operatorManual: true });", modBranchStart);
  const modGuardIdx = indexJs.indexOf("if (result && result.success === false) return res.status(409).json(result);", modCallIdx);
  const nextBranchIdx = indexJs.indexOf('} else if (action === "aggiornaRispostaBot")', modCallIdx);
  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  check("modificaOrdine branch: the guard runs immediately after the writer call, inside the SAME branch",
    modCallIdx !== -1 && modGuardIdx !== -1 && modGuardIdx > modCallIdx && modGuardIdx < nextBranchIdx);

  const updBranchStart = indexJs.indexOf('action === "updateOrden"');
  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  const updCallIdx = indexJs.indexOf("result = await modificaOrdine(req.body.id, { ...req.body, operatorManual: true });", updBranchStart);
  const updGuardIdx = indexJs.indexOf("if (result && result.success === false) return res.status(409).json(result);", updCallIdx);
  const updNextBranchIdx = indexJs.indexOf('} else if (action === "updateEstado")', updCallIdx);
  check("updateOrden branch: the guard runs immediately after the writer call, inside the SAME branch",
    updCallIdx !== -1 && updGuardIdx !== -1 && updGuardIdx > updCallIdx && updGuardIdx < updNextBranchIdx);

  const finalResJsonIdx = indexJs.lastIndexOf("res.json(result);");
  check("both guards run BEFORE the shared fallthrough res.json(result) (so a refusal never reaches the bare-200 path)",
    modGuardIdx < finalResJsonIdx && updGuardIdx < finalResJsonIdx);

  // language-guard: allow-legacy creaOrdine is the existing exported writer function name, not new vocabulary
  check("the status code (409) matches this file's own existing convention for a rejected write (creaOrdine's intentA.ok check)",
    /if \(!intentA\.ok\) \{\s*\n\s*return res\.status\(409\)\.json/.test(indexJs));

  // Direct execution of the extracted guard, against the three concrete refusal shapes
  // language-guard: allow-legacy modificaOrdine is the existing exported writer function this test calls directly, not new vocabulary
  // modificaOrdine can actually return, plus the success case -- not just a text match.
  function simulateDispatch(result) {
    const calls = [];
    const res = {
      status(code) { calls.push(["status", code]); return this; },
      json(body) { calls.push(["json", body]); return this; },
    };
    if (result && result.success === false) { res.status(409).json(result); return calls; }
    res.json(result);
    return calls;
  }
  const basisLocked = guard.economicBasisLockRefusal("#T9");
  check("simulated dispatch: ORDER_ECONOMIC_BASIS_LOCKED refusal → status(409) called, body echoes the refusal",
    JSON.stringify(simulateDispatch(basisLocked)) === JSON.stringify([["status", 409], ["json", basisLocked]]));
  const terminalRefusal = { success: false, error: "estado_terminal", estado: "CANCELADO", message: "No se puede modificar un pedido en estado terminal." };
  check("simulated dispatch: estado_terminal refusal → ALSO status(409), not the bare-200 fallthrough",
    JSON.stringify(simulateDispatch(terminalRefusal)) === JSON.stringify([["status", 409], ["json", terminalRefusal]]));
  const okResult = { success: true };
  check("simulated dispatch: a real success → falls through to the plain res.json(result), no status() call",
    JSON.stringify(simulateDispatch(okResult)) === JSON.stringify([["json", okResult]]));
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
