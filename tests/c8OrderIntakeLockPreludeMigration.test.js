// tests/c8OrderIntakeLockPreludeMigration.test.js — C8 LOCK-ORDER FIX, part A (migration 143): ORDER INTAKE LOCK PRELUDE.
// Offline static guard of the migration pair. The behaviour (deterministic H1/H2/H3, sweeps, natural-race matrix, order numbering,
// trigger order on a real PostgreSQL catalogue, forward + rollback) is certified on ephemeral PostgreSQL by
// ci/giro-authority-certification/harness/runC8LockOrderFix.js; this file proves what text can:
//   * the migration adds ONE function and ONE trigger and changes no existing body / grant / table;
//   * the trigger sorts BEFORE every BEFORE INSERT trigger the repo ever created on ordenes (PostgreSQL fires them by name),
//     and the M132 capture keeps the last position;
//   * the prelude takes exactly L -> W FOR UPDATE -> ACTOR FOR UPDATE, in that order, with the authority expressions of the
//     entity anchor (workspace) and of the canonical payment writer (actor), and never KEY SHARE, never a write, never a payment;
//   * the md5 pins of the guard / post-condition / rollback are the md5 of the body actually in the file;
//   * the perimeter: nothing of migration 141 / 142 / Fiscal Core / the frozen writer bodies is touched;
//   * the manifest registers 143 as authored locally and NOT applied, with the sha256 of both files.
// Run: node tests/c8OrderIntakeLockPreludeMigration.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const FWD_REL = "migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql";
const RBK_REL = "migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql";
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const manifest = read("migrations/MIGRATION_MANIFEST.md");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}

// Code of the file without SQL line comments (the header prose mentions objects the code must not create).
const code = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const fwdCode = code(fwd);
const rbkCode = code(rbk);

// The dollar-quoted body (= pg_proc.prosrc) of the ONE function the migration creates.
function functionBody(sql) {
  const i = sql.indexOf("CREATE FUNCTION public.order_intake_lock_prelude_v1()");
  if (i < 0) return null;
  const open = /AS\s+(\$function\$)/.exec(sql.slice(i));
  const bodyStart = i + open.index + open[0].length;
  const end = sql.indexOf("$function$", bodyStart);
  return sql.slice(bodyStart, end);
}
const body = functionBody(fwd);
const bodyCode = body ? code(body) : "";

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist under migrations/ with number 143", fs.existsSync(path.join(ROOT, FWD_REL)) && fs.existsSync(path.join(ROOT, RBK_REL)));
check("143 is used by exactly this pair (a number is never reused)",
  fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /_migration_143\b/.test(f)).sort().join(",")
    === [FWD_REL, RBK_REL].map((f) => path.basename(f)).sort().join(","));
check("143 does not take the numbers reserved for other work (141 = B-FISC-1, 142 = the resolver change)", !/migration_14[12]\b/.test(FWD_REL));
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));

console.log("\n── the prelude function ──");
check("the forward file creates exactly ONE function (public.order_intake_lock_prelude_v1) and it is a plain CREATE (no silent overwrite)",
  (fwdCode.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi) || []).length === 1 && /CREATE FUNCTION public\.order_intake_lock_prelude_v1\(\)/.test(fwdCode));
check("plpgsql trigger function, SECURITY INVOKER (no SECURITY DEFINER), search_path pinned to public, pg_temp",
  /RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path TO 'public', 'pg_temp'\s+AS \$function\$/.test(fwdCode) && !/SECURITY\s+DEFINER/i.test(fwdCode));
check("owner postgres; EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role only",
  /ALTER FUNCTION public\.order_intake_lock_prelude_v1\(\) OWNER TO postgres;/.test(fwdCode)
  && /REVOKE ALL ON FUNCTION public\.order_intake_lock_prelude_v1\(\) FROM PUBLIC, anon, authenticated;/.test(fwdCode)
  && /GRANT EXECUTE ON FUNCTION public\.order_intake_lock_prelude_v1\(\) TO service_role;/.test(fwdCode)
  && !/GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i.test(fwdCode));

console.log("\n── lock sequence: L -> W FOR UPDATE -> ACTOR FOR UPDATE ──");
const pL = bodyCode.indexOf("PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));");
const pTs = bodyCode.indexOf("FROM public.table_sessions ts WHERE ts.id = NEW.table_session_id");
const pSing = bodyCode.indexOf("v_workspace := public.mesa_singleton_workspace_v1();");
const pW = bodyCode.indexOf("PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;");
const pAct = bodyCode.indexOf("PERFORM 1 FROM public.auth_actors WHERE workspace_id = v_workspace AND actor = v_actor FOR UPDATE;");
check("the first statement of the body is the lifecycle advisory lock L (same expression as the resolver / close / open)", pL > 0 && bodyCode.slice(0, pL).replace(/DECLARE[\s\S]*?BEGIN/, "").trim() === "");
check("the body takes L, then resolves the workspace, then locks W, then the actor, in that textual (= execution) order",
  pL >= 0 && pTs > pL && pSing > pTs && pW > pSing && pAct > pW, JSON.stringify({ pL, pTs, pSing, pW, pAct }));
