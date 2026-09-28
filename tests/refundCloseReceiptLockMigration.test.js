// tests/refundCloseReceiptLockMigration.test.js — FINDING B (refund off-service + refund x service close), migration 146.
// Offline static guard of the migration pair. The behaviour (R1-R12 / M1-M12 with row-lock probes, pg_locks, pg_blocking_pids; the 27 lock-graph pairs and the two negative
// controls; the differential regression; forward + rollback on a real catalogue) is certified on ephemeral PostgreSQL by
// ci/giro-authority-certification/harness/runFindingBRefundFix.js; this file proves what text can:
//   * EXACTLY TWO functions are re-issued (order_post_refund_v1, mesa_post_refund_v1) and nothing else is created / altered / granted / written;
//   * each new body is its LIVE predecessor (migration-122 text through the UTF-8 -> MacRoman mojibake that staging stores, re-derived here, md5 pinned) plus its
//     marked block(s), byte for byte;
//   * both writers: `PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;` IMMEDIATELY before the unchanged receipt-service SELECT;
//     the order writer ALONE: `ORDER_REFUND_NO_OPEN_SERVICE` / 55000 IMMEDIATELY after that SELECT and before every write of the refund path;
//     the Mesa writer: no refusal of any kind (MESA_REFUND_OFF_SERVICE = UNCHANGED_ALLOWED);
//   * the prerequisite (143) and the Economy lineage (145 applied) are fail-closed, with the md5 / overload / already-applied / privilege / transport guards, all BEFORE the first CREATE;
//   * the rollback re-issues the predecessors verbatim, refuses over anything that is not exactly the 146 bodies and depends on nothing else (not on 145);
//   * FINAL CANDIDATE STATE (143 + 144 + 145 + 146): the four receipt writers all take the pointer lock before the receipt SELECT -- no open finding is allowlisted;
//   * the Economy numbering (140, 143, 144, 145, 146, 147, 148, 149; 141 / 142 absent), the manifest row, and the frozen 143 / 144 / 145 files (sha256 = their manifest rows).
// This file does NOT edit or supersede tests/paymentCloseReceiptLockMigration.test.js (the historical certification of 145 stays frozen).
// Run: node tests/refundCloseReceiptLockMigration.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), "utf8");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const FWD_FILE = "2026-09-25_refund_close_receipt_lock_v1_migration_146.sql";
const RBK_FILE = "2026-09-25_refund_close_receipt_lock_v1_migration_146.ROLLBACK.sql";
const FWD_REL = process.env.FB_TEST_FWD || "migrations/" + FWD_FILE;
const RBK_REL = process.env.FB_TEST_RBK || "migrations/" + RBK_FILE;
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const manifest = read("migrations/MIGRATION_MANIFEST.md");

// frozen pins of the design (DELIVERY_ECONOMY_V1_FINDING_B_REFUND_DECISION_2026-09-24.md) and of migration 145
const PIN = { order: "f057928b8f6fade25d38d4bb1d3ed09a", mesa: "62f0e128a6e5d0623b0423a69f0329d3" };     // LIVE staging refund bodies
const RAW122 = { order: "b07ca9b2852bedd38dc825baea03a68f", mesa: "be50bea93243ed58f664fa7418edb976" };  // the migration-122 file text WITHOUT the mojibake (NOT the predecessor)
const PAY145 = { order: "799f8093328b4ac81e1ad5a3d37e1bb6", mesa: "94867e165d0732f36ae4692fc6998c58" };
const SIG = {
  order: "public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)",
  mesa: "public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)",
  opay: "public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)",
  mpay: "public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)",
};
const RECEIPT_SELECT = "  SELECT ss.id INTO v_receipt_service_id\n    FROM public.service_session_state sst\n    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'\n   WHERE sst.singleton = true;\n";
const LOCK_BLOCK = "  -- 146:BEGIN refund_receipt_pointer_lock\n  PERFORM 1\n  FROM public.service_session_state\n  WHERE singleton = true\n  FOR SHARE;\n  -- 146:END refund_receipt_pointer_lock\n";
const REJECT_BLOCK = "  -- 146:BEGIN order_refund_requires_open_service\n  IF v_receipt_service_id IS NULL THEN\n    RAISE EXCEPTION 'ORDER_REFUND_NO_OPEN_SERVICE'\n      USING ERRCODE = '55000';\n  END IF;\n  -- 146:END order_refund_requires_open_service\n";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}
const code = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const header = (sql) => sql.slice(0, sql.indexOf("\nBEGIN;\n"));
const count = (s, x) => s.split(x).length - 1;
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
const params = (head) => head.slice(head.indexOf("(") + 1, head.lastIndexOf(")", head.indexOf("RETURNS"))).split(",").map((p) => p.trim().replace(/\s+/g, " ").replace(/ DEFAULT .*$/, "").replace(/ = .*$/, ""));

