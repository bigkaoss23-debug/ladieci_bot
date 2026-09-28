// tests/economyFinalLivenessGateMigrations.test.js — static guard of the ECONOMY FINAL LIVENESS GATE pair of migrations:
//   155  2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155  (N2: the Planner takes the order_entities / auth_actors
//        KEY SHARE before its order lock L4, the money writers' order; four bodies = predecessor + marked 155 blocks only)
//   156  2026-09-27_close_gate_on_window_facts_v1_migration_156  (bounded F2 residual: every insert of a day-window fact takes the close
//        gate, the lifecycle pointer FOR SHARE, through ONE trigger function on order_financial_events and cash_counts)
// The behaviour (N2 reproduced before / absent after, the F2 TOCTOU reproduced before / serialized after, the Planner W3 / W5 / W6
// regression, apply / rollback / double apply / wrong predecessor) is certified on PostgreSQL 17 by the gate lab
// (~/Downloads/ECONOMY_FINAL_LIVENESS_GATE_REPORT_2026-09-27.md); this file proves what text can.
// It is also the static guard tests/giroAuthorityW3Candidate.static.test.js requires before it admits 155 / 156 as giro_authority
// references.
// Run: node tests/economyFinalLivenessGateMigrations.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const code = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}
// every CREATE [OR REPLACE] FUNCTION public.<name>(...) ... AS $tag$ <body> $tag$ of a file: { name: { head, body } }
function functions(sql) {
  const res = {}; const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-zA-Z0-9_]+)\s*\(/g; let m;
  while ((m = re.exec(sql))) {
    const rest = sql.slice(m.index); const o = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest); if (!o) continue;
    const bs = m.index + o.index + o[0].length; const e = sql.indexOf(o[1], bs);
    res[m[1]] = { head: rest.slice(0, o.index), body: sql.slice(bs, e) };
  }
  return res;
}

const F155 = "migrations/2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.sql";
const R155 = F155.replace(/\.sql$/, ".ROLLBACK.sql");
const F156 = "migrations/2026-09-27_close_gate_on_window_facts_v1_migration_156.sql";
const R156 = F156.replace(/\.sql$/, ".ROLLBACK.sql");

console.log("\n── files ──");
check("the 155 and 156 forward + rollback files exist", [F155, R155, F156, R156].every((f) => fs.existsSync(path.join(ROOT, f))));
const f155 = read(F155), r155 = read(R155), f156 = read(F156), r156 = read(R156);
check("each of the four files runs in ONE transaction (BEGIN ... COMMIT)", [f155, r155, f156, r156].every((s) => /\nBEGIN;\n/.test(s) && /\nCOMMIT;\n$/.test(s)));
const manifest = read("migrations/MIGRATION_MANIFEST.md");
check("the manifest registers 155 and 156 as authored locally and NOT applied",
  /\| 155 \| ECONOMY FINAL LIVENESS GATE/.test(manifest) && /\| 156 \| ECONOMY FINAL LIVENESS GATE/.test(manifest)
  && /NOT APPLIED to staging/.test(manifest.split("| 155 |")[1].split("\n")[0]) && /NOT APPLIED to staging/.test(manifest.split("| 156 |")[1].split("\n")[0]));

