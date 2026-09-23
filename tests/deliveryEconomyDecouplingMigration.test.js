"use strict";
// ===============================================================
// DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139) — offline static contract.
//
// The behaviour itself (the two races, the post-close rider flow with the REAL ledger, the operator confirmation,
// duplicate protection, lock order, apply/rollback/drift) is proven on REAL PostgreSQL by
//   ci/giro-authority-certification/harness/runDeliveryEconomyDecoupling.js
// which is not part of `node --test` (it needs an embedded/ephemeral server). This file is the always-on guard for
// what CAN be checked without a database:
//   * the new close body is the migration-138 body MINUS the active-trip refusal, and (after removing every marked
//     block) equals the ledger-132 predecessor byte for byte -- the dispatch lock L0 is kept;
//   * start_rider_trip_v2 (the SERVICE_NOT_OPEN half of the invariant) is NOT redefined, only pinned;
//   * the operator RPC takes L0 first, reuses the canonical Cash V1 writer, takes NO row lock of its own before it,
//     never touches a trip, DRIVER_STATO, delivery_logs or a service, and records the operator, never the rider;
//   * (correction B2, Option A) the OFF-SERVICE RECEIPT CONTRACT: payment_transactions.service_session_id is the RECEIPT
//     service and is NULL when no service was open, exactly like order_financial_events.event_service_session_id (the
//     same fact); the order's own service is never written there. order_post_payment_v1 -- the CANONICAL Cash V1 order
//     writer -- is the ledger-126 body (pinned to the live md5) with ONE marked block; the test re-derives the 139 body
//     from the migration-126 file and requires byte equality, so no other line of the writer can have moved. The only
//     schema change is the REPLACEMENT of payment_transactions_scope_chk by a strictly narrower, NULL-safe exception, plus
//     three comments; its pins, the writers inventory and the readers of the column are asserted here;
//   * the rollback restores the post-138 close body, the ledger-126 writer, the migration-122 constraint and the S2 / 122
//     column comments byte for byte, drops exactly the two new functions, and REFUSES while an off-service receipt exists.
// No database, no network.
// ===============================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const M = (f) => path.join(ROOT, "migrations", f);
const read = (p) => fs.readFileSync(p, "utf8");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const FWD_NAME = "2026-09-19_delivery_economy_decoupling_v1_migration_139.sql";
const RBK_NAME = "2026-09-19_delivery_economy_decoupling_v1_migration_139.ROLLBACK.sql";
const M138_NAME = "2026-09-19_active_trip_service_close_exclusion_v1_migration_138.sql";
const FWD = read(M(FWD_NAME));
const RBK = read(M(RBK_NAME));
const M138 = read(M(M138_NAME));

// md5(prosrc) as installed on staging at ledger tip 138 (read 2026-09-19).
const LIVE_138_CLOSE_MD5 = "3051158274094b46d668481b0dbdbdc5";
const LIVE_138_START_MD5 = "0323fbb1bab76a12fd2be3fed0b3187e";
const LEDGER_132_CLOSE_MD5 = "3caf2da77baabd6b5533879d101b2cc7";
// md5(prosrc) of order_post_payment_v1 as installed on staging at ledger 126 (read 2026-09-19).
const LIVE_126_OPV1_MD5 = "778cd30008632707e47a372e6afa5640";

function bodyOf(sql, name, tag) {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(i >= 0, `${name} is defined`);
  const open = `AS $${tag}$`;
  const j = sql.indexOf(open, i);
  const k = sql.indexOf(`$${tag}$;`, j + open.length);
  return sql.slice(j + open.length, k);
}
function createBody(sql, name, tag) {
  const i = sql.indexOf(`CREATE FUNCTION public.${name}(`);
  assert.ok(i >= 0, `${name} is created`);
  const open = `AS $${tag}$`;
  const j = sql.indexOf(open, i);
  const k = sql.indexOf(`$${tag}$;`, j + open.length);
  return sql.slice(j + open.length, k);
}
const CLOSE_138 = bodyOf(M138, "close_service_session_v3", "function");
const CLOSE_139 = bodyOf(FWD, "close_service_session_v3", "function");
const PRE_CLOSE = bodyOf(read(M("2026-09-15_w5_intent_activation_v1_migration_132.sql")), "close_service_session_v3", "function");
const M126 = read(M("2026-09-11_economic_writer_hardening_v1_migration_126.sql"));
const OPV1_126 = bodyOf(M126, "order_post_payment_v1", "function");
const OPV1_139 = bodyOf(FWD, "order_post_payment_v1", "function");
const OPERATOR = createBody(FWD, "operator_confirm_delivery_v1", "fn");
const RESIDUAL = createBody(FWD, "trip_residual_scope_v1", "fn");

