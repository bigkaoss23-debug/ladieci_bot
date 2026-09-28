"use strict";
// tests/legacyPaidAmbiguityPaymentGuardMigration.test.js — static guard of migration 148 (the legacy paid ambiguity payment guard).
// What this file proves from text alone:
//   * the 148 body is the 145 order_post_payment_v1 body with EXACTLY ONE marked block inserted right after the ORDER_PAYMENT_ALREADY_SETTLED gate;
//     removing the block yields the 145 body byte for byte;
//   * the block refuses (cobrado OR ya_pagado) -- reached only with a positive canonical outstanding -- with its OWN typed code
//     ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED (SQLSTATE 55000), never ORDER_PAYMENT_ALREADY_SETTLED, BEFORE any payment fact and without writing;
//   * the idempotent replay still returns before the guard; the guard takes no lock;
//   * the two wrappers whose 55000 handling the guard relies on (139 operator_confirm_delivery_v1, 140 rider_collect_and_complete_stop) turn it into a
//     typed PAYMENT_REFUSED and tolerate ONLY ORDER_PAYMENT_ALREADY_SETTLED; Cash V1 surfaces the ORDER_* code typed;
//   * md5 pins == the bodies in the files (new body e1ce2229…); the rollback re-issues the 145 statement verbatim; guards, perimeter, numbering, manifest;
//   * the frozen 139 – 147 files are byte-identical to their certified sha256.
// Run: node tests/legacyPaidAmbiguityPaymentGuardMigration.test.js

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
const code = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

const FWD_REL = "migrations/2026-09-25_legacy_paid_ambiguity_payment_guard_v1_migration_148.sql";
const RBK_REL = "migrations/2026-09-25_legacy_paid_ambiguity_payment_guard_v1_migration_148.ROLLBACK.sql";
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const s145 = read("migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.sql");
const s139 = read("migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql");
const s140 = read("migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql");
const HEAD = "CREATE OR REPLACE FUNCTION public.order_post_payment_v1(";
const p145 = statement(s145, HEAD);
const p148 = statement(fwd, HEAD);
const PRED = "799f8093328b4ac81e1ad5a3d37e1bb6";
const ANCHOR = "  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'ORDER_PAYMENT_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;\n";

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist under migrations/ with number 148 (and 148 is used by exactly this pair)",
  fs.existsSync(path.join(ROOT, FWD_REL)) && fs.existsSync(path.join(ROOT, RBK_REL))
  && fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => /_migration_148\b/.test(x)).sort().join(",") === [FWD_REL, RBK_REL].map((f) => path.basename(f)).sort().join(","));
check("ECONOMY NUMBERING: the migrations >= 140 are exactly the pairs 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156 (152-154 = the POST-ASTRA corrective cycle, 155-156 = the final liveness gate) (149 = the R4B atomic close, 150 = the corrective slice, 151 = the final concurrency fix, after this one) -- 141 / 142 (Fiscal) are NOT in the Economy package",
  [...new Set(fs.readdirSync(path.join(ROOT, "migrations")).map((x) => (/_migration_(1[4-9]\d|[2-9]\d\d)\b/.exec(x) || [])[1]).filter(Boolean))].sort().join(",") === "140,143,144,145,146,147,148,149,150,151,152,153,154,155,156"
  && !fs.readdirSync(path.join(ROOT, "migrations")).some((x) => /_migration_14[12]\b/.test(x)));
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));

console.log("\n── predecessor and the single inserted block ──");
check("the 145 order_post_payment_v1 body is the pinned predecessor (md5 799f8093…)", md5(p145.body) === PRED);
check("the 148 statement keeps the 145 header byte for byte (signature, defaults, RETURNS, LANGUAGE, search_path)", p148.head === p145.head);
const blocks = [...p148.body.matchAll(/^[ \t]*-- 148:BEGIN ([a-z_]+)\n[\s\S]*?^[ \t]*-- 148:END \1\n/gm)];
check("exactly ONE 148 block, legacy_paid_ambiguity_guard", blocks.length === 1 && blocks[0][1] === "legacy_paid_ambiguity_guard" && count(p148.body, "-- 148:BEGIN ") === 1);
check("removing the block gives the 145 body BYTE FOR BYTE (nothing else changed)", blocks.length === 1 && p148.body.replace(blocks[0][0], () => "") === p145.body);
check("the block sits IMMEDIATELY after the ORDER_PAYMENT_ALREADY_SETTLED gate (so it only ever runs with outstanding > 0)",
  count(p145.body, ANCHOR) === 1 && blocks.length === 1 && p148.body.includes(ANCHOR + blocks[0][0]));