// independent derivation of the LIVE predecessors: the migration-122 text through the UTF-8 -> MacRoman mojibake (the section sign "§" stored as "¬ß")
const mac = new TextDecoder("macintosh");
const moji = (s) => mac.decode(Buffer.from(s, "utf8"));
const M122 = read("migrations/2026-09-07_check_centric_universal_cash_v1_migration_122.sql");
const s122 = { order: statements(M122, "order_post_refund_v1"), mesa: statements(M122, "mesa_post_refund_v1") };
const pred = { order: s122.order.map((s) => ({ ...s, body: moji(s.body) })).filter((s) => md5(s.body) === PIN.order), mesa: s122.mesa.map((s) => ({ ...s, body: moji(s.body) })).filter((s) => md5(s.body) === PIN.mesa) };
const f = { order: statements(fwd, "order_post_refund_v1"), mesa: statements(fwd, "mesa_post_refund_v1") };
const r = { order: statements(rbk, "order_post_refund_v1"), mesa: statements(rbk, "mesa_post_refund_v1") };

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist with number 146", fs.existsSync(path.isAbsolute(FWD_REL) ? FWD_REL : path.join(ROOT, FWD_REL)) && fs.existsSync(path.isAbsolute(RBK_REL) ? RBK_REL : path.join(ROOT, RBK_REL)));
check("146 is used by exactly this pair (a number is never reused)", fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => /_migration_146\b/.test(x)).sort().join(",") === [FWD_FILE, RBK_FILE].sort().join(","));
check("ECONOMY NUMBERING: the migrations >= 140 are exactly the pairs 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156 (152-154 = the POST-ASTRA corrective cycle, 155-156 = the final liveness gate) (147 = R2, 148 = the legacy paid guard, 149 = the R4B atomic close, 150 = the corrective slice, 151 = the final concurrency fix, after this one) -- 141 / 142 (Fiscal: M141 / M142) are NOT in the Economy package",
  [...new Set(fs.readdirSync(path.join(ROOT, "migrations")).map((x) => (/_migration_(1[4-9]\d|[2-9]\d\d)\b/.exec(x) || [])[1]).filter(Boolean))].sort().join(",") === "140,143,144,145,146,147,148,149,150,151,152,153,154,155,156"
  && !fs.readdirSync(path.join(ROOT, "migrations")).some((x) => /_migration_14[12]\b/.test(x)));
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));

console.log("\n── the LIVE predecessors, re-derived here from migration 122 + the MacRoman mojibake ──");
check("order_post_refund_v1: exactly one statement in migration 122 whose mojibake body has md5 " + PIN.order + " (= staging); the raw file text is NOT it (" + RAW122.order + ")", pred.order.length === 1 && s122.order.length === 1 && md5(s122.order[0].body) === RAW122.order);
check("mesa_post_refund_v1: exactly one statement in migration 122 whose mojibake body has md5 " + PIN.mesa + " (= staging); the raw file text is NOT it (" + RAW122.mesa + ")", pred.mesa.length === 1 && s122.mesa.length === 1 && md5(s122.mesa[0].body) === RAW122.mesa);
check("the only non-ASCII characters of both predecessors are the mojibake pair \"¬ß\" (3 pairs in the order writer, 5 in the Mesa writer)", pred.order.length === 1 && pred.mesa.length === 1
  && [...pred.order[0].body].filter((c) => c.charCodeAt(0) > 127).join("") === "¬ß".repeat(3) && [...pred.mesa[0].body].filter((c) => c.charCodeAt(0) > 127).join("") === "¬ß".repeat(5));

console.log("\n── EXACTLY two functions change; nothing else is created, altered, granted or written ──");
check("the forward re-issues exactly two functions, both CREATE OR REPLACE: order_post_refund_v1 and mesa_post_refund_v1",
  (code(fwd).match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi) || []).length === 2 && (code(fwd).match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(order_post_refund_v1|mesa_post_refund_v1)\(/g) || []).length === 2 && f.order.length === 1 && f.mesa.length === 1);
const skeleton = code(withoutBodies(fwd)).replace(/\$blk\$[\s\S]*?\$blk\$/g, "''").replace(/'(?:[^']|'')*'/g, "''");   // string literals (messages, the block literals of the post-condition) are not statements
check("outside the two bodies: no CREATE TRIGGER / TABLE (other than the c146 temp tables) / INDEX / VIEW / TYPE, no ALTER, no DROP, no GRANT / REVOKE, no COMMENT ON, no TRUNCATE / DELETE / UPDATE / INSERT into a business table",
  !/CREATE\s+(CONSTRAINT\s+)?TRIGGER/i.test(skeleton) && !/CREATE\s+(UNIQUE\s+)?(INDEX|VIEW|TYPE|SEQUENCE|SCHEMA|EXTENSION)/i.test(skeleton)
  && (skeleton.match(/CREATE\s+(TEMP|TEMPORARY)\s+TABLE\s+c146_[a-z_]+/gi) || []).length === 4 && !/CREATE\s+TABLE/i.test(skeleton)
  && !/\bALTER\s/i.test(skeleton) && !/\bDROP\s/i.test(skeleton) && !/\b(GRANT|REVOKE)\b/i.test(skeleton)
  && !/COMMENT\s+ON/i.test(skeleton) && !/TRUNCATE|DELETE\s+FROM/i.test(skeleton) && !/UPDATE\s+public\./i.test(skeleton) && !/INSERT\s+INTO\s+(?!c146_)/i.test(skeleton));