check("W is taken FOR UPDATE for every intake; there is no FOR KEY SHARE / FOR SHARE / NO KEY UPDATE / NOWAIT / SKIP LOCKED in the prelude (no KEY SHARE -> FOR UPDATE upgrade is possible)",
  !/KEY SHARE|FOR SHARE|NO KEY UPDATE|NOWAIT|SKIP LOCKED/i.test(bodyCode) && (bodyCode.match(/FOR UPDATE/g) || []).length === 2);
check("the ACTOR is locked only when initial_payment_intent is present and non-empty, and never before W",
  /IF NEW\.initial_payment_intent IS NOT NULL THEN[\s\S]*?IF v_actor <> '' THEN[\s\S]*?FOR UPDATE;/.test(bodyCode) && pAct > pW);
check("no row lock other than the workspace and the payment actor: table_sessions is read plainly (no lock), service_sessions / business_days / ordenes / order_entities are never touched",
  !/service_sessions|business_days|order_entities|payment_transactions|order_financial_events|\bordenes\b(?!\.)/.test(bodyCode.replace(/NEW\.[a-z_]+/g, "")) && !/table_sessions[^;]*FOR UPDATE/.test(bodyCode));
check("the prelude writes nothing and pays nothing (no INSERT / UPDATE / DELETE / payment or refund call / NEW assignment)",
  !/\bINSERT\b|(?<!FOR )\bUPDATE\b|\bDELETE\b|order_post_payment|order_initial_payment|_ledger_write_payment|NEW\.[a-z_]+\s*:=/i.test(bodyCode));
check("the body returns NEW unchanged on every path (two RETURN NEW, no RETURN NULL)", (bodyCode.match(/RETURN NEW;/g) || []).length === 2 && !/RETURN NULL/i.test(bodyCode));

console.log("\n── authority parity with the code the prelude anticipates ──");
const anchorSrc = read("migrations/2026-08-16_r_day2_permanent_order_identity.sql");
check("workspace authority = order_entity_anchor_v1: a table order resolves via table_sessions.workspace_id (plain read), every other channel via mesa_singleton_workspace_v1()",
  /SELECT ts\.workspace_id INTO v_workspace\s+FROM public\.table_sessions ts WHERE ts\.id = NEW\.table_session_id;/.test(anchorSrc)
  && /v_workspace := public\.mesa_singleton_workspace_v1\(\);/.test(anchorSrc)
  && /SELECT ts\.workspace_id INTO v_workspace\s+FROM public\.table_sessions ts WHERE ts\.id = NEW\.table_session_id;/.test(body)
  && /v_workspace := public\.mesa_singleton_workspace_v1\(\);/.test(body));
check("an unresolved table session takes no W lock and masks nothing: the anchor's typed MESA_SESSION_NOT_FOUND stays where it is (prelude raises no error of its own)",
  /MESA_SESSION_NOT_FOUND/.test(anchorSrc) && !/MESA_SESSION_NOT_FOUND/.test(bodyCode) && /IF v_workspace IS NULL THEN RETURN NEW; END IF;/.test(bodyCode));
check("an ambiguous singleton (MESA_WORKSPACE_AMBIGUOUS) is swallowed ONLY when it is exactly that error (ERRCODE P0001 + message), anything else is re-raised, and the anchor raises it later at its usual precedence",
  /EXCEPTION WHEN SQLSTATE 'P0001' THEN\s+IF SQLERRM IS DISTINCT FROM 'MESA_WORKSPACE_AMBIGUOUS' THEN RAISE; END IF;\s+v_workspace := NULL;/.test(bodyCode)
  && /RAISE EXCEPTION 'MESA_WORKSPACE_AMBIGUOUS' USING ERRCODE='P0001'/.test(anchorSrc));
const initialPay = read("migrations/2026-08-24_n3_canonical_initial_payment.sql");
const canonicalPay = read("migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql");
check("actor expression = order_initial_payment_v1 (btrim of the intent's 'actor', empty = no actor)",
  /v_actor\s*:=\s*btrim\(COALESCE\(v_intent->>'actor',\s*''\)\)/.test(initialPay)
  && /v_actor := btrim\(COALESCE\(NEW\.initial_payment_intent ->> 'actor', ''\)\);/.test(body));