console.log("\n── 155: the four Planner bodies = their predecessors + the marked 155 blocks only ──");
const PINS = {
  start_rider_trip_v2: { sig: "(uuid,text,integer,uuid[])", from: "0323fbb1bab76a12fd2be3fed0b3187e", to: "baa7e42e28b15565e93f5da66374a6a9", blocks: ["actor_key_share", "entity_key_share"] },
  giro_authority_create_or_move_v1: { sig: "(uuid[],text,uuid,text,uuid[])", from: "e4966ba63a075f6914c26d6508cfef00", to: "b5823fc5417a92007295efe531a899f0", blocks: ["entity_key_share"] },
  giro_authority_attach_or_move_v1: { sig: "(text,uuid,text,uuid[])", from: "85fb8a84ed311edfa02c11a4c7f9afec", to: "4f39a046a0c4f04ef4ea5cc548328f03", blocks: ["entity_key_share"] },
  giro_authority_consume_intent_v1: { sig: "(uuid,text,uuid[])", from: "3dde47553cc347d097735df8ba7ca5aa", to: "2a59a168d43c398d9e34d3ae651d1ea4", blocks: ["entity_key_share"] },
};
const fwd = functions(f155), rbk = functions(r155);
check("155 (and its rollback) define EXACTLY the four Planner functions, nothing else",
  JSON.stringify(Object.keys(fwd).sort()) === JSON.stringify(Object.keys(PINS).sort()) && JSON.stringify(Object.keys(rbk).sort()) === JSON.stringify(Object.keys(PINS).sort()),
  Object.keys(fwd).join(","));
const BLOCK_RE = /\n[ \t]*-- 155:BEGIN ([a-z_]+)\n[\s\S]*?\n[ \t]*-- 155:END \1(?=\n)/g;
for (const [n, p] of Object.entries(PINS)) {
  const a = fwd[n], b = rbk[n];
  check(`${n}: forward body md5 = ${p.to.slice(0, 8)}..., rollback body md5 = the predecessor ${p.from.slice(0, 8)}...`, !!a && !!b && md5(a.body) === p.to && md5(b.body) === p.from);
  check(`${n}: the forward body with its 155 blocks removed is byte-identical to the predecessor body; the blocks are exactly ${p.blocks.join(" + ")}`,
    !!a && !!b && a.body.replace(BLOCK_RE, "") === b.body && JSON.stringify([...a.body.matchAll(BLOCK_RE)].map((x) => x[1])) === JSON.stringify(p.blocks));
  check(`${n}: signature, language, SECURITY DEFINER and search_path unchanged (identical CREATE header)`, !!a && !!b && a.head === b.head && /SECURITY DEFINER/.test(a.head) && /search_path TO 'pg_catalog', 'pg_temp'/.test(a.head));
  const blocks = [...(a ? a.body.matchAll(BLOCK_RE) : [])].map((x) => code(x[0]).trim());
  check(`${n}: each 155 block is ONE PERFORM ... FOR KEY SHARE (no write, no other lock mode, no advisory lock)`,
    blocks.length === p.blocks.length && blocks.every((s) => /^PERFORM 1 FROM public\.(order_entities e\s+WHERE [^;]*|auth_actors a WHERE a\.actor = p_actor) FOR KEY SHARE;$/.test(s.replace(/\s+/g, " ").replace(/ ORDER BY e\.order_uid FOR KEY SHARE;$/, " FOR KEY SHARE;"))),
    JSON.stringify(blocks));
  const endIdx = a ? a.body.indexOf("-- 155:END entity_key_share") : -1;
  const next = a ? a.body.slice(endIdx).split("\n")[1] : "";
  check(`${n}: the entity KEY SHARE is taken immediately BEFORE the order lock L4 (the next statement locks public.ordenes FOR SHARE), and no ordenes row lock precedes it`,
    endIdx > 0 && /^\s*PERFORM 1 FROM public\.ordenes o\b/.test(next) && !/FROM public\.ordenes o\b[^;]*FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/.test(code(a.body.slice(0, endIdx))));
  check(`${n}: multi-order entity KEY SHARE is taken in ascending order_uid (the money writers' order)`,
    !!a && [...a.body.matchAll(BLOCK_RE)].filter((x) => x[1] === "entity_key_share").every((x) => /= p_order_uid FOR KEY SHARE;/.test(x[0]) || /ORDER BY e\.order_uid FOR KEY SHARE;/.test(x[0])));
}
check("start_rider_trip_v2: the actor KEY SHARE precedes the entity KEY SHARE (auth_actors before order_entities, as in the money writers)",
  fwd.start_rider_trip_v2 && fwd.start_rider_trip_v2.body.indexOf("-- 155:BEGIN actor_key_share") < fwd.start_rider_trip_v2.body.indexOf("-- 155:BEGIN entity_key_share"));
