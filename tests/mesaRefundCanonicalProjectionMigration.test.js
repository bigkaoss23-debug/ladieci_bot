"use strict";
// tests/mesaRefundCanonicalProjectionMigration.test.js — static guard of migration 147 (R2: the Mesa refund projection on the canonical obligation).
// What this file proves from text alone:
//   * the 147 body is the 146 body with EXACTLY three marked blocks that REPLACE three regions; putting the 146 regions back yields the 146 body byte for byte;
//   * two blocks are the canonical expressions of mesa_post_payment_v1 (145 body) copied verbatim (the table total only renames its INTO target);
//     the third computes the per-order total with order_canonical_obligation_v1, as the payment writer does;
//   * no net_amount-based total survives; everything else of the refund writer (amounts, allocation, receipt, 146 lock, replay, refusals) is untouched;
//   * md5 pins == the bodies in the files; the rollback re-issues the 146 statement verbatim; guards, perimeter and numbering.
// Run: node tests/mesaRefundCanonicalProjectionMigration.test.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
let pass = 0; let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? `  -> ${String(detail).slice(0, 300)}` : ""}`); }
}
function statement(sql, head) {
  const i = sql.indexOf(head);
  if (i < 0 || sql.indexOf(head, i + 1) >= 0) throw new Error(`statement not found exactly once: ${head}`);
  const open = /AS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(i));
  const tag = open[1]; const bodyStart = i + open.index + open[0].length; const end = sql.indexOf(tag, bodyStart);
  return { text: sql.slice(i, end + tag.length) + ";", body: sql.slice(bodyStart, end), head: sql.slice(i, bodyStart) };
}
const count = (s, sub) => s.split(sub).length - 1;

const FWD_REL = "migrations/2026-09-25_mesa_refund_canonical_projection_v1_migration_147.sql";
const RBK_REL = "migrations/2026-09-25_mesa_refund_canonical_projection_v1_migration_147.ROLLBACK.sql";
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const s145 = read("migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.sql");
const s146 = read("migrations/2026-09-25_refund_close_receipt_lock_v1_migration_146.sql");
const HEAD = "CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1(";
const r146 = statement(s146, HEAD);
const r147 = statement(fwd, HEAD);
const pay = statement(s145, "CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(");

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist under migrations/ with number 147", fs.existsSync(path.join(ROOT, FWD_REL)) && fs.existsSync(path.join(ROOT, RBK_REL)));
check("ECONOMY NUMBERING: the migrations >= 140 are exactly the pairs 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156 (152-154 = the POST-ASTRA corrective cycle, 155-156 = the final liveness gate) (148 = the legacy paid guard, 149 = the R4B atomic close, 150 = the corrective slice, 151 = the final concurrency fix, after this one) -- 141 / 142 (Fiscal) are NOT in the Economy package",
  [...new Set(fs.readdirSync(path.join(ROOT, "migrations")).map((x) => (/_migration_(1[4-9]\d|[2-9]\d\d)\b/.exec(x) || [])[1]).filter(Boolean))].sort().join(",") === "140,143,144,145,146,147,148,149,150,151,152,153,154,155,156"
  && fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => /_migration_147\b/.test(x)).length === 2);
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));

console.log("\n── predecessors ──");
check("the 146 Mesa refund body is the pinned predecessor (md5 9679556f…)", md5(r146.body) === "9679556fe209fbadac5275b3ac71e456");
check("the 145 Mesa payment body (source of the copied expressions) is the pinned 94867e16…", md5(pay.body) === "94867e165d0732f36ae4692fc6998c58");
check("the 147 statement keeps the 146 header byte for byte (signature, RETURNS, LANGUAGE, search_path)", r147.head === r146.head);

console.log("\n── three blocks REPLACE three regions; putting the regions back yields the 146 body ──");
const blocks = [...r147.body.matchAll(/^[ \t]*-- 147:BEGIN ([a-z_]+)\n[\s\S]*?^[ \t]*-- 147:END \1\n/gm)];
check("exactly three 147 blocks, in body order canonical_order_total, canonical_mirror_projection, canonical_table_total",
  JSON.stringify(blocks.map((m) => m[1])) === JSON.stringify(["canonical_order_total", "canonical_mirror_projection", "canonical_table_total"]));
const R1_OLD = "    SELECT COALESCE(round(sum(net_amount)*100),0)::bigint INTO v_order_total_cents\n      FROM public.table_order_lines WHERE table_session_id=v_session.id AND order_id=v_order.order_id;\n";
const R2_END = "  WHERE o.id=calc.order_id AND o.table_session_id=v_session.id;\n";
const r2a = r146.body.indexOf("  UPDATE public.ordenes o SET\n    cobrado = calc.is_paid,\n");
const R2_OLD = r146.body.slice(r2a, r146.body.indexOf(R2_END, r2a) + R2_END.length);
const r3a = r146.body.indexOf("  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_table_total_cents\n");
const R3_OLD = r146.body.slice(r3a, r146.body.indexOf("\n", r146.body.indexOf("'CHIUSO_FORZATO')", r3a)) + 1); // language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal of the 146 region this test locates, not new vocabulary
check("the three predecessor regions exist exactly once in the 146 body", count(r146.body, R1_OLD) === 1 && r2a > 0 && count(r146.body, R2_OLD) === 1 && r3a > 0 && count(r146.body, R3_OLD) === 1);
let back = r147.body;
for (const [m, old] of blocks.map((b, i) => [b, [R1_OLD, R2_OLD, R3_OLD][i]])) back = back.replace(m[0], () => old);
check("replacing each 147 block by its 146 region gives the 146 body BYTE FOR BYTE (nothing else changed, the live mojibake bytes included)", back === r146.body);

console.log("\n── the blocks are the payment writer's canonical expressions ──");
const inner = (name) => { const m = blocks.find((b) => b[1] === name)[0]; return m.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"); };
const p2a = pay.body.indexOf("  UPDATE public.ordenes o SET\n    cobrado = calc.is_paid, ya_pagado = calc.is_paid,\n");
const PAY_MIRROR = pay.body.slice(p2a, pay.body.indexOf(R2_END, p2a) + R2_END.length);
const p3a = pay.body.indexOf("  SELECT COALESCE(round(sum(\n      CASE WHEN EXISTS (SELECT 1 FROM public.order_obligations ob WHERE ob.order_uid = o.order_uid)\n");
const P3_END = "   WHERE o.table_session_id = v_session.id AND o.order_uid IS NOT NULL;\n";
const PAY_TOTAL = pay.body.slice(p3a, pay.body.indexOf(P3_END, p3a) + P3_END.length);
check("canonical_mirror_projection == the 145 payment writer's cobrado / ya_pagado / metodo_pago UPDATE, verbatim", p2a > 0 && inner("canonical_mirror_projection") === PAY_MIRROR);
check("canonical_table_total == the 145 payment writer's table total, verbatim except INTO v_total_cents -> INTO v_table_total_cents",
  p3a > 0 && count(PAY_TOTAL, "    INTO v_total_cents\n") === 1 && inner("canonical_table_total") === PAY_TOTAL.replace("    INTO v_total_cents\n", "    INTO v_table_total_cents\n"));
check("canonical_order_total reads order_canonical_obligation_v1 of THIS table's order (the payment writer's per-order total), never net_amount",
  /v_order_total_cents := COALESCE\(\(\n\s+SELECT round\(public\.order_canonical_obligation_v1\(o\.order_uid\) \* 100\)::bigint\n\s+FROM public\.ordenes o WHERE o\.id = v_order\.order_id AND o\.table_session_id = v_session\.id\), 0\);/.test(inner("canonical_order_total"))
  && pay.body.includes("v_order_total_cents := round(public.order_canonical_obligation_v1(v_order.order_uid) * 100)::bigint;"));
check("no net_amount-based total survives (per-order, table, projection)", !/sum\(net_amount\)|sum\(l\.net_amount\)/.test(r147.body));
check("the refund state rule itself is unchanged (unpaid / paid / partially_paid on the new total)",
  r147.body.includes("WHEN v_new_paid_cents <= 0 THEN 'unpaid'") && r147.body.includes("WHEN v_new_paid_cents >= v_order_total_cents THEN 'paid'"));
check("the 146 pointer-lock block is still present exactly once", count(r147.body, "-- 146:BEGIN refund_receipt_pointer_lock") === 1 && count(r147.body, "-- 146:END refund_receipt_pointer_lock") === 1);

console.log("\n── md5 pins == the bodies in the files ──");
const pin = md5(r147.body);
const fwdPost = /IF md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})' THEN\n\s+RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION post-condition failed: mesa_post_refund_v1 is not the expected 147 body/.exec(fwd);
check("forward post-condition pin == md5 of the 147 body in the file", !!fwdPost && fwdPost[1] === pin, fwdPost && fwdPost[1]);
check("forward guard pins the 146 predecessor 9679556f… and the 145 payment body 94867e16…",
  fwd.includes("IF md5(v_src) IS DISTINCT FROM '9679556fe209fbadac5275b3ac71e456' THEN") && fwd.includes("IS DISTINCT FROM '94867e165d0732f36ae4692fc6998c58' THEN"));
const rbkGuard = /IF md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})' THEN\n\s+RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION rollback refused/.exec(rbk);
check("rollback guard pin == md5 of the 147 body", !!rbkGuard && rbkGuard[1] === pin);
check("rollback re-issues the 146 statement VERBATIM and post-checks the 146 pin", rbk.includes(r146.text) && rbk.includes("IS DISTINCT FROM '9679556fe209fbadac5275b3ac71e456' THEN"));
check("both files carry the UTF-8 transport guard of the embedded live bytes", (fwd.match(/octet_length\('¬ß'\) <> 4/g) || []).length === 1 && (rbk.match(/octet_length\('¬ß'\) <> 4/g) || []).length === 1);
check("forward refuses a second application (147 marker) and requires order_canonical_obligation_v1(uuid)",
  fwd.includes("position('-- 147:BEGIN ' IN v_src) > 0") && fwd.includes("to_regprocedure('public.order_canonical_obligation_v1(uuid)') IS NULL"));

console.log("\n── perimeter ──");
const ddl = fwd.replace(/--[^\n]*/g, "").replace(/AS \$function\$[\s\S]*?\$function\$;/g, "");
check("exactly ONE function definition (mesa_post_refund_v1), no other CREATE FUNCTION", (fwd.match(/CREATE (OR REPLACE )?FUNCTION/g) || []).length === 1);
check("no table / trigger / constraint / index / grant DDL and no data DML outside the function body",
  !/\b(ALTER|DROP) (TABLE|TRIGGER|INDEX|FUNCTION)\b|\bCREATE (TRIGGER|INDEX|UNIQUE)\b|\b(GRANT|REVOKE)\b/.test(ddl) && !/^\s*(UPDATE|DELETE FROM|INSERT INTO)\s+public\./m.test(ddl));
check("the post-conditions prove every other function unchanged and the writer posture (owner / SECURITY / search_path / ACL / args / return) unchanged",
  fwd.includes("other functions changed") && fwd.includes("owner / SECURITY / search_path / ACL / signature / return of mesa_post_refund_v1 changed"));
check("order_post_refund_v1 (the check-centric refund) is not touched", !fwd.includes("CREATE OR REPLACE FUNCTION public.order_post_refund_v1("));

console.log("\n── manifest ──");
const manifest = read("migrations/MIGRATION_MANIFEST.md");
const row = (manifest.split("| 147 |")[1] || "").split("\n")[0];
const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
check("MIGRATION_MANIFEST.md row 147 carries the forward and rollback sha256", row.includes(sha(FWD_REL)) && row.includes(sha(RBK_REL)));

console.log(`\nmesaRefundCanonicalProjectionMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