check("actor predicate = order_post_payment_v1: (workspace_id, actor) FOR UPDATE, taken right after the workspace row FOR UPDATE",
  /PERFORM 1 FROM public\.workspaces WHERE id = p_workspace_id FOR UPDATE;[\s\S]{0,400}?SELECT \* INTO v_actor FROM public\.auth_actors\s+WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;/.test(canonicalPay)
  && /FROM public\.auth_actors WHERE workspace_id = v_workspace AND actor = v_actor FOR UPDATE;/.test(body));
check("authorization is not evaluated by the prelude (no role / active / permission logic)", !/\brole\b|\bactive\b|42501|FORBIDDEN|has_function_privilege/i.test(bodyCode));

console.log("\n── the trigger: first BEFORE INSERT trigger of ordenes ──");
check("exactly ONE trigger is created: BEFORE INSERT ON public.ordenes FOR EACH ROW, no WHEN, calling the prelude",
  (fwdCode.match(/CREATE\s+TRIGGER/gi) || []).length === 1
  && /CREATE TRIGGER a0_order_intake_lock_prelude_v1\s+BEFORE INSERT ON public\.ordenes\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.order_intake_lock_prelude_v1\(\);/.test(fwdCode));
const NEW_NAME = "a0_order_intake_lock_prelude_v1";
const beforeInsertNames = new Set();
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((n) => n.endsWith(".sql") && !/ROLLBACK/.test(n) && !/migration_143\b/.test(n))) {
  const sql = code(fs.readFileSync(path.join(ROOT, "migrations", f), "utf8"));
  const re = /CREATE\s+TRIGGER\s+([a-z0-9_]+)\s+BEFORE\s+INSERT\s+ON\s+(?:public\.)?ordenes\b/gi;
  let m; while ((m = re.exec(sql))) beforeInsertNames.add(m[1]);
}
check("the repo's BEFORE INSERT triggers on ordenes are found (mesa_prepare, assign_service_session, entity anchor, giro capture)",
  ["mesa_prepare_table_order_v1", "ordenes_assign_service_session", "ordenes_order_entity_anchor_v1", "ordenes_zz_giro_intent_capture_v1"].every((n) => beforeInsertNames.has(n)),
  [...beforeInsertNames].join(","));
check("the prelude's name sorts BEFORE every one of them (byte order = the order PostgreSQL fires triggers of the same kind)",
  [...beforeInsertNames].every((n) => Buffer.compare(Buffer.from(NEW_NAME), Buffer.from(n)) < 0), [...beforeInsertNames].join(","));
check("the M132 capture stays the LAST BEFORE INSERT trigger (nothing sorts after 'ordenes_zz_giro_intent_capture_v1')",
  [...beforeInsertNames].every((n) => Buffer.compare(Buffer.from(n), Buffer.from("ordenes_zz_giro_intent_capture_v1")) <= 0));
check("the guard refuses if any BEFORE INSERT ROW trigger of ordenes already sorts at or before the new name, and the post-condition proves the prelude is the FIRST one",
  /t\.tgname <= 'a0_order_intake_lock_prelude_v1'::name/.test(fwdCode) && /min\(t\.tgname\)/.test(fwdCode) && /IS DISTINCT FROM 'a0_order_intake_lock_prelude_v1'::name/.test(fwdCode));
check("the guard and the post-condition keep the M132 invariant (capture LAST) when the capture exists",
  (fwdCode.match(/max\(t\.tgname\)/g) || []).length >= 2 && (fwdCode.match(/'ordenes_zz_giro_intent_capture_v1'::name/g) || []).length >= 2);

