// tests/paymentCloseReceiptLockMigration.test.js — FINDING A (payment x service close), migration 145.
// Offline static guard of the migration pair. The behaviour (serialization proven with pg_locks / pg_blocking_pids / row-lock probes, P1..P14, sweeps, functional regression,
// forward + rollback on a real catalogue) is certified on ephemeral PostgreSQL by ci/giro-authority-certification/harness/runPaymentCloseFix.js; this file proves what text can:
//   * EXACTLY TWO functions are re-issued (order_post_payment_v1, mesa_post_payment_v1) and nothing else is created / altered / granted / written;
//   * each new body is its PREDECESSOR (POST-M140 order writer / live Mesa writer, re-derived here from the repo files, md5 pinned) plus ONE marked block, byte for byte;
//   * the block is exactly `PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;` and sits IMMEDIATELY before the unchanged receipt-service SELECT;
//   * no L / L0 / service-row lock / FOR UPDATE / FOR KEY SHARE / NOWAIT is added; the receipt semantics, authorization and idempotency text are untouched;
//   * the prerequisite (migration 143) is fail-closed, the md5 / overload / already-applied / privilege guards exist, and they run BEFORE the first CREATE;
//   * posture (owner / SECURITY / search_path / ACL / signature / return) is preserved by assertion, and the post-conditions prove exactly two functions changed;
//   * the rollback re-issues the predecessors verbatim, refuses over anything that is not exactly the 145 bodies and has no dependency on 143 / 144;
//   * the refund writers are NOT changed and are explicitly allowlisted as the open Finding B (REFUND_RECEIPT_RACE = KNOWN_OPEN_FINDING);
//   * the perimeter (M141 / M142 / Fiscal / consolidator / C8 objects) is untouched and the manifest registers 145 as authored locally and NOT applied.
// Run: node tests/paymentCloseReceiptLockMigration.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const FWD_REL = process.env.PCF_TEST_FWD || "migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.sql";
const RBK_REL = process.env.PCF_TEST_RBK || "migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.ROLLBACK.sql";
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const manifest = read("migrations/MIGRATION_MANIFEST.md");

// frozen pins of the design (DELIVERY_ECONOMY_V1_PAYMENT_CLOSE_RACE_DECISION_2026-09-24.md)
const ORDER_PIN = "ea4fe577feddbd2ba6f6ae42695feba6";   // POST-M140 order_post_payment_v1 (M140's own pin)
const MESA_PIN = "9543ab52d9933ffd52cc7f9b595c4cfb";    // live / staging mesa_post_payment_v1
const SIG_ORDER = "public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)";
const SIG_MESA = "public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)";
const M_BEGIN = "-- 145:BEGIN receipt_service_pointer_lock";
const M_END = "-- 145:END receipt_service_pointer_lock";
const LOCK_STMT = "  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;\n";
const RECEIPT_SELECT = "  SELECT ss.id INTO v_receipt_service_id\n    FROM public.service_session_state sst\n    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'\n   WHERE sst.singleton = true;\n";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}
const code = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const header = (sql) => sql.slice(0, sql.indexOf("\nBEGIN;\n"));

// Every CREATE [OR REPLACE] FUNCTION public.<name>( ... AS $tag$ body $tag$ of `sql` (head = up to and including the opening tag).
function statements(sql, name) {
  const out = []; const re = new RegExp("CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?" + name + "\\s*\\(", "g"); let m;
  while ((m = re.exec(sql))) {
    const rest = sql.slice(m.index); const o = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest); if (!o) continue;
    const tag = o[1]; const bs = m.index + o.index + o[0].length; const e = sql.indexOf(tag, bs); if (e < 0) continue;
    out.push({ head: sql.slice(m.index, bs), body: sql.slice(bs, e), tag });
  }
  return out;
}
const withoutBodies = (sql) => sql.replace(/(\$function\$)[\s\S]*?\1/g, "$function$$function$");
const BLOCK_RE = /^  -- 145:BEGIN ([a-z_]+)\n([\s\S]*?)^  -- 145:END \1\n/m;