const c155 = code(f155);
check("155 touches no money writer, no table, trigger, grant or constraint (only the four CREATE OR REPLACE statements and its DO blocks)",
  !/FUNCTION\s+public\.(order_post_payment_v1|order_post_refund_v1|order_cancel_v1|mesa_post_payment_v1|mesa_post_refund_v1|order_apply_commercial_adjustment_v1|mesa_post_commercial_adjustment_v1|order_post_close_obligation_resolution_v1|order_apply_editor_patch_v1)\b/.test(c155)
  && !/\b(CREATE|ALTER|DROP)\s+(TABLE|TRIGGER|INDEX|POLICY)\b|\bGRANT\b|\bREVOKE\b|\bADD CONSTRAINT\b|\bINSERT INTO\b|\bUPDATE public\.(?!ordenes\b)|\bDELETE FROM\b/.test(c155.replace(/\$function\$[\s\S]*?\$function\$/g, "")));
check("155 guards on the 151 .. 154 bodies and on the four predecessor bodies, refuses a double apply, and never overwrites a divergent body",
  ["c57584ba03c40ee940e402188fd40d2d", "f637aa2eaa3baec55bf7e88332d3d345", "d79f71a2a40350307493ea1807b5fa77", "d5f962866a565fe63eb0842124829cfe", "3c8c4c46dac20285081b85a3313ef576", "2c411d98f63545c4a4b7d04fd9beb7fe", "bfac4ec3f428daa91d5d9505d8b1285a"].every((h) => c155.includes(h))
  && Object.values(PINS).every((p) => c155.includes(`IS DISTINCT FROM '${p.from}'`)) && /refused: already applied/.test(c155) && (c155.match(/a divergent body is never overwritten/g) || []).length === 4);
check("155 post-conditions: the four 155 pins, SECURITY DEFINER owned by postgres, EXECUTE for service_role only (not anon / authenticated), 151 .. 154 unchanged",
  Object.entries(PINS).every(([n, p]) => c155.includes(`to_regprocedure('public.${n}${p.sig}')) IS DISTINCT FROM '${p.to}'`) && c155.includes(`has_function_privilege('service_role', 'public.${n}${p.sig}', 'EXECUTE')`) && c155.includes(`has_function_privilege('anon', 'public.${n}${p.sig}', 'EXECUTE')`))
  && /post-condition failed: a 151 \.\. 154 body changed/.test(c155));
const cr155 = code(r155);
check("the 155 rollback is refused unless the four 155 bodies are installed, restores the predecessor pins and re-checks them",
  Object.entries(PINS).every(([n, p]) => cr155.includes(p.to) && cr155.includes(p.from)) && (cr155.match(/rollback refused: [a-z_0-9]+ is not the migration 155 body/g) || []).length === 4);