console.log("\n── drift guards (fail closed) ──");
check("re-applying is refused (function or trigger already exists)", /already applied \(function or trigger exists\)/.test(fwdCode));
const PINS = ["order_entity_anchor_v1()", "mesa_singleton_workspace_v1()", "mesa_prepare_table_order_v1()", "order_initial_payment_v1()"];
check("the four bodies the prelude aligns with are pinned by md5(prosrc) (32-hex) and a mismatch raises",
  PINS.every((p) => new RegExp("\\('public\\." + p.replace(/[()]/g, "\\$&") + "',\\s+'[0-9a-f]{32}'\\)").test(fwdCode))
  && /IF md5\(v_src\) IS DISTINCT FROM v_pin\.want THEN\s+RAISE EXCEPTION 'C8_PRELUDE refused: % is not the pinned staging body \(md5 mismatch\)/.test(fwdCode)
  && /IF to_regprocedure\(v_pin\.sig\) IS NULL THEN\s+RAISE EXCEPTION 'C8_PRELUDE refused: % is missing/.test(fwdCode));
check("the resolver is deliberately NOT pinned (a later migration changes it) and is not touched", !/resolve_order_intake_context_v1/.test(fwdCode));
check("the pinned md5 values are the ones recorded from staging by the C8 audit (anchor, singleton, mesa_prepare, initial payment)",
  ["3db9189218204ad2488cff64fd55eb9c", "7f431effcabf52dc541f5456dcdf7f28", "50c48c3083e106b586940f29f9640fab", "e397b66e3aabe66a123a5356c825f124"].every((h) => fwd.includes(h)));

console.log("\n── md5 pins are the md5 of the body actually in the files ──");
const bodyMd5 = md5(body);
check("the post-condition pins md5(prosrc) of the prelude = md5 of the body in the forward file", fwd.includes(`IS DISTINCT FROM '${bodyMd5}'`), bodyMd5);
check("the rollback guard pins the same md5", rbk.includes(`IS DISTINCT FROM '${bodyMd5}'`));
check("no unresolved placeholder is left in either file", !/@@/.test(fwd) && !/@@/.test(rbk));

console.log("\n── perimeter: nothing else is touched ──");
check("no existing function body is (re)created: no CREATE OR REPLACE FUNCTION in the forward file", !/CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(fwdCode));
check("the frozen writers / intake / lifecycle bodies are not referenced by a DDL statement (resolver, mesa_prepare, payment writers, refund, adjustment, rider, operator_confirm, close, open, order_cancel)",
  !/(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.(resolve_order_intake_context_v1|mesa_prepare_table_order_v1|order_post_payment_v1|mesa_post_payment_v1|order_post_refund_v1|mesa_post_refund_v1|order_apply_commercial_adjustment_v1|rider_collect_and_complete_stop|operator_confirm_delivery_v1|close_service_session_v3|open_operational_service_v1|order_cancel_v1|order_initial_payment_v1|order_entity_anchor_v1)/i.test(fwdCode));
check("no table / column / index / constraint / data change (no CREATE|ALTER|DROP TABLE|INDEX, no ADD CONSTRAINT, no INSERT INTO / UPDATE / DELETE against a business table)",
  !/(CREATE|ALTER|DROP)\s+(UNIQUE\s+)?(TABLE|INDEX|SEQUENCE|TYPE|VIEW)|ADD\s+CONSTRAINT|DELETE\s+FROM|TRUNCATE/i.test(fwdCode)
  && !/\bUPDATE\s+public\./i.test(fwdCode) && !/INSERT\s+INTO\s+public\./i.test(fwdCode));
check("no dependency on, or mention of, migration 141 / 142 / Fiscal Core / period checkpoint / Veri*Factu / business date in the CODE",
  !/period_checkpoint|business_date_of_v1|fiscal|verifactu|consolidat|migration[_ ]14[12]\b/i.test(fwdCode + rbkCode));
check("the rollback drops exactly the trigger and the function (in that order) and nothing else",
  (rbkCode.match(/^DROP\s+/gm) || []).length === 2 && /DROP TRIGGER a0_order_intake_lock_prelude_v1 ON public\.ordenes;\nDROP FUNCTION public\.order_intake_lock_prelude_v1\(\);/.test(rbkCode)
  && !/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)/i.test(rbkCode));
check("the rollback refuses unless the trigger and the function are exactly the 143 objects (body md5, trigger shape, single trigger user)",
  /rollback refused/.test(rbkCode) && /t\.tgfoid = v_fn/.test(rbkCode) && /\(t\.tgtype & 4\) = 4/.test(rbkCode) && /t\.tgqual IS NULL/.test(rbkCode));
check("the post-conditions prove the prelude is the ONLY addition: trigger count +1, every pre-existing trigger definition identical and enabled, every other function body identical",
  /v_after <> v_before \+ 1/.test(fwdCode) && /pg_get_triggerdef/.test(fwdCode) && /c8143_fn_before/.test(fwdCode) && /other function\(s\) of schema public changed/.test(fwdCode)
  && /c8143rb_fn_before/.test(rbkCode) && /differ from the before-state/.test(rbkCode));

console.log("\n── manifest ──");
const row = manifest.split("| 143 |")[1] || "";
check("the manifest registers migration 143 as authored locally and NOT applied (nothing deployed, nothing committed)",
  /\| 143 \| C8/.test(manifest) && /NOT APPLIED to staging/.test(row.split("\n")[0]));
check("the manifest row carries the sha256 of the forward and of the rollback file",
  row.split("\n")[0].includes(sha256(fwd)) && row.split("\n")[0].includes(sha256(rbk)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