// independent derivation of the two predecessors from the repo files
const M140 = read("migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql");
const M126 = read("migrations/2026-09-11_economic_writer_hardening_v1_migration_126.sql");
const predOrder = statements(M140, "order_post_payment_v1").filter((s) => md5(s.body) === ORDER_PIN);
const predMesa = statements(M126, "mesa_post_payment_v1").filter((s) => md5(s.body) === MESA_PIN);
const fOrder = statements(fwd, "order_post_payment_v1");
const fMesa = statements(fwd, "mesa_post_payment_v1");
const rOrder = statements(rbk, "order_post_payment_v1");
const rMesa = statements(rbk, "mesa_post_payment_v1");

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist under migrations/ with number 145", fs.existsSync(path.join(ROOT, FWD_REL)) && fs.existsSync(path.join(ROOT, RBK_REL)));
check("145 is used by exactly this pair (a number is never reused)",
  fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /_migration_145\b/.test(f)).sort().join(",")
    === [path.basename(FWD_REL), path.basename(RBK_REL)].sort().join(",") || process.env.PCF_TEST_FWD !== undefined);
check("145 does not take a number reserved for other work (141 = M141, 142 = M142) nor a C8 number (143 / 144)", !/migration_14[1-4]\b/.test(FWD_REL + RBK_REL));
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));

console.log("\n── the predecessors, re-derived here from the repo files ──");
check("POST-M140 order_post_payment_v1 is found exactly once in migration 140 and md5(body) = " + ORDER_PIN + " (NOT the staging body: staging is at 138)", predOrder.length === 1, String(predOrder.length));
check("the live mesa_post_payment_v1 is found exactly once in migration 126 with md5(body) = " + MESA_PIN + "; the body is pure ASCII (no mojibake): repo text == live text", predMesa.length === 1 && !/[^\x00-\x7f]/.test(predMesa[0] ? predMesa[0].body : "x"));

console.log("\n── EXACTLY two functions change; nothing else is created, altered, granted or written ──");
check("the forward file re-issues exactly two functions, both with CREATE OR REPLACE, and they are order_post_payment_v1 and mesa_post_payment_v1",
  (code(fwd).match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi) || []).length === 2 && (code(fwd).match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(order_post_payment_v1|mesa_post_payment_v1)\(/g) || []).length === 2
  && fOrder.length === 1 && fMesa.length === 1);
const skeleton = code(withoutBodies(fwd));
check("outside the two function bodies there is no CREATE TRIGGER / TABLE (other than the c145 temp tables) / INDEX / VIEW / TYPE, no ALTER, no DROP object, no GRANT / REVOKE, no COMMENT ON, no TRUNCATE / DELETE, no write to a business table",
  !/CREATE\s+(CONSTRAINT\s+)?TRIGGER/i.test(skeleton) && !/CREATE\s+(UNIQUE\s+)?(INDEX|VIEW|TYPE|SEQUENCE|SCHEMA|EXTENSION)/i.test(skeleton)
  && (skeleton.match(/CREATE\s+(TEMP|TEMPORARY)\s+TABLE\s+c145_[a-z_]+/gi) || []).length === 4 && !/CREATE\s+TABLE/i.test(skeleton)
  && !/\bALTER\s/i.test(skeleton) && !/\bDROP\s+(TABLE|FUNCTION|TRIGGER|INDEX|VIEW|TYPE|SCHEMA|POLICY|CONSTRAINT)/i.test(skeleton) && !/\b(GRANT|REVOKE)\b/i.test(skeleton)
  && !/COMMENT\s+ON/i.test(skeleton) && !/TRUNCATE|DELETE\s+FROM/i.test(skeleton) && !/UPDATE\s+public\./i.test(skeleton) && !/INSERT\s+INTO\s+(?!c145_)/i.test(skeleton));
check("no SECURITY DEFINER anywhere in the file (SECURITY INVOKER is preserved: the head of each statement is the predecessor's own head)", !/SECURITY\s+DEFINER/i.test(code(fwd)));