const strip = (body, n) => body
  .replace(new RegExp(`^ {2}-- ${n}:BEGIN (\\w+)\\n[\\s\\S]*?^ {2}-- ${n}:END \\1\\n\\n`, "gm"), "")
  .replace(new RegExp(`^.*-- ${n}:DECL\\n`, "gm"), "");
// One pass over SQL text: a `--` comment vs a '...' literal, whichever starts first.
const noComments = (sql) => sql.replace(/--[^\n]*|'(?:[^']|'')*'/g, (m) => (m.startsWith("--") ? "" : m));

test("PINS: the 138 body is the live ledger-138 body; the 139 guard pins it and pins start_rider_trip_v2", () => {
  assert.equal(md5(CLOSE_138), LIVE_138_CLOSE_MD5);
  assert.ok(FWD.includes(`md5(v_src) IS DISTINCT FROM '${LIVE_138_CLOSE_MD5}'`), "forward guard pins the exact 138 close body");
  assert.ok(FWD.includes(`md5(v_src) IS DISTINCT FROM '${LIVE_138_START_MD5}'`), "forward guard pins the exact 138 start body");
  assert.ok(FWD.includes("public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)"), "the canonical writer's signature is a precondition");
  assert.match(FWD, /a 139 object already exists \(already applied\?\)/);
});

test("DERIVATION: strip(138 body) == strip(139 body) == the ledger-132 predecessor, byte for byte", () => {
  assert.equal(md5(PRE_CLOSE), LEDGER_132_CLOSE_MD5);
  assert.equal(strip(CLOSE_138, 138), PRE_CLOSE, "138 = 132 + marked blocks (the 138 proof, re-derived here)");
  assert.equal(strip(CLOSE_139, 139), PRE_CLOSE, "139 = 132 + marked blocks: nothing else changed");
  assert.equal(strip(CLOSE_139, 139), strip(CLOSE_138, 138));
  assert.ok(!/138:/.test(CLOSE_139), "no 138 marker survives in the 139 body");
  assert.notEqual(md5(CLOSE_139), md5(CLOSE_138));
});