const blk = blocks.length ? code(blocks[0][0]) : "";
check("the guard condition is exactly (cobrado OR ya_pagado) on the row locked FOR UPDATE (v_ord), nothing else",
  /\n  IF v_ord\.cobrado IS TRUE OR v_ord\.ya_pagado IS TRUE THEN\n/.test("\n" + blk) && (blk.match(/\bIF\b/g) || []).length === 2 /* IF + END IF */);
check("it raises its OWN typed code ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED with SQLSTATE 55000 -- never ORDER_PAYMENT_ALREADY_SETTLED",
  /RAISE EXCEPTION 'ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED' USING ERRCODE='55000'/.test(blk) && !/ALREADY_SETTLED/.test(blk));
check("the block writes nothing and locks nothing (no INSERT / UPDATE / DELETE / PERFORM / SELECT … FOR, no set_config)",
  !/\b(INSERT|UPDATE|DELETE|PERFORM|FOR UPDATE|FOR SHARE|set_config)\b/i.test(blk));
const at = (s) => p148.body.indexOf(s);
check("ORDER: idempotent replay < Mesa exclusion < ordenes FOR UPDATE < cancelled gate < outstanding < ALREADY_SETTLED < 148 guard < amount < duplicate window < 145 pointer lock < payment INSERT",
  [ "WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;", "'ORDER_PAYMENT_NOT_FOR_TABLE_ORDER'", "SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;",
    "'ORDER_PAYMENT_ORDER_CANCELLED'", "v_outstanding_cents := GREATEST(0, v_obligation_cents - v_paid_before_cents);", ANCHOR, "-- 148:BEGIN legacy_paid_ambiguity_guard",
    "'ORDER_PAYMENT_AMOUNT_INVALID'", "'ORDER_PAYMENT_POSSIBLE_DUPLICATE'", "-- 145:BEGIN receipt_service_pointer_lock", "INSERT INTO public.payment_transactions(" ]
    .map(at).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));
check("the 139 / 140 / 145 blocks of the predecessor are all still present exactly once",
  ["-- 139:BEGIN off_service_receipt", "-- 140:BEGIN rider_delivery_attestation", "-- 145:BEGIN receipt_service_pointer_lock"].every((m) => count(p148.body, m) === 1));

