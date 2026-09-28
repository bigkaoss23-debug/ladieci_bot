// tests/c8OrderCancelWFirstMigration.test.js — C8 LOCK-ORDER FIX, part B (migration 144): order_cancel_v1 TAKES THE WORKSPACE FIRST.
// Offline static guard of the migration pair. The behaviour (deterministic H3 / H4, sweeps of W_CANCEL / W_CANCEL_TABLE / W_CANCEL_TABLE_B, natural races D / D2 / D3,
// JSON parity, forward + rollback on a real catalogue) is certified on ephemeral PostgreSQL by
// ci/giro-authority-certification/harness/runC8LockOrderFix.js; this file proves what text can:
//   * the 144 body is the staging body (md5 d75624fd1393d7dbf94d2155e19626b7) with ONE marked block (byte equality after removing it);
//   * that block is a single workspace FOR UPDATE placed before the actor lock, and the lock order becomes W -> ACTOR -> [TABLE_SESSION] -> ORDER;
//   * the drift guard pins the staging md5 and the signature, fails closed and never overwrites a divergent body;
//   * owner / SECURITY / search_path / ACL are preserved by assertion (nothing is granted or revoked);
//   * the rollback re-issues the staging body VERBATIM and refuses over a body that is not the exact 144 body;
//   * 144 is a separate migration from 143 (no cross dependency), and the perimeter (141 / 142 / Fiscal Core) is untouched;
//   * the manifest registers 144 as authored locally and NOT applied, with the sha256 of both files.
// Run: node tests/c8OrderCancelWFirstMigration.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const FWD_REL = "migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql";
const RBK_REL = "migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.ROLLBACK.sql";
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const manifest = read("migrations/MIGRATION_MANIFEST.md");
const LIVE_MD5 = "d75624fd1393d7dbf94d2155e19626b7";
const SIG = "public.order_cancel_v1(text,text,text,text,text,text,jsonb)";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}
const code = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

// The complete CREATE statement, its head (up to and including "AS $function$") and its dollar-quoted body (= pg_proc.prosrc).
function statement(sql) {
  const i = sql.indexOf("CREATE OR REPLACE FUNCTION public.order_cancel_v1(");
  if (i < 0) return null;
  if (sql.indexOf("CREATE OR REPLACE FUNCTION public.order_cancel_v1(", i + 1) >= 0) throw new Error("more than one order_cancel_v1 statement");
  const open = /AS\s+\$function\$/.exec(sql.slice(i));
  const headEnd = i + open.index + open[0].length;
  const end = sql.indexOf("$function$", headEnd);
  return { head: sql.slice(i, headEnd), body: sql.slice(headEnd, end) };
}
// Removes the "-- 144:BEGIN w_first" ... "-- 144:END w_first" block (whole lines, markers included).
const stripBlock = (body) => body.replace(/^[ \t]*-- 144:BEGIN ([a-z_]+)\n[\s\S]*?^[ \t]*-- 144:END \1\n/gm, "");

const F = statement(fwd);
const R = statement(rbk);
const stripped = stripBlock(F.body);
const newMd5 = md5(F.body);
const blockMatch = /^[ \t]*-- 144:BEGIN w_first\n([\s\S]*?)^[ \t]*-- 144:END w_first\n/m.exec(F.body);

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist under migrations/ with number 144", fs.existsSync(path.join(ROOT, FWD_REL)) && fs.existsSync(path.join(ROOT, RBK_REL)));
check("144 is used by exactly this pair (a number is never reused) and is a SEPARATE migration from 143",
  fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /_migration_144\b/.test(f)).sort().join(",")
    === [FWD_REL, RBK_REL].map((f) => path.basename(f)).sort().join(",") && !/migration_143/.test(code(fwd) + code(rbk)));
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));

console.log("\n── the 144 body = the staging body + ONE marked block ──");
check("exactly one order_cancel_v1 statement in each file, a CREATE OR REPLACE with the exact 7-argument signature", !!F && !!R && F.head.includes("p_meta jsonb DEFAULT '{}'::jsonb)"));
check("exactly ONE marked block (BEGIN / END pair) in the 144 body", (F.body.match(/-- 144:BEGIN /g) || []).length === 1 && (F.body.match(/-- 144:END /g) || []).length === 1 && !!blockMatch);
check("removing the block yields the staging body byte for byte: md5 = d75624fd1393d7dbf94d2155e19626b7", md5(stripped) === LIVE_MD5, md5(stripped));
check("the rollback statement is the same text as the staging body (md5 d75624fd...), and its head (signature, language, search_path) equals the forward head",
  md5(R.body) === LIVE_MD5 && R.body === stripped && R.head === F.head);