console.log("\n── each body = its predecessor + ONE marked block, byte for byte ──");
const strip = (b) => b.replace(BLOCK_RE, "");
for (const [label, f, pred, pin] of [["order_post_payment_v1", fOrder[0], predOrder[0], ORDER_PIN], ["mesa_post_payment_v1", fMesa[0], predMesa[0], MESA_PIN]]) {
  if (!f || !pred) { check(label + ": statements found", false); continue; }
  check(label + ": exactly ONE 145 block (BEGIN / END pair) in the new body", (f.body.match(/-- 145:BEGIN /g) || []).length === 1 && (f.body.match(/-- 145:END /g) || []).length === 1 && BLOCK_RE.test(f.body));
  check(label + ": with the block removed the body is the predecessor BYTE FOR BYTE (md5 " + pin + ")", strip(f.body) === pred.body && md5(strip(f.body)) === pin, md5(strip(f.body)));
  check(label + ": the statement head (signature, defaults, RETURNS, LANGUAGE, SET search_path) is the predecessor's head, byte for byte", f.head === pred.head);
  check(label + ": the new body differs from the predecessor only by the block's own bytes", f.body.length === pred.body.length + f.body.match(/^  -- 145:BEGIN[\s\S]*?^  -- 145:END [a-z_]+\n/m)[0].length);
  const blk = BLOCK_RE.exec(f.body);
  const blockCode = blk ? code(blk[2]).replace(/\n$/, "") : "";
  check(label + ": the block's only statement is exactly `PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;`", blockCode === LOCK_STMT.replace(/\n$/, ""), JSON.stringify(blockCode));
  check(label + ": the lock sits IMMEDIATELY before the receipt-service SELECT, which is unchanged (END marker line, then the SELECT, nothing in between)", f.body.includes(M_END + "\n" + RECEIPT_SELECT) && f.body.split(RECEIPT_SELECT).length === 2);
  check(label + ": lock mode is exactly FOR SHARE: no FOR UPDATE / FOR NO KEY UPDATE / FOR KEY SHARE / NOWAIT / SKIP LOCKED in the block", /FOR SHARE;$/.test(blockCode) && !/FOR\s+(NO\s+KEY\s+)?UPDATE|KEY\s+SHARE|NOWAIT|SKIP\s+LOCKED/i.test(blockCode));
  check(label + ": NO L / L0 / service-row lock is added: the block has no advisory lock, no service_sessions row lock, no other lock (and the rest of the body is the predecessor)", !/pg_advisory|service_sessions|LOCK\s+TABLE|hashtext|LA_DIECI_DRIVER_STATO|service_session_lifecycle/i.test(blockCode) && !/pg_advisory/i.test(strip(f.body).replace(pred.body, "")));
  check(label + ": no retry loop / new exception handler / new RAISE is introduced (the diff to the predecessor is the block alone)", !/LOOP|EXCEPTION\s+WHEN|RAISE/i.test(blockCode));
  check(label + ": the rollback re-issues the predecessor statement VERBATIM (head and body)", (label === "order_post_payment_v1" ? rOrder : rMesa).length === 1 && (label === "order_post_payment_v1" ? rOrder : rMesa)[0].head === pred.head && (label === "order_post_payment_v1" ? rOrder : rMesa)[0].body === pred.body);
}
check("the receipt-service SELECT was NOT edited: it is byte-identical to the S2 / M139 shape in both new bodies (join on status = 'open', singleton, no lock clause of its own)", fOrder.length === 1 && fMesa.length === 1 && fOrder[0].body.includes(RECEIPT_SELECT) && fMesa[0].body.includes(RECEIPT_SELECT) && !/service_sessions ss ON[^\n]*\n[^\n]*\n[^\n]*FOR\s/i.test(RECEIPT_SELECT));

console.log("\n── md5 pins are the md5 of the bodies actually in the files ──");
const newOrderMd5 = fOrder[0] ? md5(fOrder[0].body) : "", newMesaMd5 = fMesa[0] ? md5(fMesa[0].body) : "";
check("forward guard pins the two predecessors (order " + ORDER_PIN + ", mesa " + MESA_PIN + ") next to their signatures", fwd.includes(`'${SIG_ORDER}', 'order_post_payment_v1', '${ORDER_PIN}'`) && fwd.includes(`'${SIG_MESA}', 'mesa_post_payment_v1', '${MESA_PIN}'`));
check("forward post-condition pins the NEW md5 of each body (as computed from the body in the file) and re-pins the predecessor for the block-stripped comparison",
  fwd.includes(`'${SIG_ORDER}', 'order_post_payment_v1', '${newOrderMd5}', '${ORDER_PIN}'`) && fwd.includes(`'${SIG_MESA}', 'mesa_post_payment_v1', '${newMesaMd5}', '${MESA_PIN}'`));