test("THE INVARIANT: the close keeps L0 (lifecycle -> L0 -> first row lock) and NO LONGER reads or refuses on a trip", () => {
  const code = noComments(CLOSE_139);
  const l0 = "hashtext('LA_DIECI_DRIVER_STATO')";
  assert.equal(code.split(l0).length - 1, 1, "L0 exactly once");
  const lc = code.indexOf("hashtext('service_session_lifecycle')");
  assert.ok(lc >= 0 && code.indexOf(l0) > lc && code.indexOf("FOR UPDATE") > code.indexOf(l0), "lifecycle -> L0 -> first row lock");
  assert.doesNotMatch(code, /trip_projection_v1|V3_CLOSE_ACTIVE_RIDER_TRIP|V3_CLOSE_RIDER_TRIP_UNVERIFIABLE|v_trip|trip_authority/);
  // every pre-existing outcome is still there, in the same order
  const order = ["INVALID_ARGUMENTS", "SERVICE_SESSION_NOT_FOUND", "ALREADY_CLOSED", "SESSION_CLOSE_IDENTITY_MISMATCH", "INVALID_SESSION_STATUS",
    "CURRENT_SESSION_MISMATCH", "CLOSEOUT_NOT_FOUND", "ATTEMPT_NOT_ACTIVE", "BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH", "V3_CLOSED"];
  let at = -1;
  for (const c of order) { const p = code.indexOf(`'${c}'`); assert.ok(p > at, `${c} keeps its place`); at = p; }
  // the write set of the close is exactly the predecessor's
  const dml = (b) => [...noComments(b).matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([\w.]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(dml(CLOSE_139), dml(PRE_CLOSE));
});

test("THE OTHER HALF IS NOT TOUCHED: start_rider_trip_v2 and the rider/ledger functions are pinned, never redefined (order_post_payment_v1 is edited ONLY as B2 states)", () => {
  for (const fn of ["start_rider_trip_v2", "rider_collect_and_complete_stop", "close_rider_trip", "_ledger_write_payment", "trip_projection_v1", "trip_authority_close_active_trip_v1"]) {
    assert.doesNotMatch(FWD, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`), `${fn} is not (re)defined by 139`);
  }
  assert.ok(FWD.includes("start_rider_trip_v2 must be untouched"), "post-condition asserts the start body is unchanged");
  const created = [...FWD.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (public\.\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(created, ["public.close_service_session_v3", "public.operator_confirm_delivery_v1", "public.order_post_payment_v1", "public.trip_residual_scope_v1"]);
});

test("B2 -- THE CANONICAL ORDER WRITER: ledger-126 body (live md5) + ONE marked block, re-derived here byte for byte; both receipt columns take the SAME variable; no parallel writer, no service write", () => {
  assert.equal(md5(OPV1_126), LIVE_126_OPV1_MD5, "the migration-126 body IS the live ledger-126 body");
  assert.ok(FWD.includes(`md5(v_src) IS DISTINCT FROM '${LIVE_126_OPV1_MD5}'`), "the forward guard pins the predecessor body");
  // the ONLY edit: the 'no open service' refusal becomes an off-service receipt (typed refusal kept only when the ORDER has no service either)
  const EDIT1_OLD = `  IF v_receipt_service_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_NO_OPEN_SERVICE' USING ERRCODE='55000'; END IF;
`;
  assert.equal(OPV1_126.split(EDIT1_OLD).length, 2, "the edit has exactly one anchor in the 126 body");
  const blockMatch = OPV1_139.match(/  -- 139:BEGIN off_service_receipt\n[\s\S]*?  -- 139:END off_service_receipt\n/);
  assert.ok(blockMatch, "the marked 139 block exists");
  const derived = OPV1_126.replace(EDIT1_OLD, blockMatch[0]);
  assert.equal(OPV1_139, derived, "the 139 body == the 126 body with ONLY that one block (every other byte identical: BOTH INSERTs are the ledger-126 ones)");
  assert.ok(FWD.includes(`'${md5(OPV1_139)}'`), "the post-condition pins the exact 139 body");
  assert.ok(RBK.includes(`md5(v_src) IS DISTINCT FROM '${md5(OPV1_139)}'`), "the rollback guard pins the exact 139 body");
  // what the block does and does not do
  const block = blockMatch[0];
  assert.match(block, /v_meta := v_meta - 'off_service_receipt';\n\s+IF v_receipt_service_id IS NULL THEN\s+IF v_ord\.service_session_id IS NULL THEN\s+RAISE EXCEPTION 'ORDER_PAYMENT_NO_OPEN_SERVICE' USING ERRCODE='55000';/,
    "the caller's flag is discarded FIRST; the typed refusal is kept for the no-context case (an order with no service at all)");
  assert.match(block, /v_meta := v_meta \|\| jsonb_build_object\('off_service_receipt', true\)/, "the flag is set by the writer, as the boolean true");
  assert.match(block, /IF length\(v_meta::text\) > 2048 THEN\s+RAISE EXCEPTION 'ORDER_PAYMENT_INVALID'/, "adding the flag can never become a raw CHECK violation");
  const code = noComments(block);
  assert.doesNotMatch(code, /\b(INSERT INTO|UPDATE|DELETE FROM)\b/, "the block itself writes nothing");
  assert.doesNotMatch(code, /v_receipt_service_id\s*:=|COALESCE/, "v_receipt_service_id is never reassigned or defaulted: what was received where is decided by the service pointer alone");
  assert.doesNotMatch(noComments(OPV1_139), /(INSERT INTO|UPDATE) public\.service_sessions|service_session_state\s+SET/, "the writer never opens, reopens or moves a service");
  // THE CONTRACT: the transaction row and the event row take the SAME receipt variable; the order's own service is only the OBLIGATION column
  const codeAll = noComments(OPV1_139);
  assert.ok(codeAll.includes("p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,"), "payment_transactions.service_session_id = v_receipt_service_id, unchanged");
  assert.match(codeAll, /o\.service_session_id, v_receipt_service_id, v_tx\.id, v_now/, "order_financial_events: obligation = the order's service, event_service_session_id = v_receipt_service_id (the SAME variable)");
  assert.doesNotMatch(codeAll, /COALESCE\(v_receipt_service_id|v_ord\.service_session_id\s*,\s*'payment'|v_ord\.service_session_id\)?\s*,\s*'payment'/, "the order's own service is NEVER used as a receipt or as a scope anchor");
  // every pre-existing guard survives
  for (const lit of ["ORDER_PAYMENT_ALREADY_SETTLED", "ORDER_PAYMENT_POSSIBLE_DUPLICATE", "ORDER_PAYMENT_ORDER_CANCELLED", "ORDER_PAYMENT_IDEMPOTENCY_CONFLICT", "ORDER_PAYMENT_AMOUNT_INVALID", "ORDER_PAYMENT_FORBIDDEN"]) {
    assert.ok(OPV1_139.includes(lit), `${lit} survives`);
  }
  assert.equal(created126Count(), 1);
});
function created126Count() { return (M126.match(/CREATE OR REPLACE FUNCTION public\.order_post_payment_v1\(/g) || []).length; }

// The text of a COMMENT ON ... IS '...' statement (adjacent literals concatenated, '' unescaped) -- as PostgreSQL stores it.
function commentText(sql, target) {
  const i = sql.indexOf(`COMMENT ON ${target} IS`);
  assert.ok(i >= 0, `COMMENT ON ${target} exists`);
  const rest = sql.slice(i + `COMMENT ON ${target} IS`.length);
  const end = rest.indexOf(";\n");
  const literals = [...rest.slice(0, end + 1).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return literals.join("");
}
const M122_SQL = read(M("2026-09-07_check_centric_universal_cash_v1_migration_122.sql"));
const S2_SQL = read(M("2026-08-15_s2_attribution_writers_receipt_service.sql"));
const OLD_SCOPE_CHK = "CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))";
const NEW_SCOPE_CHK = "CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL) OR ((table_session_id IS NULL) AND (service_session_id IS NULL) AND (kind = 'payment'::text) AND (mode = ANY (ARRAY['full'::text, 'custom_amount'::text])) AND (covers_settled = 0) AND COALESCE(((meta -> 'off_service_receipt'::text) = 'true'::jsonb), false))))";
const sqlLit = (s) => `'${s.replace(/'/g, "''")}'`;

test("NO OTHER SCHEMA CHANGE, NO GRANT WIDENING: the ONLY DDL is the replacement of payment_transactions_scope_chk (+ 3 comments); only service_role may execute the new functions", () => {
  const code = noComments(FWD);
  assert.doesNotMatch(code.replace(/CREATE TEMP TABLE dec139(_pt)?_(before|after)[^;]*;/g, ""), /\b(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE TRIGGER|DROP TABLE|DROP FUNCTION|CREATE SCHEMA|DROP INDEX|DROP TRIGGER|ADD COLUMN|DROP COLUMN|ALTER COLUMN)\b/);
  assert.deepEqual([...code.matchAll(/\bALTER TABLE\s+([\w.]+)\s+(DROP CONSTRAINT|ADD CONSTRAINT)\s+(\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`),
    ["public.payment_transactions DROP CONSTRAINT payment_transactions_scope_chk", "public.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk"],
    "exactly ONE constraint is replaced, in place, under the same name");
  assert.equal([...code.matchAll(/\bALTER TABLE\b/g)].length, 2, "no other ALTER TABLE");
  assert.deepEqual([...code.matchAll(/\bCOMMENT ON (CONSTRAINT|COLUMN|FUNCTION)\s+([\w.]+)(?:\s+ON\s+([\w.]+))?/g)].map((m) => `${m[1]} ${m[2]}${m[3] ? " ON " + m[3] : ""}`).sort(),
    ["COLUMN public.payment_transactions.service_session_id", "COLUMN public.payment_transactions.table_session_id", "CONSTRAINT payment_transactions_scope_chk ON public.payment_transactions",
      "FUNCTION public.operator_confirm_delivery_v1", "FUNCTION public.trip_residual_scope_v1"].sort(),
    "the only comments: the scope constraint, the two scope columns, and the two new functions");
  assert.doesNotMatch(code, /GRANT\s+[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i);
  for (const sig of ["public.trip_residual_scope_v1()", "public.operator_confirm_delivery_v1(text, text, integer, jsonb)"]) {
    assert.ok(FWD.includes(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`), `${sig} revoked from PUBLIC/anon/authenticated`);
    assert.ok(FWD.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`), `${sig} granted to service_role only`);
  }
  assert.match(FWD, /trip_residual_scope_v1\(\)\s+RETURNS jsonb\s+LANGUAGE plpgsql STABLE SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/);
  assert.match(FWD, /operator_confirm_delivery_v1\([\s\S]*?LANGUAGE plpgsql\s+SET search_path TO 'public', 'pg_temp'/, "the operator RPC is SECURITY INVOKER like its rider sibling");
});

test("B2 -- payment_transactions_scope_chk: a strictly NARROWER, NULL-SAFE exception; the pins on both sides agree; the migration-122 definition it replaces is the one 122 itself asserted", () => {
  const add = FWD.match(/ADD CONSTRAINT payment_transactions_scope_chk CHECK \(([\s\S]*?)\n\);/);
  assert.ok(add, "the new constraint is added under the same name");
  const expr = add[1].replace(/\s+/g, " ").trim();
  // the first two disjuncts ARE the old rule, unchanged: every row that was valid is still valid
  assert.ok(expr.startsWith("table_session_id IS NOT NULL OR service_session_id IS NOT NULL OR ("), "the old rule is the first two disjuncts");
  // the exception: scope-less ONLY for a payment / full|custom_amount / covers 0 / flag exactly boolean true
  for (const part of ["table_session_id IS NULL", "service_session_id IS NULL", "kind = 'payment'", "mode IN ('full', 'custom_amount')", "covers_settled = 0",
    "COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false)"]) {
    assert.ok(expr.includes(part), `the exception requires: ${part}`);
  }
  // THE TRAP: a bare (meta ->> 'off_service_receipt') = 'true' is NULL when the key is missing, and a CHECK ACCEPTS NULL
  assert.doesNotMatch(noComments(FWD.replace(/COMMENT ON[\s\S]*?';\n/g, "")), /meta\s*->>\s*'off_service_receipt'/, "no text-comparison of the flag (NULL-unsafe) anywhere in the DDL or the writer");
  // the pins: forward post-condition + rollback guard hold the NEW definition; forward guard + rollback post-condition hold the OLD one
  assert.ok(FWD.includes(`IS DISTINCT FROM ${sqlLit(NEW_SCOPE_CHK)} THEN`), "forward post-condition pins the exact new definition");
  assert.ok(RBK.includes(`IS DISTINCT FROM ${sqlLit(NEW_SCOPE_CHK)} THEN`), "rollback guard pins the exact new definition");
  assert.ok(FWD.includes(`IS DISTINCT FROM ${sqlLit(OLD_SCOPE_CHK)} THEN`), "forward guard pins the exact old definition (drift => refuse)");
  assert.ok(RBK.includes(`IS DISTINCT FROM ${sqlLit(OLD_SCOPE_CHK)} THEN`), "rollback post-condition pins the exact old definition");
  // the old definition is exactly what migration 122 itself asserted at apply time
  assert.ok(M122_SQL.includes(`IS DISTINCT FROM 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))'`), "122's own post-condition == the definition 139 pins as the predecessor");
  // the rollback restores it under the same name, and only after proving that no scope-less row exists
  assert.match(RBK, /DROP CONSTRAINT payment_transactions_scope_chk;\s+ALTER TABLE public\.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk\s+CHECK \(table_session_id IS NOT NULL OR service_session_id IS NOT NULL\);/);
});

test("B2 -- COMMENTS: the column keeps its S2 meaning (RECEIPT SERVICE, NULL = off-service, never an anchor); the rollback restores the S2 / 122 texts VERBATIM; every pin is derived from the text", () => {
  const s2Old = commentText(S2_SQL, "COLUMN public.payment_transactions.service_session_id");
  const m122Old = commentText(M122_SQL, "COLUMN public.payment_transactions.table_session_id");
  const svcNew = commentText(FWD, "COLUMN public.payment_transactions.service_session_id");
  const tblNew = commentText(FWD, "COLUMN public.payment_transactions.table_session_id");
  const conNew = commentText(FWD, "CONSTRAINT payment_transactions_scope_chk ON public.payment_transactions");
  // the S2 contract survives, word for word, at the start of the new comment
  for (const must of ["RECEIPT SERVICE: the service session open at the moment the money was received.", "NULL = off-service receipt (no session open).", "NEVER the table's origin service"]) {
    assert.ok(svcNew.includes(must), `the new column comment keeps: ${must}`);
  }
  assert.ok(svcNew.startsWith(s2Old.slice(0, s2Old.indexOf(". Physical rename"))), "the S2 text (up to \"NEVER the table's origin service\") is the verbatim prefix of the new comment, which only EXTENDS its last sentence");
  assert.match(svcNew, /NEVER the order's own service: it is a receipt attribute, not a scope anchor/);
  assert.match(svcNew, /NULL here AND NULL in order_financial_events\.event_service_session_id -- the same fact/);
  assert.doesNotMatch(svcNew, /scope anchor (when|if)|is the order's own scope anchor/i, "no comment sustains the old anchoring");
  assert.match(tblNew, /except a check-centric payment received while no service was open/);
  assert.match(conNew, /Refunds, Mesa modes and unflagged rows can never be scope-less/);
  // md5 pins == md5 of the text actually stored by the COMMENT statements (forward post-condition AND rollback guard)
  for (const [txt, what] of [[conNew, "constraint"], [svcNew, "service_session_id"], [tblNew, "table_session_id"]]) {
    assert.ok(FWD.includes(`'${md5(txt)}'`), `forward post-condition pins the ${what} comment`);
    assert.ok(RBK.includes(`'${md5(txt)}'`), `rollback guard pins the ${what} comment`);
  }
  // the forward guard pins the OLD texts to exactly what S2 / 122 wrote; the rollback restores exactly those
  assert.ok(FWD.includes(sqlLit(s2Old)) && FWD.includes(sqlLit(m122Old)), "forward guard: the old comments are the S2 and migration-122 texts");
  assert.equal(commentText(RBK, "COLUMN public.payment_transactions.service_session_id"), s2Old, "rollback restores the S2 comment verbatim");
  assert.equal(commentText(RBK, "COLUMN public.payment_transactions.table_session_id"), m122Old, "rollback restores the migration-122 comment verbatim");
  assert.ok(RBK.includes(sqlLit(s2Old)) && RBK.includes(sqlLit(m122Old)), "rollback post-condition pins the same texts");
  assert.doesNotMatch(noComments(RBK), /COMMENT ON CONSTRAINT/, "the restored constraint carries no comment, as on staging at ledger 138");
});

test("B2 -- WRITERS of payment_transactions: the set is pinned (a new writer forces a conscious review); only the two check-centric writers can produce a row without table_session_id", () => {
  const strip = (s) => s.replace(/--[^\n]*|'(?:[^']|'')*'/g, (m) => (m.startsWith("--") ? "" : "''"));
  const found = new Map();
  for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => x.endsWith(".sql") && !/ROLLBACK/.test(x)).sort()) {
    const s = strip(read(M(f)));
    for (const m of s.matchAll(/INSERT\s+INTO\s+(?:public\.)?payment_transactions\b/gi)) {
      const fn = [...s.slice(0, m.index).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)].pop();
      const name = fn ? fn[1] : "(outside a function)";
      found.set(name, [...(found.get(name) || []), f.slice(0, 10)]);
    }
  }
  // language-guard: allow-legacy messa_post_payment_v1 is the pre-V3j spelling of mesa_post_payment_v1 (renamed by the V3j nomenclature cutover; not live), named here only to pin the writers inventory, not new vocabulary
  assert.deepEqual([...found.keys()].sort(), ["messa_post_payment_v1", "mesa_post_payment_v1", "mesa_post_refund_v1", "order_post_payment_v1", "order_post_refund_v1"].sort(), "the writers of payment_transactions");
  // the two Mesa writers always carry a table session; the check-centric REFUND is kind refund (never admitted scope-less)
  assert.match(OPV1_139, /INSERT INTO public\.payment_transactions\([\s\S]*?p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,/);
});

test("B2 -- READERS of payment_transactions.service_session_id: no JS reader of an order-centric transaction uses the column; Mesa reads are scoped by table_session_id (so a NULL receipt service can drop nothing)", () => {
  const cashDao = read(path.join(ROOT, "src", "cash", "cashDao.js"));
  const list = cashDao.slice(cashDao.indexOf("async function listCanonicalTransactions"), cashDao.indexOf("const postPayment"));
  assert.ok(/payment_allocations/.test(list), "the check reader reaches transactions through payment_allocations");
  assert.doesNotMatch(list.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"), /service_session_id/, "cashDao never selects the column of an order-centric transaction");
  const mesaDao = read(path.join(ROOT, "src", "tables", "mesaDao.js"));
  const reads = [...mesaDao.matchAll(/select\('payment_transactions',[\s\S]*?\)\s*,?\s*\]\)/g)].map((m) => m[0]);
  assert.equal(reads.length, 2, "the two Mesa reads of payment_transactions");
  for (const r of reads) assert.match(r, /\$\{(sessionFilter|scope)\}/, "each Mesa read is scoped by the table-session filter");
  assert.match(mesaDao, /const scope = `table_session_id=eq\./, "the closed-account scope is a table_session_id filter");
  // the SQL readers (live: exactly two functions; both treat a NULL receipt service as EVIDENCE, i.e. fail closed)
  const ecf2 = read(M("2026-08-25_ecf2_order_delete_economic_evidence_alignment.sql"));
  const n5 = read(M("2026-08-24_n5_paid_order_economic_mutation_guard.sql"));
  assert.ok(ecf2.includes("(o.service_session_id IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = o.service_session_id)"), "order_has_economic_evidence_v1: NULL receipt service = evidence");
  assert.ok(n5.includes("(v_session IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = v_session)"), "paid_order_economic_mutation_guard_v1: NULL receipt service = evidence");
});

test("B2 -- SECURITY: the off-service flag can NEVER come from a client -- the backend passes a fixed meta, the writer discards a caller value, only service_role can write the table", () => {
  const svc = read(path.join(ROOT, "src", "cash", "cashService.js"));
  const metas = [...svc.matchAll(/\bmeta:\s*(\{[^}]*\})/g)].map((m) => m[1].replace(/\s+/g, " "));
  assert.ok(metas.length >= 3, "cashService passes a meta to the writers");
  assert.ok(metas.every((m) => m === "{ source: 'servicio_dashboard' }"), `every meta the backend sends is the fixed literal (got ${JSON.stringify(metas)})`);
  for (const f of ["src/cash/cashService.js", "src/cash/cashHttpHandlers.js", "src/agents/operatorDelivery.js"]) {
    assert.doesNotMatch(read(path.join(ROOT, f)), /(req\.)?body\.meta|payload\.meta|args\.meta\s*\|\|\s*req/, `${f} never builds a meta from the request`);
  }
  // the operator RPC builds its own meta server-side and the writer strips the reserved key before it decides the flag
  assert.match(noComments(OPERATOR), /jsonb_build_object\('source', 'operator_delivery_confirmation'\)/);
  assert.match(OPV1_139, /v_meta := v_meta - 'off_service_receipt';/);
  // the only role that may write the table is service_role (staging ACL {postgres, service_role}); the migration grants nothing on it
  assert.doesNotMatch(noComments(FWD), /GRANT\s+[^;]*payment_transactions/i);
});

test("RESIDUAL SCOPE: attribution only -- no member, no rider identity, no service status", () => {
  const code = noComments(RESIDUAL);
  assert.match(code, /FROM trip_authority\.trips t\s+WHERE t\.status = 'ACTIVE'/);
  assert.doesNotMatch(code, /trip_members|rider_actor|dispatched_by|service_sessions|order_uid|estado/);
});

test("OPERATOR RPC: L0 first, canonical Cash V1 writer only, NO row lock before it, money-first, never a trip / DRIVER_STATO / delivery_logs / service", () => {
  const code = noComments(OPERATOR);
  const l0 = "hashtext('LA_DIECI_DRIVER_STATO')";
  assert.equal(code.split(l0).length - 1, 1, "L0 exactly once");
  assert.ok(code.indexOf(l0) < code.indexOf("FROM public.auth_actors"), "L0 before the actor read");
  assert.ok(code.indexOf(l0) < code.indexOf("FROM public.ordenes"), "L0 before the order read");
  // lock-order rule: this function takes NO row lock of its own (locking ordenes before the writer would invert Cash V1's order)
  assert.doesNotMatch(code, /\bFOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/);
  // money first: the writer call precedes the delivery UPDATE, which precedes the audit INSERT
  const pay = code.indexOf("public.order_post_payment_v1(");
  const upd = code.indexOf("UPDATE public.ordenes");
  const log = code.indexOf("INSERT INTO public.orden_estado_logs");
  assert.ok(pay > 0 && upd > pay && log > upd, "payment -> delivery UPDATE -> audit row");
  assert.doesNotMatch(code, /_ledger_write_payment|order_mark_paid|INSERT INTO public\.(order_financial_events|payment_transactions|payment_allocations)/, "no second money writer");
  // (the L0 literal itself contains the text DRIVER_STATO, so the DRIVER_STATO *config row* is excluded via public.config)
  assert.doesNotMatch(code, /trip_authority|close_rider_trip|start_rider_trip|public\.config|delivery_logs|service_sessions/, "never a trip / the DRIVER_STATO config row / delivery_logs / service");
  assert.doesNotMatch(code, /\b(DELETE FROM|TRUNCATE)\b/);
  // the only DML targets are the order row (guarded by the source state) and the audit table
  assert.deepEqual([...code.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([\w.]+)/g)].map((m) => `${m[1]} ${m[2]}`), ["UPDATE public.ordenes", "INSERT INTO public.orden_estado_logs"]);
  assert.match(code, /WHERE id = p_order_id AND estado = 'EN_ENTREGA'/, "the UPDATE is guarded by the source state");
  assert.match(code, /RAISE EXCEPTION 'OPERATOR_DELIVERY_LOST_RACE' USING ERRCODE = '40001'/, "lost race aborts the whole transaction (never RETURN)");
  // identity: only admin/operator; the rider is refused; recorded as the operator
  assert.match(code, /v_by\.role NOT IN \('admin', 'operator'\)/);
  assert.doesNotMatch(code, /'rider'/, "the operator RPC never mentions the rider role");
  assert.match(code, /'delivered', v_by\.role, p_by_actor,\s*'operator_delivery_confirmation'/, "audit: actor_type = the operator's role, actor_id = the operator");
  assert.match(code, /jsonb_build_object\('source', 'operator_delivery_confirmation'\)/, "server-forced payment provenance");
  // the one tolerated payment refusal is 'already settled'
  assert.match(code, /IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN\s+RETURN jsonb_build_object\('ok', false, 'code', 'PAYMENT_REFUSED'/);
  // the delivery columns are exactly the rider's (estado + hora_entrega); obligation / payment flags stay the ledger's
  assert.match(code, /SET estado\s+= 'RETIRADO',\s+hora_entrega = \(extract\(epoch FROM now\(\)\) \* 1000\)::bigint/);
  assert.doesNotMatch(code, /cobrado|ya_pagado|metodo_pago|totale|retirado_at/);
});

test("ROLLBACK: back to the EXACT post-138 state (not pre-138) + the ledger-126 order writer, drops exactly the two new functions, refuses to strand a trip", () => {
  const restored = bodyOf(RBK, "close_service_session_v3", "function");
  assert.equal(restored, CLOSE_138, "the restored close body is the 138 body, byte for byte");
  assert.equal(md5(restored), LIVE_138_CLOSE_MD5);
  assert.ok(RBK.includes(`md5(v_src) IS DISTINCT FROM '${md5(CLOSE_139)}'`), "rollback guard pins the exact 139 close body");
  assert.ok(RBK.includes(`md5(v_src) IS DISTINCT FROM '${LIVE_138_START_MD5}'`));
  assert.ok(RBK.includes(`'${LIVE_138_CLOSE_MD5}'`), "post-condition pins the restored 138 body");
  assert.ok(!RBK.includes(LEDGER_132_CLOSE_MD5), "it never targets the pre-138 (ledger-132) body");
  // B2: the canonical order writer goes back to the ledger-126 body, byte for byte
  assert.equal(bodyOf(RBK, "order_post_payment_v1", "function"), OPV1_126, "the restored order writer is the 126 body, byte for byte");
  assert.equal(md5(bodyOf(RBK, "order_post_payment_v1", "function")), LIVE_126_OPV1_MD5);
  assert.ok(RBK.includes(`'${LIVE_126_OPV1_MD5}'`), "post-condition pins the restored 126 writer");
  assert.deepEqual([...noComments(RBK).matchAll(/DROP FUNCTION (public\.[\w]+)/g)].map((m) => m[1]).sort(), ["public.operator_confirm_delivery_v1", "public.trip_residual_scope_v1"]);
  assert.match(RBK, /t\.status = 'ACTIVE' AND s\.status <> 'open'/, "refuses while an ACTIVE trip belongs to a service that is not open");
  assert.doesNotMatch(noComments(RBK), /\b(DELETE FROM|TRUNCATE|DROP TABLE)\b/);
  // B2: money facts are never rewritten -- the rollback REFUSES (typed, before touching anything) while an off-service receipt exists
  assert.match(RBK, /LOCK TABLE public\.payment_transactions IN SHARE ROW EXCLUSIVE MODE;\s+SELECT count\(\*\) INTO v_n FROM public\.payment_transactions WHERE table_session_id IS NULL AND service_session_id IS NULL;\s+IF v_n > 0 THEN\s+RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: % off-service payment receipt\(s\) exist/);
  assert.ok(RBK.indexOf("off-service payment receipt(s) exist") < RBK.indexOf("CREATE OR REPLACE FUNCTION public.close_service_session_v3"), "the refusal happens in the guard block, before any object is replaced");
  const topLevel = noComments(RBK).replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "$$body$$");   // outside every dollar-quoted body (function bodies, DO blocks)
  assert.doesNotMatch(topLevel, /UPDATE public\.payment_transactions|DELETE FROM public\.payment_transactions|INSERT INTO public\.payment_transactions/, "the rollback never rewrites a payment row (only the restored writer BODY mentions the table)");
});

test("ARTIFACTS: the harness that proves the behaviour exists and names this migration; the manifest records it as NOT APPLIED", () => {
  const h = (...p) => path.join(ROOT, "ci", "giro-authority-certification", ...p);
  for (const f of [h("harness", "runDeliveryEconomyDecoupling.js"), h("harness", "groups", "deliveryEconomyDecoupling.js"), h("harness", "groups", "b2OffServiceReceipt.js"), h("harness", "b2MutationCheck.js"), h("harness", "realLedger.js"), h("fixture", "real_ledger_v1.sql")]) {
    assert.ok(fs.existsSync(f), f);
  }
  assert.match(read(h("harness", "runDeliveryEconomyDecoupling.js")), /NEW_GROUPS = \['deliveryEconomyDecoupling', 'b2OffServiceReceipt'\]/, "the B2 receipt-contract group runs with the 139 certification");
  assert.match(read(h("harness", "runDeliveryEconomyDecoupling.js")), new RegExp(FWD_NAME.replace(/\./g, "\\.")));
  assert.match(FWD, /runDeliveryEconomyDecoupling\.js/);
  const manifest = read(M("MIGRATION_MANIFEST.md"));
  const row = manifest.split("\n").find((l) => /^\|\s*139\s*\|/.test(l));
  assert.ok(row, "manifest row 139 exists");
  assert.match(row, /NOT APPLIED to staging \(ledger tip stays 138\)/);
  assert.match(row, /PRODUCTION NOT TOUCHED/);
  assert.ok(row.includes(FWD_NAME) && row.includes(RBK_NAME));
  const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(M(f))).digest("hex");
  assert.ok(row.includes(sha(FWD_NAME)), "manifest records the sha256 of the forward file");
  assert.ok(row.includes(sha(RBK_NAME)), "manifest records the sha256 of the rollback file");
});