check("the 144 body differs from the staging body only by the block (it is longer, and only by the block's own bytes)", F.body.length === stripped.length + F.body.match(/^[ \t]*-- 144:BEGIN[\s\S]*?-- 144:END w_first\n/m)[0].length);
const blockCode = code(blockMatch[1]);
check("the block is ONE guarded statement: IF v_workspace IS NOT NULL THEN PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE; END IF;",
  blockCode.replace(/\s+/g, " ").trim() === "IF v_workspace IS NOT NULL THEN PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE; END IF;", blockCode);

console.log("\n── lock order: W -> ACTOR -> [TABLE_SESSION] -> ORDER ──");
const at = (s) => F.body.indexOf(s);
const pPeek = at("SELECT * INTO v_peek FROM public.ordenes WHERE id = p_order_id;");
const pWs = at("SELECT oe.workspace_id INTO v_workspace FROM public.order_entities oe WHERE oe.order_uid = v_peek.order_uid;");
const pBlock = at("-- 144:BEGIN w_first");
const pWfu = at("PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;");
const pAct = at("SELECT * INTO v_actor FROM public.auth_actors");
const pTs = at("PERFORM 1 FROM public.table_sessions WHERE id = v_peek.table_session_id FOR UPDATE;");
const pOrd = at("SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;");
check("the workspace is known from the immutable order_entities row read with a plain SELECT (no lock) BEFORE the block; the block sits right before the actor lookup",
  pPeek > 0 && pWs > pPeek && pBlock > pWs && pWfu > pBlock && pAct > pWfu && F.body.slice(pBlock, pAct).split("\n").length < 14, JSON.stringify({ pPeek, pWs, pBlock, pWfu, pAct }));
check("the order of the locks in the body is W (FOR UPDATE) < ACTOR (FOR UPDATE) < TABLE_SESSION (FOR UPDATE) < ORDER (FOR UPDATE)", pWfu < pAct && pAct < pTs && pTs < pOrd, JSON.stringify({ pWfu, pAct, pTs, pOrd }));
check("the workspace is the ONLY lock added: FOR UPDATE occurrences 4 (staging: actor, table session, order = 3, + the workspace)",
  (code(stripped).match(/FOR UPDATE/g) || []).length === 3 && (code(F.body).match(/FOR UPDATE/g) || []).length === 4 && !/KEY SHARE|NOWAIT|SKIP LOCKED|pg_advisory/i.test(code(F.body)));
check("there is no workspace lock in the staging body (the defect the migration closes)", !/public\.workspaces/.test(stripped));

console.log("\n── behaviour preserved ──");
const errs = (b) => [...b.matchAll(/RAISE EXCEPTION '([A-Z_]+)'( USING ERRCODE='[0-9A-Z]+')?/g)].map((m) => m[1] + (m[2] || "")).join(",");
check("every typed error (ORDER_CANCEL_INVALID / _REASON_REQUIRED / _NOT_FOUND / _FORBIDDEN / _STATE_INVALID / ORDER_WITHOUT_STABLE_IDENTITY) and its SQLSTATE is unchanged", errs(F.body) === errs(stripped) && errs(stripped).includes("ORDER_CANCEL_FORBIDDEN"));
check("the authorization gate is byte-identical (actor active + role set admin/operator/owner/cashier/waiter/legacy_operator)",
  F.body.includes("IF NOT FOUND OR v_actor.active IS NOT TRUE\n     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')\n  THEN RAISE EXCEPTION 'ORDER_CANCEL_FORBIDDEN' USING ERRCODE='42501'; END IF;"));
check("the actor lookup is unchanged (still scoped to the order's workspace when known, still FOR UPDATE)",
  F.body.includes("SELECT * INTO v_actor FROM public.auth_actors\n   WHERE actor = p_by_actor AND (v_workspace IS NULL OR workspace_id = v_workspace) FOR UPDATE;"));