check("create_v1 / attach_v1 (unreachable from production code, documented residual) are NOT touched by 155", !/giro_authority_(create|attach)_v1\s*\(/.test(c155));

console.log("\n── 156: the close gate on the window fact inserts ──");
const fn156 = functions(f156);
check("156 defines EXACTLY ONE function, close_gate_window_fact_insert_v1(), SECURITY DEFINER, md5 6ed381c0...",
  JSON.stringify(Object.keys(fn156)) === '["close_gate_window_fact_insert_v1"]' && md5(fn156.close_gate_window_fact_insert_v1.body) === "6ed381c0bcfa60fb48250c5dbb63ef2c" && /RETURNS trigger/.test(fn156.close_gate_window_fact_insert_v1.head) && /SECURITY DEFINER/.test(fn156.close_gate_window_fact_insert_v1.head));
check("its body takes ONLY the lifecycle pointer FOR SHARE (the close gate of the money writers) and returns NEW unchanged",
  code(fn156.close_gate_window_fact_insert_v1.body).replace(/\s+/g, " ").trim() === "BEGIN PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE; RETURN NEW; END");
check("EXECUTE is revoked from PUBLIC, anon and authenticated", /REVOKE ALL ON FUNCTION public\.close_gate_window_fact_insert_v1\(\) FROM PUBLIC, anon, authenticated;/.test(f156));
const trg = (f156.match(/^CREATE TRIGGER .*$/gm) || []);
check("exactly TWO triggers, BEFORE INSERT FOR EACH ROW, named a0_close_gate_window_fact_v1, on order_financial_events and cash_counts",
  JSON.stringify(trg) === JSON.stringify([
    "CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.order_financial_events FOR EACH ROW EXECUTE FUNCTION public.close_gate_window_fact_insert_v1();",
    "CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.cash_counts FOR EACH ROW EXECUTE FUNCTION public.close_gate_window_fact_insert_v1();",
  ]) || JSON.stringify(trg.map((t) => t.replace(/FUNCTION public\./, "FUNCTION "))) === JSON.stringify([
    "CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.order_financial_events FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1();",
    "CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.cash_counts FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1();",
  ]), JSON.stringify(trg));
const c156 = code(f156);
check("156 changes nothing else: no table / column / constraint / grant change on existing objects, no data change, no other function",
  !/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|POLICY)\b|\bADD CONSTRAINT\b|\bGRANT\b|\bINSERT INTO\b|\bUPDATE public\.|\bDELETE FROM\b|CREATE OR REPLACE FUNCTION/.test(c156.replace(/\$function\$[\s\S]*?\$function\$/g, "")));
check("156 guards on 154 (c57584ba... / f637aa2e...) and on the four 155 bodies, and refuses a double apply",
  ["c57584ba03c40ee940e402188fd40d2d", "f637aa2eaa3baec55bf7e88332d3d345", ...Object.values(PINS).map((p) => p.to)].every((h) => c156.includes(h)) && /already applied/.test(c156));
check("156 references giro_authority ONLY in its guard and post-condition (the names of the 155 bodies it pins), never in the function or the triggers",
  (c156.match(/giro_authority/g) || []).length > 0
  && (c156.match(/giro_authority/g) || []).length === ((c156.split("$guard$")[1] || "").match(/giro_authority/g) || []).length + ((c156.split("$post$")[1] || "").match(/giro_authority/g) || []).length
  && !/giro_authority/.test(fn156.close_gate_window_fact_insert_v1.body) && !trg.some((t) => /giro_authority/.test(t)));
check("156 post-conditions re-check the function pin and both trigger definitions exactly", /6ed381c0bcfa60fb48250c5dbb63ef2c/.test(c156.split("$post$")[1] || "") && (c156.split("$post$")[1] || "").includes("pg_get_triggerdef"));
const cr156 = code(r156);
check("the 156 rollback drops exactly the two triggers and the function (nothing else) and verifies they are gone",
  (cr156.match(/^DROP .*$/gm) || []).join("\n") === "DROP TRIGGER a0_close_gate_window_fact_v1 ON public.order_financial_events;\nDROP TRIGGER a0_close_gate_window_fact_v1 ON public.cash_counts;\nDROP FUNCTION public.close_gate_window_fact_insert_v1();"
  && /\$post\$/.test(cr156) && !/giro_authority|CREATE /.test(cr156));

console.log("\n── perimeter ──");
check("no Fiscal / VeriFactu dependency in 155 / 156", ![f155, r155, f156, r156].some((s) => /period_checkpoint|business_date_of_v1|verifactu|migration_14[12]\b/i.test(code(s))));
check("155 / 156 reference no food-ops-core object", ![f155, r155, f156, r156].some((s) => /food_ops|foodops/i.test(code(s))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