check("no SECURITY DEFINER anywhere (SECURITY INVOKER preserved)", !/SECURITY\s+DEFINER/i.test(code(fwd)) && !/SECURITY\s+DEFINER/i.test(code(rbk)));
check("the statement heads keep the signature: Mesa head = the migration-122 head (CREATE OR REPLACE, defaults included) byte for byte; order head = the same ten parameters, types and order as migration 122, RETURNS jsonb, plpgsql, search_path public, extensions, pg_temp",
  f.mesa.length === 1 && pred.mesa.length === 1 && f.mesa[0].head === pred.mesa[0].head && f.order.length === 1 && pred.order.length === 1
  && JSON.stringify(params(f.order[0].head)) === JSON.stringify(params(pred.order[0].head)) && params(f.order[0].head).length === 10
  && /\n RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO 'public', 'extensions', 'pg_temp'\nAS \$function\$$/.test(f.order[0].head) && /RETURNS jsonb[\s\S]*LANGUAGE plpgsql[\s\S]*SET search_path TO 'public', 'extensions', 'pg_temp'/.test(pred.order[0].head),
  JSON.stringify([params(f.order[0] ? f.order[0].head : ""), params(pred.order[0] ? pred.order[0].head : "")]));

console.log("\n── order_post_refund_v1: live predecessor + pointer lock + typed refusal, byte for byte ──");
const fo = f.order[0] ? f.order[0].body : "", fm = f.mesa[0] ? f.mesa[0].body : "";
check("the pointer-lock block is present exactly ONCE and is byte-exact (`PERFORM 1 / FROM public.service_session_state / WHERE singleton = true / FOR SHARE;`)", count(fo, LOCK_BLOCK) === 1 && count(fo, "-- 146:BEGIN refund_receipt_pointer_lock") === 1 && count(fo, "-- 146:END refund_receipt_pointer_lock") === 1);
check("the typed-refusal block is present exactly ONCE and is byte-exact (IF v_receipt_service_id IS NULL -> RAISE 'ORDER_REFUND_NO_OPEN_SERVICE' USING ERRCODE = '55000')", count(fo, REJECT_BLOCK) === 1 && count(fo, "ORDER_REFUND_NO_OPEN_SERVICE") === 1 && count(fo, "-- 146:BEGIN ") === 2 && count(fo, "-- 146:END ") === 2);
check("ORDER LAYOUT: lock IMMEDIATELY before the unchanged receipt SELECT, refusal IMMEDIATELY after it (nothing in between), the SELECT itself occurs once", fo.includes(LOCK_BLOCK + RECEIPT_SELECT + REJECT_BLOCK) && count(fo, RECEIPT_SELECT) === 1);
const iRej = fo.indexOf(REJECT_BLOCK) + REJECT_BLOCK.length;
check("NO WRITE BEFORE THE REFUSAL POINT: every INSERT into payment_transactions / payment_allocations / order_financial_events and the ordenes UPDATE come after it; the only earlier write is the pre-existing replay audit row inside the replay branch, which RETURNs",
  ["INSERT INTO public.payment_transactions", "INSERT INTO public.payment_allocations", "INSERT INTO public.order_financial_events", "UPDATE public.ordenes"].every((x) => fo.indexOf(x) > iRej)
  && (fo.slice(0, iRej).match(/INSERT INTO|UPDATE public\.|DELETE FROM/g) || []).length === 1 && /IF FOUND THEN[\s\S]*INSERT INTO public\.auth_audit[\s\S]*RETURN jsonb_build_object\('ok', true, 'idempotent', true[\s\S]*END IF;/.test(fo.slice(0, fo.indexOf(LOCK_BLOCK))));
check("ERROR PRECEDENCE: validation -> authorization -> idempotent replay (returns) -> order / original-transaction validation -> refundable amount -> pointer lock -> receipt SELECT -> typed refusal -> writes",
  (() => { const at = (x) => fo.indexOf(x); const seq = [at("'ORDER_REFUND_INVALID'"), at("'ORDER_REFUND_FORBIDDEN'"), at("'idempotent', true"), at("'ORDER_REFUND_ORDER_NOT_FOUND'"), at("'ORDER_REFUND_TRANSACTION_NOT_FOUND'"), at("'ORDER_REFUND_TRANSACTION_MISMATCH'"),
    at("'ORDER_REFUND_ALREADY_FULL'"), at("'ORDER_REFUND_EXCEEDS_REMAINING'"), at(LOCK_BLOCK), at(RECEIPT_SELECT), at(REJECT_BLOCK), at("INSERT INTO public.payment_transactions")]; return seq.every((x, i) => x > 0 && (i === 0 || x > seq[i - 1])); })());
check("with its two blocks removed the order body is the LIVE predecessor BYTE FOR BYTE (md5 " + PIN.order + "), and it differs from it by exactly the blocks' bytes",
  pred.order.length === 1 && fo.replace(LOCK_BLOCK, "").replace(REJECT_BLOCK, "") === pred.order[0].body && md5(fo.replace(LOCK_BLOCK, "").replace(REJECT_BLOCK, "")) === PIN.order && fo.length === pred.order[0].body.length + LOCK_BLOCK.length + REJECT_BLOCK.length);

console.log("\n── mesa_post_refund_v1: live predecessor + pointer lock ONLY ──");
check("the pointer-lock block exactly once, byte-exact, IMMEDIATELY before the unchanged receipt SELECT", count(fm, LOCK_BLOCK) === 1 && fm.includes(LOCK_BLOCK + RECEIPT_SELECT) && count(fm, RECEIPT_SELECT) === 1);
check("NO refusal: no ORDER_REFUND_NO_OPEN_SERVICE, no `requires_open_service` block, no other 146 block, no new RAISE (MESA_REFUND_OFF_SERVICE = UNCHANGED_ALLOWED)", !fm.includes("ORDER_REFUND_NO_OPEN_SERVICE") && !/requires_open_service/.test(fm) && count(fm, "-- 146:BEGIN ") === 1 && count(fm, "-- 146:END ") === 1
  && pred.mesa.length === 1 && count(fm, "RAISE EXCEPTION") === count(pred.mesa[0].body, "RAISE EXCEPTION"));
check("with its block removed the Mesa body is the LIVE predecessor BYTE FOR BYTE (md5 " + PIN.mesa + ")", pred.mesa.length === 1 && fm.replace(LOCK_BLOCK, "") === pred.mesa[0].body && md5(fm.replace(LOCK_BLOCK, "")) === PIN.mesa && fm.length === pred.mesa[0].body.length + LOCK_BLOCK.length);

console.log("\n── the lock itself (both writers) ──");
const lockCode = code(LOCK_BLOCK).replace(/\s+/g, " ").trim();
check("lock mode is exactly FOR SHARE on the lifecycle pointer: no FOR UPDATE / NO KEY UPDATE / KEY SHARE / NOWAIT / SKIP LOCKED, no advisory lock (no L, no L0), no service-row lock", lockCode === "PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;"
  && ![fo, fm].some((b) => { const d = b.replace(LOCK_BLOCK, "").replace(REJECT_BLOCK, ""); return /pg_advisory|service_session_lifecycle|LA_DIECI_DRIVER_STATO/i.test(b) || /FOR\s+(NO\s+KEY\s+)?UPDATE|KEY\s+SHARE|NOWAIT|SKIP\s+LOCKED/i.test(LOCK_BLOCK + REJECT_BLOCK) || d.length !== b.length - LOCK_BLOCK.length - (b.includes(REJECT_BLOCK) ? REJECT_BLOCK.length : 0); }));
check("the receipt-service SELECT was NOT edited in either writer (byte-identical to the migration-122 / 145 shape, no lock clause of its own)", pred.order.length === 1 && pred.mesa.length === 1 && pred.order[0].body.includes(RECEIPT_SELECT) && pred.mesa[0].body.includes(RECEIPT_SELECT) && fo.includes(RECEIPT_SELECT) && fm.includes(RECEIPT_SELECT));

console.log("\n── md5 pins are the md5 of the bodies actually in the files ──");
const NEW = { order: md5(fo), mesa: md5(fm) };
check("forward guard pins the two live predecessors next to their signatures", fwd.includes(`'${SIG.order}', 'order_post_refund_v1', '${PIN.order}'`) && fwd.includes(`'${SIG.mesa}', 'mesa_post_refund_v1', '${PIN.mesa}'`));
check("forward post-condition pins the NEW md5 of each body (computed here from the file) and re-pins the predecessor", fwd.includes(`'${SIG.order}', 'order_post_refund_v1', '${NEW.order}', '${PIN.order}', 2`) && fwd.includes(`'${SIG.mesa}', 'mesa_post_refund_v1', '${NEW.mesa}', '${PIN.mesa}', 1`));
check("rollback guard pins the two 146 bodies; rollback post-condition pins the two live predecessors", rbk.includes(`'${SIG.order}', 'order_post_refund_v1', '${NEW.order}'`) && rbk.includes(`'${SIG.mesa}', 'mesa_post_refund_v1', '${NEW.mesa}'`)
  && rbk.includes(`'${SIG.order}', 'order_post_refund_v1', '${PIN.order}'`) && rbk.includes(`'${SIG.mesa}', 'mesa_post_refund_v1', '${PIN.mesa}'`));
check("the post-condition's block literals are byte-identical to the blocks in the bodies (lock, receipt SELECT, refusal)", fwd.includes("v_lock text := $blk$" + LOCK_BLOCK + "$blk$;") && fwd.includes("v_sel  text := $blk$" + RECEIPT_SELECT + "$blk$;") && fwd.includes("v_rej  text := $blk$" + REJECT_BLOCK + "$blk$;"));
check("no unresolved placeholder in either file", !/@@|\{\{|TODO|FIXME|\$\{/.test(fwd) && !/@@|\{\{|TODO|FIXME|\$\{/.test(rbk));

console.log("\n── guards: fail closed, all BEFORE the first CREATE ──");
const guardFwd = fwd.slice(fwd.indexOf("DO $guard$"), fwd.indexOf("END $guard$"));
const at = (x) => guardFwd.indexOf(x);
check("the guard block runs BEFORE the first CREATE OR REPLACE FUNCTION (nothing is created if it raises)", fwd.indexOf("DO $guard$") > 0 && fwd.indexOf("END $guard$") < fwd.indexOf("CREATE OR REPLACE FUNCTION public.order_post_refund_v1"));
check("transport guard: the embedded live bytes must arrive as UTF-8 (server UTF8, octet_length / md5 of the mojibake literal), else a typed refusal", /IF current_setting\('server_encoding'\) <> 'UTF8' OR octet_length\('¬ß'\) <> 4 OR md5\('¬ß'\) IS DISTINCT FROM '45e0e64ed4f04e4ea4e6e21148e2eadc' THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: this file must be sent as UTF-8/.test(guardFwd) && md5("¬ß") === "45e0e64ed4f04e4ea4e6e21148e2eadc");
check("PREREQUISITE 143: prelude function exists; trigger a0_order_intake_lock_prelude_v1 on ordenes calls it, BEFORE INSERT FOR EACH ROW, no WHEN, enabled; it is the FIRST BEFORE INSERT trigger",
  /IF to_regprocedure\('public\.order_intake_lock_prelude_v1\(\)'\) IS NULL THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: migration 143/.test(guardFwd) && /t\.tgname = 'a0_order_intake_lock_prelude_v1'/.test(guardFwd)
  && /t\.tgfoid = to_regprocedure\('public\.order_intake_lock_prelude_v1\(\)'\)/.test(guardFwd) && /\(t\.tgtype & 1\) = 1 AND \(t\.tgtype & 2\) = 2 AND \(t\.tgtype & 4\) = 4/.test(guardFwd)
  && /t\.tgqual IS NULL AND t\.tgenabled = 'O'/.test(guardFwd) && /min\(t\.tgname\)/.test(guardFwd) && /IS DISTINCT FROM 'a0_order_intake_lock_prelude_v1'::name THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused/.test(guardFwd));
// the 145 lineage pins must be the md5 of the bodies actually carried by migration 145 (cross-checked against the frozen file, not copied)
const F145 = read("migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.sql");
const b145 = { order: statements(F145, "order_post_payment_v1"), mesa: statements(F145, "mesa_post_payment_v1") };
check("ECONOMY LINEAGE: the guard refuses unless order_post_payment_v1 / mesa_post_payment_v1 are the 145 bodies -- and those pins ARE the md5 of the bodies in the frozen 145 file (" + PAY145.order + " / " + PAY145.mesa + ")",
  b145.order.length === 1 && b145.mesa.length === 1 && md5(b145.order[0].body) === PAY145.order && md5(b145.mesa[0].body) === PAY145.mesa
  && guardFwd.includes(`('${SIG.opay}', 'order_post_payment_v1', '${PAY145.order}')`) && guardFwd.includes(`('${SIG.mpay}', 'mesa_post_payment_v1', '${PAY145.mesa}')`) && /RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: ECONOMY_LINEAGE -- migration 145 is not applied/.test(guardFwd));
check("guard ORDER: transport -> 143 prerequisite -> 145 lineage -> refund writers (exists / single overload / already applied / md5) -> privileges", at("octet_length") < at("order_intake_lock_prelude_v1()") && at("order_intake_lock_prelude_v1()") < at("ECONOMY_LINEAGE") && at("ECONOMY_LINEAGE") < at("unexpected overload set")
  && at("unexpected overload set") < at("refused: already applied") && at("refused: already applied") < at("IF md5(v_src) IS DISTINCT FROM v_pin.want") && at("IF md5(v_src) IS DISTINCT FROM v_pin.want") < at("has_table_privilege"));
check("refund writers: exact signature, SINGLE overload, not already applied (any 146 block), md5 = the live pin; a divergent body is never overwritten",
  /IF to_regprocedure\(v_pin\.sig\) IS NULL THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: % is missing/.test(guardFwd) && /p\.proname = v_pin\.name\) <> 1 THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: % has an unexpected overload set/.test(guardFwd)
  && /IF position\('-- 146:BEGIN ' IN v_src\) > 0 THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: already applied/.test(guardFwd) && /IF md5\(v_src\) IS DISTINCT FROM v_pin\.want THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: % is not the pinned live predecessor body/.test(guardFwd));
check("posture guard: service_role exists, has SELECT + UPDATE on public.service_session_state (FOR SHARE), and RLS is off or bypassed (rolbypassrls)",
  /FROM pg_roles WHERE rolname = 'service_role'/.test(guardFwd) && /has_table_privilege\('service_role', 'public\.service_session_state', 'SELECT'\)/.test(guardFwd) && /has_table_privilege\('service_role', 'public\.service_session_state', 'UPDATE'\)/.test(guardFwd)
  && /relrowsecurity/.test(guardFwd) && /rolbypassrls/.test(guardFwd) && /IF v_rls AND NOT v_bypass THEN\s+RAISE EXCEPTION/.test(guardFwd));

console.log("\n── post-conditions ──");
const postFwd = fwd.slice(fwd.indexOf("DO $post$"), fwd.lastIndexOf("END $post$"));
check("before-state captured for every function of every user schema, for the posture of the two writers and for a catalog fingerprint", /c146_fn_before/.test(fwd) && /c146_posture_before/.test(fwd) && /c146_cat_before/.test(fwd) && /nspname NOT LIKE 'pg\\_%'/.test(fwd));
check("post-condition: new md5, lock block once + byte-exact + immediately before the SELECT, 2 blocks in the order writer / 1 in Mesa, refusal immediately after the SELECT and before every write (order), NO refusal in Mesa, block-stripped body = predecessor",
  /is not the expected 146 body/.test(postFwd) && /position\(v_lock \|\| v_sel IN v_src\) = 0/.test(postFwd) && /position\(v_lock \|\| v_sel \|\| v_rej IN v_src\) = 0/.test(postFwd) && /a write of the refund path of % precedes the typed refusal/.test(postFwd)
  && /must NOT refuse an off-service refund/.test(postFwd) && /md5\(replace\(replace\(v_src, v_lock, ''\), v_rej, ''\)\) IS DISTINCT FROM v_pin\.want_pre/.test(postFwd) && /md5\(replace\(v_src, v_lock, ''\)\) IS DISTINCT FROM v_pin\.want_pre/.test(postFwd));
check("post-condition: owner / SECURITY / search_path / ACL / return / arguments unchanged; EXECUTE stays service_role-only", /p\.prosecdef IS NOT DISTINCT FROM b\.prosecdef/.test(postFwd) && /p\.proconfig IS NOT DISTINCT FROM b\.proconfig/.test(postFwd) && /pg_get_userbyid\(p\.proowner\) = b\.owner/.test(postFwd)
  && /p\.proacl::text IS NOT DISTINCT FROM b\.acl/.test(postFwd) && /pg_get_function_arguments\(p\.oid\) = b\.args/.test(postFwd) && /has_function_privilege\('anon'/.test(postFwd) && /NOT has_function_privilege\('service_role'/.test(postFwd));
check("post-condition: EXACTLY two functions differ (none added, none removed), the 145 payment writers unchanged, no trigger / constraint / column / index / relation / ACL change",
  /IF v_n <> 2 THEN RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % function\(s\) differ/.test(postFwd) && /disappeared/.test(postFwd) && /a 145 payment writer changed/.test(postFwd)
  && /c146_cat_after/.test(postFwd) && ["triggers", "constraints", "columns", "indexes", "relations_and_acls"].every((k) => fwd.includes(`'${k}'`)));

console.log("\n── rollback ──");
const guardRbk = rbk.slice(rbk.indexOf("DO $guard$"), rbk.indexOf("END $guard$"));
const postRbk = rbk.slice(rbk.indexOf("DO $post$"), rbk.lastIndexOf("END $post$"));
check("the rollback refuses unless BOTH functions exist once and are EXACTLY the 146 bodies (so a second rollback is refused too); UTF-8 transport guarded", /IF md5\(v_src\) IS DISTINCT FROM v_pin\.want THEN\s+RAISE EXCEPTION 'REFUND_CLOSE_LOCK rollback refused: % is not the exact 146 body/.test(guardRbk) && /unexpected overload set/.test(guardRbk) && /octet_length\('¬ß'\) <> 4/.test(guardRbk));
check("the rollback guard runs BEFORE the first CREATE", rbk.indexOf("END $guard$") < rbk.indexOf("CREATE OR REPLACE FUNCTION"));
check("the rollback re-issues both LIVE predecessors VERBATIM (head and body, mojibake included)", r.order.length === 1 && r.mesa.length === 1 && pred.order.length === 1 && pred.mesa.length === 1
  && r.order[0].body === pred.order[0].body && r.mesa[0].body === pred.mesa[0].body && r.order[0].head === f.order[0].head && r.mesa[0].head === f.mesa[0].head);
check("the rollback post-condition proves: predecessor md5, no 146 marker, posture preserved, exactly two functions differ, catalog unchanged", /position\('-- 146:' IN v_src\) > 0/.test(postRbk) && /IF v_n <> 2 THEN/.test(postRbk) && /c146rb_cat_after/.test(postRbk) && /p\.proacl::text IS NOT DISTINCT FROM b\.acl/.test(postRbk));
check("the rollback creates exactly the two predecessor functions and no other object; no GRANT / REVOKE / ALTER / DROP", (code(rbk).match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/gi) || []).length === 2 && !/\b(GRANT|REVOKE)\b|\bALTER\s|\bDROP\s|CREATE\s+(CONSTRAINT\s+)?TRIGGER/i.test(code(withoutBodies(rbk))));
check("the rollback has NO dependency on 145 / 144 / 143 / M141 / M142 (it names neither the payment writers nor the prelude nor order_cancel)", !/order_post_payment_v1|mesa_post_payment_v1|order_intake_lock_prelude|a0_order|order_cancel|migration_14[1-5]\b/.test(code(withoutBodies(rbk))));
check("ROLLOUT and ROLLBACK ORDER are documented: 139 -> 140 -> 143 -> 144 -> 145 -> 146; rollback 146 first, then 145, then 144 / 143", /139 -> 140 -> 143 -> 144 -> 145 -> 146/.test(header(fwd)) && /ROLLBACK ORDER: 146 FIRST, then 145, then 144 \/ 143/.test(header(fwd)) && /146 FIRST, then 145, then 144 \/ 143/.test(rbk));

console.log("\n── isolation (recorded, not changed) ──");
check("the header records that the semantics REQUIRE READ COMMITTED, that staging runs it with no override, that non-RC fails closed (40001), and that the PG17 pre-apply gate re-checks it; the code sets no isolation level",
  /READ COMMITTED/.test(header(fwd)) && /default_transaction_isolation = read committed/.test(header(fwd)) && /40001/.test(header(fwd)) && /PG17 pre-apply gate/.test(header(fwd)) && !/ISOLATION\s+LEVEL|transaction_isolation\s*=|SET\s+TRANSACTION/i.test(code(fwd) + code(rbk)));

console.log("\n── FINAL CANDIDATE STATE: the four receipt writers are all locked (no open finding is allowlisted) ──");
// latest forward definition of every function across the migration history (the 146 forward under test substitutes the repo file when overridden),
// in the CANONICAL APPLY ORDER -- never the file-name order: sorting by name puts 147 (2026-09-25_mesa_...) before 146 (2026-09-25_refund_...) and 144
// before 143, so the "latest" mesa_post_refund_v1 read here was the 146 body although 147 replaces it. The ledger applies every unnumbered migration
// first, in its MIGRATION_MANIFEST.md row order (the last is row 119; migration 118 is row 120), then the numbered ones by migration number -- for the
// Economy candidate exactly scripts/economy139to146Preflight.js's CHAIN.
const numberOf = (x) => { const m = /_migration_(\d+)\.sql$/.exec(x); return m ? Number(m[1]) : null; };
const manifestRow = new Map();
for (const line of manifest.split("\n")) { const m = /^\|\s*(\d+)\s*\|[^|]*\|\s*([^|]+?\.sql)\s*\|/.exec(line); if (m) manifestRow.set(m[2].replace(/`/g, "").trim(), Number(m[1])); }
const applyKey = (x) => (numberOf(x) === null ? [0, manifestRow.has(x) ? manifestRow.get(x) : Infinity] : [1, numberOf(x)]);
const files = fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => x.endsWith(".sql") && !/ROLLBACK/.test(x))
  .sort((a, b) => { const ka = applyKey(a), kb = applyKey(b); return ka[0] - kb[0] || ka[1] - kb[1] || (a < b ? -1 : a > b ? 1 : 0); });
const { CHAIN: ECONOMY_CHAIN } = require("../scripts/economy139to146Preflight");
check("APPLY ORDER: every unnumbered migration has its manifest row (its place in the ledger), so none is ordered by guesswork", files.filter((x) => numberOf(x) === null).every((x) => manifestRow.has(x)), files.filter((x) => numberOf(x) === null && !manifestRow.has(x)).join(","));
check("APPLY ORDER: the Economy files are read in the preflight CHAIN order (" + ECONOMY_CHAIN.map((c) => c.n).join(" -> ") + "), not in file-name order",
  JSON.stringify(files.filter((x) => ECONOMY_CHAIN.some((c) => c.file === x))) === JSON.stringify(ECONOMY_CHAIN.map((c) => c.file)));
const latest = new Map();
for (const x of files) {
  const sql = x === FWD_FILE ? fwd : read("migrations/" + x);
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/g; let m;
  while ((m = re.exec(sql))) {
    const rest = sql.slice(m.index); const o = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest); if (!o) continue;
    const tag = o[1]; const bs = m.index + o.index + o[0].length; const e = sql.indexOf(tag, bs); if (e < 0) continue;
    latest.set(m[1], { file: x, body: sql.slice(bs, e) });
  }
}
const RS_JOIN = "JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'";
const carriers = [...latest].filter(([, v]) => v.body.includes(RS_JOIN)).map(([n]) => n).sort();
const LOCK_145 = "  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;\n  -- 145:END receipt_service_pointer_lock\n";
// POST-ASTRA F1 (migration 152) -- a FIFTH carrier: the post-close resolution fact reads the service open when it is recorded
// (resolution_service_session_id, provenance only -- it is never a receipt). It holds the pointer FOR SHARE (the close gate
// primitive) BEFORE that read, after its workspace / actor / [table] / order locks.
const LOCK_152 = "  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;\n";
const RESOLUTION_SELECT_152 = "  SELECT ss.id INTO v_resolution_service\n    FROM public.service_session_state sst\n    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'\n   WHERE sst.singleton = true;\n";
check("RECEIPT AUTHORITY INVENTORY: exactly five functions carry the receipt-service SELECT in their latest definition (the four receipt writers + the 152 post-close resolution fact)", JSON.stringify(carriers) === JSON.stringify(["mesa_post_payment_v1", "mesa_post_refund_v1", "order_post_close_obligation_resolution_v1", "order_post_payment_v1", "order_post_refund_v1"]), carriers.join(","));
check("order_post_close_obligation_resolution_v1 -> migration 152, the pointer FOR SHARE is taken BEFORE its open-service read (and before any service status it judges)",
  latest.has("order_post_close_obligation_resolution_v1") && /_migration_152\.sql$/.test(latest.get("order_post_close_obligation_resolution_v1").file)
  && (() => { const b = latest.get("order_post_close_obligation_resolution_v1").body; const l = b.indexOf(LOCK_152); const s = b.indexOf(RESOLUTION_SELECT_152); const st = b.indexOf("SELECT status INTO v_order_status"); return l > 0 && s > l && st > l && b.indexOf(LOCK_152, l + 1) === -1; })());
check("order_post_payment_v1 -> migration 148 (the 145 body + the legacy paid guard), FOR SHARE on the pointer immediately before the SELECT (145 lock)", latest.has("order_post_payment_v1") && /_migration_148\.sql$/.test(latest.get("order_post_payment_v1").file) && latest.get("order_post_payment_v1").body.includes(LOCK_145 + RECEIPT_SELECT));
check("mesa_post_payment_v1 -> migration 150 (the 145 body + the Mesa legacy paid guard, corrective slice), FOR SHARE on the pointer immediately before the SELECT (145 lock)", latest.has("mesa_post_payment_v1") && /_migration_150\.sql$/.test(latest.get("mesa_post_payment_v1").file) && latest.get("mesa_post_payment_v1").body.includes(LOCK_145 + RECEIPT_SELECT)
  && latest.get("mesa_post_payment_v1").body.includes("-- 150:BEGIN mesa_legacy_paid_ambiguity_guard\n") && latest.get("mesa_post_payment_v1").body.includes("-- 150:END mesa_legacy_paid_ambiguity_guard\n"));
check("order_post_refund_v1 -> migration 146, FOR SHARE on the pointer immediately before the SELECT (146 lock) + the typed refusal after it", latest.has("order_post_refund_v1") && latest.get("order_post_refund_v1").file === FWD_FILE && latest.get("order_post_refund_v1").body.includes(LOCK_BLOCK + RECEIPT_SELECT + REJECT_BLOCK));
const CANONICAL_ORDER_TOTAL_147 = /-- 147:BEGIN canonical_order_total\n[\s\S]*?public\.order_canonical_obligation_v1\(o\.order_uid\)[\s\S]*?-- 147:END canonical_order_total\n/;
check("mesa_post_refund_v1 -> migration 147 (the 146 body + the R2 canonical projection: the order total is order_canonical_obligation_v1), FOR SHARE on the pointer immediately before the SELECT (146 lock), no refusal",
  latest.has("mesa_post_refund_v1") && /_migration_147\.sql$/.test(latest.get("mesa_post_refund_v1").file) && CANONICAL_ORDER_TOTAL_147.test(latest.get("mesa_post_refund_v1").body)
  && ["canonical_mirror_projection", "canonical_table_total"].every((b) => latest.get("mesa_post_refund_v1").body.includes("-- 147:BEGIN " + b + "\n") && latest.get("mesa_post_refund_v1").body.includes("-- 147:END " + b + "\n"))
  && latest.get("mesa_post_refund_v1").body.includes(LOCK_BLOCK + RECEIPT_SELECT) && !latest.get("mesa_post_refund_v1").body.includes("ORDER_REFUND_NO_OPEN_SERVICE"),
  latest.has("mesa_post_refund_v1") ? latest.get("mesa_post_refund_v1").file : "absent");
check("NO residual carrier of the receipt SELECT is left unlocked (nothing allowlisted as an open finding)", carriers.every((n) => {
  const b = latest.get(n).body;
  if (n === "order_post_close_obligation_resolution_v1") { const l = b.indexOf(LOCK_152); const s = b.indexOf(RESOLUTION_SELECT_152); return l > 0 && s > l; }
  const i = b.indexOf(RECEIPT_SELECT); return i > 0 && (b.slice(0, i).endsWith(LOCK_145) || b.slice(0, i).endsWith(LOCK_BLOCK)); }));

console.log("\n── perimeter ──");
check("no dependency on, or mention of, M141 / M142 / Fiscal / period checkpoint / VeriFactu / consolidator in the CODE of either file", !/period_checkpoint|business_date_of_v1|fiscal|verifactu|consolidat|migration[_ ]14[12]\b/i.test(code(fwd) + code(rbk)));
check("the frozen writers are not the target of any DDL: the payment writers (145), close_service_session_v3, open_operational_service_v1, ensure_service_session, the intake resolver, operator_confirm, the rider stop, order_initial_payment_v1, order_cancel_v1, the 143 prelude",
  !/(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?(order_post_payment_v1|mesa_post_payment_v1|close_service_session_v3|open_operational_service_v1|ensure_service_session|resolve_order_intake_context_v1|operator_confirm_delivery_v1|rider_collect_and_complete_stop|order_initial_payment_v1|order_cancel_v1|order_intake_lock_prelude_v1)\b/i.test(code(fwd) + code(rbk)));
check("payment_transactions_scope_chk (M139) is not touched: no constraint text in either file's code", !/scope_chk|ADD\s+CONSTRAINT|DROP\s+CONSTRAINT/i.test(code(withoutBodies(fwd)) + code(withoutBodies(rbk))));

console.log("\n── manifest and frozen predecessors ──");
const row = (n) => (manifest.split(`| ${n} |`)[1] || "").split("\n")[0];
const r146 = row(146);
check("the manifest registers 146 as authored locally and NOT applied", /\| 146 \| FINDING B/.test(manifest) && /NOT APPLIED to staging/.test(r146) && /NOT COMMITTED/.test(r146));
check("the manifest row carries the sha256 of the forward and of the rollback file", r146.includes(sha256(fwd)) && r146.includes(sha256(rbk)));
check("the manifest row records the predecessor pins, the new pins, the prerequisite (143), the lineage (145), the rollback order, the off-service contract and LEDGER_BACKFILL_SAFE=UNPROVEN",
  r146.includes(PIN.order) && r146.includes(PIN.mesa) && r146.includes(NEW.order) && r146.includes(NEW.mesa) && /143/.test(r146) && /145/.test(r146) && /146 FIRST/.test(r146)
  && /ORDER_REFUND_NO_OPEN_SERVICE/.test(r146) && /ALLOWED_TABLE_SCOPED/.test(r146) && /LEDGER_BACKFILL_SAFE=UNPROVEN/.test(r146));
check("rows 143 / 144 / 145 are still present, in order, and 146 comes after them", /\| 143 \| C8/.test(manifest) && /\| 144 \| C8/.test(manifest) && /\| 145 \| FINDING A/.test(manifest) && manifest.indexOf("| 145 |") < manifest.indexOf("| 146 |"));
check("the frozen 143 / 144 / 145 files are byte-identical to what their manifest rows certify (sha256 of forward and rollback)",
  [["143", "2026-09-24_c8_order_intake_lock_prelude_v1_migration_143"], ["144", "2026-09-24_c8_order_cancel_w_first_v1_migration_144"], ["145", "2026-09-24_payment_close_receipt_lock_v1_migration_145"]]
    .every(([n, base]) => row(n).includes(sha256(read(`migrations/${base}.sql`))) && row(n).includes(sha256(read(`migrations/${base}.ROLLBACK.sql`)))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