check("rollback guard pins the two 145 bodies; rollback post-condition pins the two predecessors",
  rbk.includes(`'${SIG_ORDER}', 'order_post_payment_v1', '${newOrderMd5}'`) && rbk.includes(`'${SIG_MESA}', 'mesa_post_payment_v1', '${newMesaMd5}'`)
  && rbk.includes(`'${SIG_ORDER}', 'order_post_payment_v1', '${ORDER_PIN}'`) && rbk.includes(`'${SIG_MESA}', 'mesa_post_payment_v1', '${MESA_PIN}'`));
check("no unresolved placeholder is left in either file", !/@@|\{\{|TODO|FIXME/.test(fwd) && !/@@|\{\{|TODO|FIXME/.test(rbk));

console.log("\n── the prerequisite (migration 143) is fail-closed and enforced BEFORE anything is created ──");
const guardFwd = fwd.slice(fwd.indexOf("DO $guard$"), fwd.indexOf("END $guard$"));
check("the guard runs BEFORE the first CREATE OR REPLACE FUNCTION (nothing is created if it raises)", fwd.indexOf("DO $guard$") > 0 && fwd.indexOf("DO $guard$") < fwd.indexOf("CREATE OR REPLACE FUNCTION public.order_post_payment_v1"));
check("prerequisite: public.order_intake_lock_prelude_v1() must exist, else RAISE 'migration 143 ... is not applied' (the FIRST check of the guard)",
  /IF to_regprocedure\('public\.order_intake_lock_prelude_v1\(\)'\) IS NULL THEN\s+RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: migration 143/.test(guardFwd) && guardFwd.indexOf("order_intake_lock_prelude_v1()") < guardFwd.indexOf("md5(v_src)"));
check("prerequisite: trigger a0_order_intake_lock_prelude_v1 exists on public.ordenes, calls the prelude, is BEFORE INSERT FOR EACH ROW, has no WHEN, is enabled",
  /t\.tgname = 'a0_order_intake_lock_prelude_v1'/.test(guardFwd) && /t\.tgfoid = to_regprocedure\('public\.order_intake_lock_prelude_v1\(\)'\)/.test(guardFwd) && /\(t\.tgtype & 1\) = 1 AND \(t\.tgtype & 2\) = 2 AND \(t\.tgtype & 4\) = 4/.test(guardFwd)
  && /t\.tgqual IS NULL AND t\.tgenabled = 'O'/.test(guardFwd));
check("prerequisite: the prelude is the FIRST BEFORE INSERT ROW trigger of public.ordenes (min(tgname) = a0_order_intake_lock_prelude_v1), else RAISE",
  /min\(t\.tgname\)/.test(guardFwd) && /IS DISTINCT FROM 'a0_order_intake_lock_prelude_v1'::name THEN\s+RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused/.test(guardFwd));
check("144 is NOT a dependency: the code of the forward and rollback never names order_cancel_v1 or migration 144 (only the header says it is compatible and not required)", !/order_cancel|migration_144|\b144\b/.test(code(fwd) + code(rbk)) && /144[^\n]*NOT required/.test(header(fwd)));

console.log("\n── drift guards (fail closed) ──");
check("re-applying is refused (a body that already carries the 145 marker)", /position\('-- 145:BEGIN receipt_service_pointer_lock' IN v_src\) > 0 THEN\s+RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: already applied/.test(guardFwd));
check("both writers must exist with the exact signature and a SINGLE overload (unexpected overload set refuses)", /to_regprocedure\(v_pin\.sig\) IS NULL/.test(guardFwd) && /p\.proname = v_pin\.name\) <> 1 THEN\s+RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: % has an unexpected overload set/.test(guardFwd));
check("md5(prosrc) of each writer must equal its pin, else RAISE 'not the pinned predecessor body' (a divergent body is never overwritten); the already-applied check comes first so its message is precise",
  /IF md5\(v_src\) IS DISTINCT FROM v_pin\.want THEN\s+RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: % is not the pinned predecessor body/.test(guardFwd) && guardFwd.indexOf("already applied") < guardFwd.indexOf("md5(v_src)"));
check("privilege / posture guard: service_role needs SELECT + UPDATE on public.service_session_state (what PostgreSQL requires for SELECT ... FOR SHARE), the table and role must exist, and row-level security must be off or bypassed by service_role (rolbypassrls)",
  /has_table_privilege\('service_role', 'public\.service_session_state', 'SELECT'\)/.test(guardFwd) && /has_table_privilege\('service_role', 'public\.service_session_state', 'UPDATE'\)/.test(guardFwd)
  && /relrowsecurity/.test(guardFwd) && /rolbypassrls/.test(guardFwd) && /IF v_rls AND NOT v_bypass THEN\s+RAISE EXCEPTION/.test(guardFwd) && /to_regclass\('public\.service_session_state'\) IS NULL/.test(guardFwd));

console.log("\n── post-conditions: exactly two functions changed; posture preserved; nothing else moved ──");
const postFwd = fwd.slice(fwd.indexOf("DO $post$"), fwd.lastIndexOf("END $post$"));
check("before-state captured for every function of every user schema (md5), for the posture of the two writers, and for a catalog fingerprint", /c145_fn_before/.test(fwd) && /c145_posture_before/.test(fwd) && /c145_cat_before/.test(fwd) && /nspname NOT LIKE 'pg\\_%'/.test(fwd));
check("post-condition: the marker is present exactly once per body; the block is exactly the FOR SHARE statement; it is immediately before the receipt SELECT; block-stripped body md5 = predecessor",
  /replace\(v_src, '-- 145:BEGIN receipt_service_pointer_lock', ''\)/.test(postFwd) && /FOR SHARE;\\n\(  --\[\^\\n\]\*\\n\)\*\$\$re\$/.test(postFwd) && /145:END receipt_service_pointer_lock\\n  SELECT ss\\\.id INTO v_receipt_service_id/.test(postFwd) && /md5\(regexp_replace\(v_src/.test(postFwd));
check("post-condition: owner / SECURITY / search_path / ACL / return type / arguments unchanged, EXECUTE stays service_role-only (no anon / authenticated / PUBLIC)",
  /p\.prosecdef IS NOT DISTINCT FROM b\.prosecdef/.test(postFwd) && /p\.proconfig IS NOT DISTINCT FROM b\.proconfig/.test(postFwd) && /pg_get_userbyid\(p\.proowner\) = b\.owner/.test(postFwd) && /p\.proacl::text IS NOT DISTINCT FROM b\.acl/.test(postFwd)
  && /pg_get_function_arguments\(p\.oid\) = b\.args/.test(postFwd) && /has_function_privilege\('anon'/.test(postFwd) && /has_function_privilege\('authenticated'/.test(postFwd) && /NOT has_function_privilege\('service_role'/.test(postFwd));
check("post-condition: EXACTLY two functions differ from the before-state (v_n <> 2 raises), none disappeared, every other function of every user schema is byte-identical", /IF v_n <> 2 THEN RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % function\(s\) differ/.test(postFwd) && /disappeared/.test(postFwd));
check("post-condition: no trigger / constraint / column / index / relation / table-ACL change (six catalog fingerprints compared before / after)", /c145_cat_after/.test(postFwd) && ["triggers", "constraints", "columns", "indexes", "relations_and_acls"].every((k) => fwd.includes(`'${k}'`)) && /catalog fingerprint\(s\) changed/.test(postFwd));
check("post-condition: the two refund writers are asserted unchanged (Finding B firewall)", /order_post_refund_v1', 'mesa_post_refund_v1'/.test(postFwd) && /Finding B firewall/.test(postFwd));

console.log("\n── rollback ──");
const guardRbk = rbk.slice(rbk.indexOf("DO $guard$"), rbk.indexOf("END $guard$"));
const postRbk = rbk.slice(rbk.indexOf("DO $post$"), rbk.lastIndexOf("END $post$"));
check("the rollback refuses unless BOTH functions exist once and are EXACTLY the 145 bodies (md5 pins), naming 'not the exact 145 body' — a divergent body is never overwritten", /IF md5\(v_src\) IS DISTINCT FROM v_pin\.want THEN\s+RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK rollback refused: % is not the exact 145 body/.test(guardRbk) && /unexpected overload set/.test(guardRbk));
check("the rollback guard runs BEFORE the first CREATE OR REPLACE FUNCTION", rbk.indexOf("DO $guard$") < rbk.indexOf("CREATE OR REPLACE FUNCTION"));
check("the rollback post-condition proves: predecessor md5 for both, marker absent, posture preserved, exactly two functions differ from the before-state, nothing else moved",
  /position\('-- 145:BEGIN receipt_service_pointer_lock' IN v_src\) > 0/.test(postRbk) && /IF v_n <> 2 THEN/.test(postRbk) && /c145rb_cat_after/.test(postRbk) && /p\.proacl::text IS NOT DISTINCT FROM b\.acl/.test(postRbk));
check("the rollback creates exactly the two predecessor functions and no other object; no GRANT / REVOKE / ALTER", (code(rbk).match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/gi) || []).length === 2 && !/\b(GRANT|REVOKE)\b|\bALTER\s|CREATE\s+(CONSTRAINT\s+)?TRIGGER/i.test(code(withoutBodies(rbk))));
check("the rollback has NO dependency on 143 / 144 / M141 / M142 (it runs whether or not 143 is still applied)", !/order_intake_lock_prelude|a0_order|migration_14[1-4]\b|order_cancel/.test(code(rbk)));
check("ROLLBACK ORDER is documented in both files: 145 must be removed BEFORE 143 (payment pointer lock + no C8 prelude = the measured deadlock configuration); 143's frozen rollback cannot enforce it",
  /145 MUST BE REMOVED BEFORE 143/.test(rbk) && /ROLLBACK ORDER: 145 FIRST, THEN 143/.test(fwd) && /frozen and cannot enforce/.test(fwd) && /deadlock/i.test(rbk));

console.log("\n── Finding B firewall: the refund writers are NOT changed and are explicitly allowlisted (REFUND_RECEIPT_RACE = KNOWN_OPEN_FINDING) ──");
check("145 never creates or replaces order_post_refund_v1 / mesa_post_refund_v1 (they appear only in the untouched-assertion of the post-condition)", !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.(order|mesa)_post_refund_v1/i.test(code(fwd) + code(rbk)));
check("the header records REFUND_RECEIPT_RACE = KNOWN_OPEN_FINDING and why (locking the refund writers today would turn the race into an untyped 23514 when no service is open)", /REFUND_RECEIPT_RACE = KNOWN_OPEN_FINDING/.test(header(fwd)) && /23514/.test(header(fwd)) && /Finding B/.test(header(fwd)));
// receipt-authority INVENTORY over the whole migration history: every function whose LATEST forward definition carries the receipt-service SELECT
// snapshot AS OF 145: later migrations (146 = Finding B, which locks the refund writers) are certified by their own tests, not re-judged here
const files = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql") && !/ROLLBACK/.test(f) && !/_migration_(14[6-9]|1[5-9]\d|[2-9]\d\d)\b/.test(f)).sort();
const latest = new Map();
for (const f of files) {
  const sql = read("migrations/" + f);
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/g; let m;
  while ((m = re.exec(sql))) {
    const rest = sql.slice(m.index); const o = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest); if (!o) continue;
    const tag = o[1]; const bs = m.index + o.index + o[0].length; const e = sql.indexOf(tag, bs); if (e < 0) continue;
    latest.set(m[1], { file: f, body: sql.slice(bs, e) });
  }
}
const RS_JOIN = "JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'";
const carriers = [...latest].filter(([, v]) => v.body.includes(RS_JOIN)).map(([n]) => n).sort();
const ALLOWLIST_FINDING_B = ["mesa_post_refund_v1", "order_post_refund_v1"];     // out of scope until the Finding B decision; REMOVE from here when Finding B applies the same lock
const lockBeforeSelect = (b) => { const i = b.indexOf(RECEIPT_SELECT); return i > 0 && b.slice(0, i).endsWith(M_END + "\n") && /FOR SHARE;/.test(b.slice(Math.max(0, i - 600), i)); };
check("RECEIPT AUTHORITY INVENTORY: exactly four functions carry the receipt-service SELECT in their latest definition (the two payment writers and the two refund writers)", JSON.stringify(carriers) === JSON.stringify(["mesa_post_payment_v1", "mesa_post_refund_v1", "order_post_payment_v1", "order_post_refund_v1"]), carriers.join(","));
check("INVENTORY: the two payment writers' latest definition is migration 145 and takes the pointer lock before the SELECT",
  ["order_post_payment_v1", "mesa_post_payment_v1"].every((n) => latest.has(n) && lockBeforeSelect(latest.get(n).body)) && (process.env.PCF_TEST_FWD !== undefined || ["order_post_payment_v1", "mesa_post_payment_v1"].every((n) => /_migration_145\.sql$/.test(latest.get(n).file))));
check("INVENTORY: every OTHER carrier is on the explicit allowlist (the open Finding B) and does NOT take the lock: order_post_refund_v1 / mesa_post_refund_v1 (latest definition: migration 122, unchanged)",
  carriers.filter((n) => !["order_post_payment_v1", "mesa_post_payment_v1"].includes(n)).every((n) => ALLOWLIST_FINDING_B.includes(n) && !/service_session_state WHERE singleton = true FOR SHARE/.test(latest.get(n).body) && !/145:BEGIN/.test(latest.get(n).body))
  && ALLOWLIST_FINDING_B.every((n) => latest.has(n) && /_migration_122\.sql$/.test(latest.get(n).file)));

console.log("\n── perimeter: nothing else is touched ──");
check("no dependency on, or mention of, M141 / M142 / Fiscal / period checkpoint / VeriFactu / consolidator / business date in the CODE of either file", !/period_checkpoint|business_date_of_v1|fiscal|verifactu|consolidat|migration[_ ]14[12]\b/i.test(code(fwd) + code(rbk)));
check("the frozen writers / lifecycle bodies are not referenced by any DDL statement: close_service_session_v3, open_operational_service_v1, resolve_order_intake_context_v1, operator_confirm_delivery_v1, rider_collect_and_complete_stop, order_initial_payment_v1, order_cancel_v1, the C8 prelude",
  !/(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?(close_service_session_v3|open_operational_service_v1|resolve_order_intake_context_v1|operator_confirm_delivery_v1|rider_collect_and_complete_stop|order_initial_payment_v1|order_cancel_v1|order_intake_lock_prelude_v1)/i.test(code(fwd) + code(rbk)));
check("receipt semantics, authorization and idempotency are untouched: the new bodies still carry the M139 off-service block, the role gate and the idempotent replay of the predecessor (guaranteed by the byte-equality above; re-asserted on the anchors)",
  fOrder.length === 1 && fMesa.length === 1 && fOrder[0].body.includes("-- 139:BEGIN off_service_receipt") && fOrder[0].body.includes("-- 140:BEGIN rider_delivery_attestation") && /ORDER_PAYMENT_FORBIDDEN/.test(fOrder[0].body) && /IF FOUND THEN\s+IF v_existing\.request_hash <> p_request_hash/.test(fOrder[0].body) && /MESA_/.test(fMesa[0].body));

console.log("\n── manifest ──");
const row = (manifest.split("| 145 |")[1] || "").split("\n")[0];
check("the manifest registers migration 145 as authored locally and NOT applied (nothing deployed, nothing committed)", /\| 145 \| FINDING A/.test(manifest) && /NOT APPLIED to staging/.test(row));
check("the manifest row carries the sha256 of the forward and of the rollback file", row.includes(sha256(fwd)) && row.includes(sha256(rbk)));
check("the manifest row records the two predecessor pins, the prerequisite (143 applied first) and the rollback order (145 before 143)", row.includes(ORDER_PIN) && row.includes(MESA_PIN) && /143/.test(row) && /145[^|]*BEFORE 143|145 FIRST/.test(row) && /Finding B/.test(row));
check("the rows of the C8 migrations 143 / 144 are still present in the manifest (145 is added after them, they are not edited)", /\| 143 \| C8/.test(manifest) && /\| 144 \| C8/.test(manifest) && manifest.indexOf("| 144 |") < manifest.indexOf("| 145 |"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