console.log("\n── propagation through the real wrappers ──");
const op = statement(s139, "CREATE FUNCTION public.operator_confirm_delivery_v1(");
check("the pinned operator_confirm_delivery_v1 body is the 139 one (md5 bedbfc46…)", md5(op.body) === "bedbfc46ca7e385220c2ea4531064c62");
check("operator_confirm_delivery_v1 catches 55000, tolerates ONLY ORDER_PAYMENT_ALREADY_SETTLED and returns PAYMENT_REFUSED + payment_code before confirming",
  /EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '42501' OR SQLSTATE '23505' OR SQLSTATE '55000' THEN/.test(op.body)
  && /IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN\n\s+RETURN jsonb_build_object\('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note\);/.test(op.body)
  && op.body.indexOf("'PAYMENT_REFUSED'") < op.body.indexOf("SET estado       = 'RETIRADO'"));
const riderBody = statement(s140, "CREATE FUNCTION public.rider_collect_and_complete_stop(").body;
check("the pinned rider_collect_and_complete_stop body is the 140 one (md5 ef3d4230…)", md5(riderBody) === "ef3d423028b2d4d823359264bc5cfadc", md5(riderBody));
check("rider_collect_and_complete_stop catches 55000 at both call sites, tolerates ONLY ALREADY_SETTLED and returns PAYMENT_REFUSED before completing the stop",
  count(riderBody, "EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '42501' OR SQLSTATE '23505' OR SQLSTATE '55000' THEN") === 2
  && count(riderBody, "IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN") === 2
  && riderBody.lastIndexOf("'PAYMENT_REFUSED'") < riderBody.indexOf("SET estado       = 'RETIRADO'"));
check("Cash V1 (cashHttpHandlers.safeError) admits any ORDER_* code typed (no 500 collapse)",
  /\/\^\(CASH\|ORDER\|MESA\)_\[A-Z0-9_\]\+\$\//.test(read("src/cash/cashHttpHandlers.js")));

console.log("\n── md5 pins == the bodies in the files ──");
const pin = md5(p148.body);
check("the 148 body is the certified one (md5 e1ce2229…)", pin === "e1ce2229f2418d6a7f91fe50771564f8", pin);
const fwdPost = /IF md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})' THEN\n\s+RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD post-condition failed: order_post_payment_v1 is not the expected 148 body/.exec(fwd);
check("forward post-condition pin == md5 of the 148 body in the file", !!fwdPost && fwdPost[1] === pin, fwdPost && fwdPost[1]);
check("forward guard refuses a missing writer and an unexpected overload set before reading the body",
  fwd.includes("order_post_payment_v1 is missing -- resolve drift first") && fwd.includes("order_post_payment_v1 has an unexpected overload set -- resolve drift first"));
check("forward guard pins the 145 predecessor 799f8093… and refuses a second application",
  fwd.includes(`IF md5(v_src) IS DISTINCT FROM '${PRED}' THEN`) && fwd.includes("position('-- 148:BEGIN ' IN v_src) > 0"));
check("forward guard pins the two wrapper bodies whose 55000 handling it relies on (139 bedbfc46…, 140 ef3d4230…)",
  fwd.includes("IS DISTINCT FROM 'bedbfc46ca7e385220c2ea4531064c62' THEN") && fwd.includes("IS DISTINCT FROM 'ef3d423028b2d4d823359264bc5cfadc' THEN"));
const rbkGuard = /IF md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})' THEN\n\s+RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD rollback refused/.exec(rbk);
check("rollback guard pin == md5 of the 148 body", !!rbkGuard && rbkGuard[1] === pin);
check("rollback guard refuses a missing or overloaded writer", rbk.includes("order_post_payment_v1 is missing or overloaded -- resolve drift first"));
check("rollback re-issues the 145 statement VERBATIM and post-checks the 145 pin", rbk.includes(p145.text) && rbk.includes(`IS DISTINCT FROM '${PRED}' THEN`));
check("both files carry the UTF-8 transport guard of the embedded body bytes (§ and — are in the 145 body)",
  (fwd.match(/octet_length\('§—'\) <> 5/g) || []).length === 1 && (rbk.match(/octet_length\('§—'\) <> 5/g) || []).length === 1);

console.log("\n── perimeter ──");
const ddl = fwd.replace(/--[^\n]*/g, "").replace(/AS \$function\$[\s\S]*?\$function\$;/g, "");
check("exactly ONE function definition (order_post_payment_v1), no other CREATE FUNCTION", (fwd.match(/CREATE (OR REPLACE )?FUNCTION/g) || []).length === 1);
check("no table / trigger / constraint / index / grant DDL and no data DML outside the function body",
  !/\b(ALTER|DROP) (TABLE|TRIGGER|INDEX|FUNCTION)\b|\bCREATE (TRIGGER|INDEX|UNIQUE)\b|\b(GRANT|REVOKE)\b/.test(ddl) && !/^\s*(UPDATE|DELETE FROM|INSERT INTO)\s+public\./m.test(ddl));
const rddl = rbk.replace(/--[^\n]*/g, "").replace(/AS \$function\$[\s\S]*?\$function\$;/g, "");
check("the rollback is exactly ONE function definition (order_post_payment_v1) and no other DDL / DML",
  (rbk.match(/CREATE (OR REPLACE )?FUNCTION/g) || []).length === 1 && rbk.includes(HEAD)
  && !/\b(ALTER|DROP) (TABLE|TRIGGER|INDEX|FUNCTION)\b|\bCREATE (TRIGGER|INDEX|UNIQUE)\b|\b(GRANT|REVOKE)\b/.test(rddl) && !/^\s*(UPDATE|DELETE FROM|INSERT INTO)\s+public\./m.test(rddl));