check("the cancel semantics are byte-identical after the block: idempotent replay, state gate, obligation adjustment, UPDATE ordenes, result JSON",
  stripped === F.body.replace(blockMatch[0], "") && /order_obligation_apply_adjustment_v1\(/.test(F.body) && /UPDATE public\.ordenes SET estado = v_target, cancelado_at = v_now WHERE id = v_ord\.id;/.test(F.body));
check("no capability is added: the function keeps its 7 arguments and default values (no new parameter, no new overload)", F.head === R.head && (fwd.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 1);

console.log("\n── drift guard (fail closed) ──");
const guard = fwd.slice(fwd.indexOf("DO $guard$"), fwd.indexOf("END $guard$"));
check("the guard requires the exact signature and a single overload of order_cancel_v1", guard.includes(`to_regprocedure('${SIG}')`) && /p\.proname = 'order_cancel_v1'\) <> 1/.test(guard));
check("the guard pins md5(prosrc) = d75624fd1393d7dbf94d2155e19626b7 and RAISES on any other body (never overwrites a divergent body)",
  guard.includes(`IS DISTINCT FROM '${LIVE_MD5}'`) && /RAISE EXCEPTION 'C8_CANCEL refused: order_cancel_v1 is not the pinned staging body/.test(guard));
check("the guard runs BEFORE the CREATE OR REPLACE", fwd.indexOf("DO $guard$") < fwd.indexOf("CREATE OR REPLACE FUNCTION public.order_cancel_v1("));
check("the guard verifies the callees / tables the function depends on exist", /order_obligation_apply_adjustment_v1\(uuid,numeric,text,text,text,text,text,text,numeric\)/.test(guard) && /order_canonical_obligation_v1\(uuid\)/.test(guard));
check("the post-condition pins the md5 of the 144 body actually in the file", fwd.includes(`IS DISTINCT FROM '${newMd5}'`), newMd5);
check("the rollback guard pins the same 144 md5 and its post-condition the staging md5",
  rbk.includes(`IS DISTINCT FROM '${newMd5}'`) && rbk.includes(`IS DISTINCT FROM '${LIVE_MD5}'`) && /rollback refused/.test(rbk));

console.log("\n── security posture preserved by assertion ──");
check("no GRANT / REVOKE / ALTER OWNER in either file (the posture is preserved, not re-issued)", !/\b(GRANT|REVOKE)\b|OWNER TO/i.test(code(fwd) + code(rbk)));
check("owner, prosecdef, proconfig (search_path), ACL, return type and argument list are captured before and asserted equal after (forward and rollback)",
  (/p\.prosecdef IS NOT DISTINCT FROM v_b\.prosecdef/.test(fwd) && /p\.proconfig IS NOT DISTINCT FROM v_b\.proconfig/.test(fwd) && /p\.proacl::text IS NOT DISTINCT FROM v_b\.acl/.test(fwd) && /pg_get_userbyid\(p\.proowner\) = v_b\.owner/.test(fwd))
  && (/p\.prosecdef IS NOT DISTINCT FROM v_b\.prosecdef/.test(rbk) && /p\.proconfig IS NOT DISTINCT FROM v_b\.proconfig/.test(rbk) && /p\.proacl::text IS NOT DISTINCT FROM v_b\.acl/.test(rbk) && /pg_get_userbyid\(p\.proowner\) = v_b\.owner/.test(rbk)));
check("EXECUTE stays service_role-only (anon / authenticated must not have it)", /has_function_privilege\('anon', v_oid, 'EXECUTE'\) OR has_function_privilege\('authenticated', v_oid, 'EXECUTE'\) OR NOT has_function_privilege\('service_role', v_oid, 'EXECUTE'\)/.test(fwd));
check("SECURITY INVOKER is not changed: the statement carries no SECURITY clause, exactly like the staging text", !/SECURITY/i.test(F.head));
check("the post-conditions prove every OTHER function of schema public is byte-identical (forward and rollback)", /c8144_fn_before/.test(fwd) && /c8144rb_fn_before/.test(rbk) && /other function\(s\) of schema public changed/.test(fwd));

console.log("\n── perimeter: nothing else is touched ──");
check("one function only: no trigger / table / column / index / constraint / data change (outside the function body)", !/CREATE\s+TRIGGER|DROP\s+TRIGGER|(CREATE|ALTER|DROP)\s+(UNIQUE\s+)?(TABLE|INDEX)|ADD\s+CONSTRAINT|INSERT\s+INTO\s+public\.|UPDATE\s+public\.|DELETE\s+FROM/i.test(code(fwd.replace(F.body, ""))));
check("no dependency on, or mention of, migration 141 / 142 / Fiscal Core / period checkpoint / Veri*Factu / business date in the CODE",
  !/period_checkpoint|business_date_of_v1|fiscal|verifactu|consolidat|migration[_ ]14[12]\b/i.test(code(fwd.replace(F.body, "")) + code(rbk.replace(R.body, ""))));

console.log("\n── manifest ──");
const row = (manifest.split("| 144 |")[1] || "").split("\n")[0];
check("the manifest registers migration 144 as authored locally and NOT applied (nothing deployed, nothing committed)", /\| 144 \| C8/.test(manifest) && /NOT APPLIED to staging/.test(row));
check("the manifest row carries the sha256 of the forward and of the rollback file", row.includes(sha256(fwd)) && row.includes(sha256(rbk)));
check("the manifest row records the staging drift pin d75624fd1393d7dbf94d2155e19626b7", row.includes(LIVE_MD5));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