check("no ledger registration inside the files (registration stays a separate statement)", !/ladieci_schema_migrations/.test(code(fwd) + code(rbk)));
check("the post-conditions prove every other function unchanged and the writer posture unchanged",
  fwd.includes("other functions changed") && fwd.includes("owner / SECURITY / search_path / ACL / signature / return of order_post_payment_v1 changed"));

console.log("\n── manifest ──");
const manifest = read("migrations/MIGRATION_MANIFEST.md");
const row = (manifest.split("| 148 |")[1] || "").split("\n")[0];
const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
check("MIGRATION_MANIFEST.md row 148 carries the forward and rollback sha256", row.includes(sha(FWD_REL)) && row.includes(sha(RBK_REL)));

console.log("\n── the frozen 139 – 147 files are unchanged ──");
const FROZEN = {
  "2026-09-19_delivery_economy_decoupling_v1_migration_139.sql": "161cde6ff479057c40b04dc94ea9cbb7a26811d5ce9b818d84b344fc7c4d5750",
  "2026-09-19_delivery_economy_decoupling_v1_migration_139.ROLLBACK.sql": "96774be3a888b719370662aded9edf57a02d1cb06fc13f12cb009c4baff93806",
  "2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql": "1f36e395649d6ef665c762d9afb8dfe12cfa7ca1a47052fe178e361894113dfd",
  "2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.ROLLBACK.sql": "490e5d6bc577116974a993035e13a5d056178753337a2e2c9363fee0f139350f",
  "2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql": "1da70b2357f34d9a4c259f38766ec6d6c6996a170f49d0b63853a826539c3677",
  "2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql": "ff3a992a86f5e21c12278798edcff3ed597f55077042c13ad314bc8ecf49245d",
  "2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql": "e0a56b4765e4d849b274217326681ba56d338837e1dd53cbf213a01f104ee7cb",
  "2026-09-24_c8_order_cancel_w_first_v1_migration_144.ROLLBACK.sql": "6eb0743b2fc9df6b6b71635146b0935432b8592dfb1dd05839baaee9a86cffe7",
  "2026-09-24_payment_close_receipt_lock_v1_migration_145.sql": "138160b7d962a1d0a7dade69e6f90db4246829f5b7725cba5015b3ec25b5f32f",
  "2026-09-24_payment_close_receipt_lock_v1_migration_145.ROLLBACK.sql": "345824cb3139de3dcc927e131ecf32c818da81558a64badd55232d1ea69f8f84",
  "2026-09-25_refund_close_receipt_lock_v1_migration_146.sql": "64f11dc5f5c487153a19630254b92e1391d62655705de4a9819c85660e74d5a7",
  "2026-09-25_refund_close_receipt_lock_v1_migration_146.ROLLBACK.sql": "a6e3989725fdd369ade491d78025c062e8f6c3fb8876cd5b18e87f7c4ad8f381",
  "2026-09-25_mesa_refund_canonical_projection_v1_migration_147.sql": "f4710bc023710d7ae1f4ffc28cff850262ce6d6afd7bc8cc4673c8dcb027b0b2",
  "2026-09-25_mesa_refund_canonical_projection_v1_migration_147.ROLLBACK.sql": "7fe358a211ba71005d626d2be3d020a1fa2b0b74f0bae27b7a67ae37d2ab4838",
};
const drift = Object.entries(FROZEN).filter(([f, h]) => !fs.existsSync(path.join(ROOT, "migrations", f)) || sha("migrations/" + f) !== h).map(([f]) => f);
check("the 14 files of 139, 140, 143, 144, 145, 146, 147 are byte-identical to their certified sha256 (148 changes nothing before it)", drift.length === 0, drift.join(", "));

console.log(`\nlegacyPaidAmbiguityPaymentGuardMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
