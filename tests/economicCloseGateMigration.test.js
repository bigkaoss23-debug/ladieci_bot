"use strict";
// FINAL CONCURRENCY FIX (migration 151) -- static proof of the migration file pair and of the backend recognition.
// The dynamic proof (PG17.7: the deterministic race gate in both orders, the natural race, the C8 lock-order sweeps) is in
// ~/Downloads/DELIVERY_ECONOMY_V1_FINAL_CONCURRENCY_FIX_151_2026-09-26.md.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const FWD_REL = "migrations/2026-09-26_economic_close_gate_v1_migration_151.sql";
const RBK_REL = "migrations/2026-09-26_economic_close_gate_v1_migration_151.ROLLBACK.sql";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const code = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
// every $function$ body of a function, in file order
const bodies = (sql, name) => {
  const out = []; const re = new RegExp("CREATE (?:OR REPLACE )?FUNCTION public\\." + name + "\\(", "g"); let m;
  while ((m = re.exec(sql))) { const i = sql.indexOf("AS $function$", m.index) + "AS $function$".length; out.push(sql.slice(i, sql.indexOf("$function$", i))); }
  return out;
};
// the 151 block (with the one blank separator line that follows it, when present)
const block = (b) => { const i = b.indexOf("  -- 151:BEGIN economic_close_gate"); const e = b.indexOf("  -- 151:END economic_close_gate\n"); if (i < 0 || e < 0) return null; let end = e + "  -- 151:END economic_close_gate\n".length; if (b[end] === "\n") end += 1; return b.slice(i, end); };

let pass = 0; let fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log("  PASS  " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); } }

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist with number 151, used by exactly this pair", fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => /_migration_151\b/.test(x)).sort().join(",") === [FWD_REL, RBK_REL].map((f) => path.basename(f)).sort().join(","));
check("ECONOMY NUMBERING: the migrations >= 140 are exactly the pairs 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156 (152-154 = the POST-ASTRA corrective cycle, 155-156 = the final liveness gate) -- 141 / 142 (Fiscal) are NOT in the Economy package",
  [...new Set(fs.readdirSync(path.join(ROOT, "migrations")).map((x) => (/_migration_(1[4-9]\d|[2-9]\d\d)\b/.exec(x) || [])[1]).filter(Boolean))].sort().join(",") === "140,143,144,145,146,147,148,149,150,151,152,153,154,155,156"
  && !fs.readdirSync(path.join(ROOT, "migrations")).some((x) => /_migration_14[12]\b/.test(x)));
check("both files are pure ASCII and run in ONE transaction (BEGIN ... COMMIT)", ![...fwd, ...rbk].some((c) => c.charCodeAt(0) > 127) && /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));
check("no isolation level, no table / column / index / constraint / trigger DDL, no data write outside function bodies, no GRANT beyond service_role EXECUTE",
  !/ISOLATION\s+LEVEL|SET\s+TRANSACTION/i.test(code(fwd) + code(rbk))
  && !/^\s*(INSERT|UPDATE|DELETE)\s/im.test(code(fwd).replace(/\$function\$[\s\S]*?\$function\$/g, "").replace(/INSERT INTO c151_fn_before[\s\S]*?;/g, ""))
  && !/ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+(CONSTRAINT\s+)?TRIGGER|DROP\s+TRIGGER|ADD\s+CONSTRAINT/i.test(code(fwd).replace(/'[^']*'/g, "''"))
  && !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)/i.test(code(fwd)));
const row = (read("migrations/MIGRATION_MANIFEST.md").split("| 151 |")[1] || "").split("\n")[0];
check("MIGRATION_MANIFEST.md row 151 carries the forward and rollback sha256, says NOT APPLIED, and moves the Fiscal renumbering to >= 152",
  row.includes(sha(FWD_REL)) && row.includes(sha(RBK_REL)) && /NOT APPLIED to staging/.test(row) && />= 152/.test(row));
const PF = require("../scripts/economy139to146Preflight.js");
const tip = PF.CHAIN.find((c) => c.n === 151); // POST-ASTRA: 151 is no longer the chain tip (152 / 153 / 154 and 155 / 156 follow it)
check("the rollout preflight carries 151 (file + rollback sha256 = these files; the POST-ASTRA 152 / 153 / 154 and the liveness gate 155 / 156 follow it), a BEFORE_151 mode and POST_APPLY including it",
  tip.n === 151 && tip.sha === sha(FWD_REL) && tip.rbkSha === sha(RBK_REL) && PF.CHAIN.map((c) => c.n).slice(PF.CHAIN.map((c) => c.n).indexOf(151)).join(",") === "151,152,153,154,155,156" && JSON.stringify(PF.MODES.BEFORE_151) === "[139,140,143,144,145,146,147,148,149,150]"
  && PF.MODES.POST_APPLY.includes(151) && PF.DEPENDENCIES.some((d) => d.m === 151 && d.needs.includes(150) && d.needs.includes(144)));
const drift = PF.CHAIN.filter((c) => c.n < 151).filter((c) => sha("migrations/" + c.file) !== c.sha || sha("migrations/" + c.file.replace(/\.sql$/, ".ROLLBACK.sql")) !== c.rbkSha).map((c) => c.n);
check("the 20 files of 139 ... 150 are byte-identical to their certified sha256 (151 changes nothing before it)", drift.length === 0, drift.join(","));
check("no dependency on M141 / M142 / Fiscal", !/period_checkpoint|business_date_of_v1|verifactu|migration_14[12]\b/i.test(code(fwd) + code(rbk)));

console.log("\n── guards (fail closed) ──");
const G = code(fwd).slice(0, code(fwd).indexOf("CREATE TEMP TABLE c151_fn_before"));
const PINS = {
  "close_service_session_with_evidence_v1 (150 tip)": "a25b330f095ff3441bca034e79e750f7", "mesa_post_payment_v1 (150 tip, 145 gate)": "2d6ebfe704559dd5a9a083025fb77057",
  "close_service_session_v3 (close lock prefix)": "a6680181760dd8dabfa29aa43c786906", "open_operational_service_v1 (open lock set)": "497183409192e9a15c0f3b33c2d336ba",
  "order_post_payment_v1 (145 gate)": "e1ce2229f2418d6a7f91fe50771564f8", "order_post_refund_v1 (146 gate)": "687b55f29d69323d54a73111529cebe9", "mesa_post_refund_v1 (146 gate)": "69629f700425ebf48b88cc659c689992",
  "order_cancel_v1 (caller, the 144 body)": "26408ba35e2a43420273a6f4c126083d", "order_apply_commercial_adjustment_v1 (caller)": "bfac890abc0e6103466649d37fe92ddf",
  "mesa_post_commercial_adjustment_v1 (caller)": "76c4eb343b741fd1746aebdd738c7cea", "order_obligation_apply_adjustment_v1 (replaced)": "b4c358e2a3913ba110d400f07059e8e5", "order_obligation_revision_v1 (replaced)": "49387a6bf8e0ec66694d7bebe14d3d17",
};
for (const [what, pin] of Object.entries(PINS)) check(`guard pins ${what} = ${pin.slice(0, 8)}...`, G.includes(`'${pin}'`));
check("guard: the 150 closeout trigger must exist (chain tip 150)", /service_closeouts_terminal_close_v1/.test(G) && /chain tip is not 150/.test(G));
check("guard: the totale revision trigger must be installed exactly as certified", G.includes("CREATE TRIGGER ordenes_order_obligation_revision_v1 AFTER UPDATE OF totale ON public.ordenes FOR EACH ROW EXECUTE FUNCTION order_obligation_revision_v1()"));
check("guard: refuses a second application (helper present or a 151 block already in a replaced body)", /already applied/.test(G) && /order_economic_service_gate_v1\(uuid\)'\) IS NOT NULL/.test(G));

console.log("\n── the shared gate ──");
const helper = bodies(fwd, "order_economic_service_gate_v1");
const H = helper[0] || "";
check("exactly ONE new function, order_economic_service_gate_v1(uuid) RETURNS void, SECURITY INVOKER, search_path public, pg_temp",
  helper.length === 1 && /CREATE FUNCTION public\.order_economic_service_gate_v1\(p_order_uid uuid\)\n RETURNS void\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS \$function\$/.test(fwd) && !/SECURITY DEFINER/i.test(fwd));
check("it takes the canonical gate FIRST: service_session_state FOR SHARE (the 145/146 primitive), before any other statement", /^\s*DECLARE[\s\S]*?BEGIN\s*(--[^\n]*\n\s*)*PERFORM 1 FROM public\.service_session_state WHERE singleton = true FOR SHARE;/.test(H));
check("after the gate it re-judges the order's service and the service its obligations are anchored to: status must be 'open'",
  H.indexOf("FOR SHARE") < H.indexOf("FROM public.service_sessions ss") && /o\.order_uid = p_order_uid/.test(H) && /ob\.order_uid = p_order_uid ORDER BY ob\.revision DESC LIMIT 1/.test(H) && /ss\.status IS DISTINCT FROM 'open'/.test(H));
check("a closed service is a typed refusal: SQLSTATE 55000 ORDER_ECONOMIC_SERVICE_CLOSED", /RAISE EXCEPTION 'ORDER_ECONOMIC_SERVICE_CLOSED' USING ERRCODE = '55000'/.test(H));
check("the gate writes nothing (no INSERT / UPDATE / DELETE, no other lock)", !/\b(INSERT|UPDATE|DELETE)\b/.test(code(H).replace(/FOR SHARE/, "")) && (code(H).match(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/g) || []).length === 1);
check("EXECUTE: service_role only (revoked from PUBLIC / anon / authenticated)", /REVOKE ALL ON FUNCTION public\.order_economic_service_gate_v1\(uuid\) FROM PUBLIC, anon, authenticated;/.test(fwd) && /GRANT EXECUTE ON FUNCTION public\.order_economic_service_gate_v1\(uuid\) TO service_role;/.test(fwd));

console.log("\n── the two obligation writers: their 150-state body + ONE block each ──");
const coreF = bodies(fwd, "order_obligation_apply_adjustment_v1"); const coreR = bodies(rbk, "order_obligation_apply_adjustment_v1");
const revF = bodies(fwd, "order_obligation_revision_v1"); const revR = bodies(rbk, "order_obligation_revision_v1");
check("the rollback carries the 150-state bodies verbatim (b4c358e2... / 49387a6b...)", coreR.length === 1 && md5(coreR[0]) === "b4c358e2a3913ba110d400f07059e8e5" && revR.length === 1 && md5(revR[0]) === "49387a6bf8e0ec66694d7bebe14d3d17");
for (const [name, f, r, pin] of [["order_obligation_apply_adjustment_v1", coreF, coreR, "2c411d98f63545c4a4b7d04fd9beb7fe"], ["order_obligation_revision_v1", revF, revR, "bfac4ec3f428daa91d5d9505d8b1285a"]]) {
  const b = block(f[0] || "");
  check(`${name}: exactly ONE 151 block, and removing it yields the 150-state body byte for byte`, f.length === 1 && !!b && f[0].split("-- 151:BEGIN").length === 2 && f[0].replace(b, "") === r[0]);
  check(`${name}: the block only calls the shared gate (one PERFORM, nothing else)`, !!b && code(b).trim().split("\n").length === 1 && /PERFORM public\.order_economic_service_gate_v1\((p_order_uid|NEW\.order_uid)\);/.test(code(b)));
  check(`${name}: the forward pins its new body (${pin.slice(0, 8)}...) in the post-conditions`, md5(f[0] || "") === pin && fwd.includes(`'${pin}'`));
}
{ const c = coreF[0] || ""; const at = c.indexOf("PERFORM public.order_economic_service_gate_v1(p_order_uid);");
  check("core: the gate comes AFTER the idempotent replay (which writes nothing) and BEFORE the first write (bootstrap INSERT / revision INSERT)",
    at > c.indexOf("RETURN jsonb_build_object('ok', true, 'idempotent', true") && at < c.indexOf("INSERT INTO public.order_obligations") && at < c.indexOf("SELECT * INTO v_prev FROM public.order_obligations WHERE order_uid = p_order_uid ORDER BY revision DESC LIMIT 1;"));
  check("core: the caller's order row is locked before the gate (W -> ACTOR -> [TABLE_SESSION] -> ORDER -> POINTER, the 145/146 order)", c.indexOf("FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE") < at); }
{ const r = revF[0] || ""; const at = r.indexOf("PERFORM public.order_economic_service_gate_v1(NEW.order_uid);");
  check("totale trigger: the gate comes after the no-op / no-obligation early returns and BEFORE its INSERT", at > r.indexOf("IF NOT FOUND THEN\n    RETURN NEW;") && at < r.indexOf("INSERT INTO public.order_obligations")); }

console.log("\n── post-conditions and rollback ──");
check("post-conditions: the three pins, helper posture, each block exactly once, replaced posture unchanged, trigger unchanged, every other function byte-identical",
  /post-condition failed: % is not the expected body/.test(fwd) && /EXECUTE for service_role only/.test(fwd) && /must carry the 151 block exactly once/.test(fwd)
  && /owner \/ SECURITY \/ search_path \/ ACL \/ signature \/ return of a replaced function changed/.test(fwd) && /totale revision trigger changed/.test(fwd) && /other functions changed/.test(fwd));
check("rollback guards the three 151 pins and refuses while any other function calls the helper", ["3c8c4c46dac20285081b85a3313ef576", "2c411d98f63545c4a4b7d04fd9beb7fe", "bfac4ec3f428daa91d5d9505d8b1285a"].every((p) => code(rbk).includes(`'${p}'`)) && /another function calls order_economic_service_gate_v1/.test(rbk));
check("rollback drops the helper after restoring both bodies, and post-checks the 150-state pins and every other function", code(rbk).indexOf("DROP FUNCTION public.order_economic_service_gate_v1(uuid);") > code(rbk).indexOf("CREATE OR REPLACE FUNCTION public.order_obligation_revision_v1()")
  && /IS DISTINCT FROM 'b4c358e2a3913ba110d400f07059e8e5'/.test(rbk) && /IS DISTINCT FROM '49387a6bf8e0ec66694d7bebe14d3d17'/.test(rbk) && /other functions changed/.test(rbk));
check("the rollback header is honest: function-only, valid at any time, and it reopens the race", /function-only/i.test(rbk) && /reopens|open again/i.test(rbk.slice(0, 1200)));

console.log("\n── backend recognition (a refused write is never reported as saved) ──");
const G2 = require("../src/financial/paidOrderEconomicGuard");
check("paidOrderEconomicGuard recognises ORDER_ECONOMIC_SERVICE_CLOSED in the PostgREST error body (message / details / hint / code) and nowhere else",
  G2.isEconomicServiceClosedRefusal({ code: "55000", message: "ORDER_ECONOMIC_SERVICE_CLOSED" }) && G2.isEconomicServiceClosedRefusal({ hint: "x", details: "ORDER_ECONOMIC_SERVICE_CLOSED y" })
  && !G2.isEconomicServiceClosedRefusal({ message: "ORDER_ECONOMIC_BASIS_LOCKED" }) && !G2.isEconomicServiceClosedRefusal(null) && !G2.isEconomicServiceClosedRefusal([{ message: "ORDER_ECONOMIC_SERVICE_CLOSED" }]));
check("its typed refusal: success false, code ORDER_ECONOMIC_SERVICE_CLOSED, a Spanish operator sentence", (() => { const r = G2.economicServiceClosedRefusal("#1"); return r.success === false && r.code === "ORDER_ECONOMIC_SERVICE_CLOSED" && r.error === r.code && r.id === "#1" && /cerrado/.test(r.message); })());
const ag = read("src/agents/agentOrdini.js");  // language-guard: allow-legacy agentOrdini.js is the existing file name being read, not new vocabulary
check("the three totale writers of agentOrdini (modificaOrdine, cambiaStato with a discount, aggiungiItems) return it instead of a false success",  // language-guard: allow-legacy agentOrdini / modificaOrdine are the existing file and writer names cited, not new vocabulary
  // POST-ASTRA F5 / F7 -- all three write through writeOrderPatch, whose one classifier returns the typed 151 refusal.
  ["modRefusal", "stateRefusal", "addRefusal"].every((v) => new RegExp(`const ${v} = await writeOrderPatch\\(ordenId,[\\s\\S]*?if \\(${v}\\) return ${v};`).test(ag))
  && /if \(isEconomicServiceClosedRefusal\(result\)\) return economicServiceClosedRefusal\(orderId\);/.test(read("src/financial/paidOrderEconomicGuard.js")));
const setOf = (src, name) => { const s = src.indexOf(`const ${name} = new Set([`); return s < 0 ? "" : src.slice(s, src.indexOf("]);", s)); };
const cashH = read("src/cash/cashHttpHandlers.js"), mesaH = read("src/tables/mesaHttpHandlers.js");
check("Cash and Mesa HTTP answer it as a typed 409 conflict", setOf(cashH, "conflict").includes("'ORDER_ECONOMIC_SERVICE_CLOSED'")
  && /'ORDER_ECONOMIC_SERVICE_CLOSED',\n\s+\/\/ CORRECTIVE SLICE 150 \(#2\)/.test(mesaH));
check("POST-ASTRA F1: Cash and Mesa HTTP map the post-close codes identically (409 conflicts, 403 forbidden, 404 not found)",
  ["SERVICE_STILL_OPEN", "STALE_OBLIGATION", "NO_CHANGE", "IDEMPOTENCY_CONFLICT", "EXCEEDS_OBLIGATION"].every((c) => setOf(cashH, "conflict").includes(`'ORDER_POST_CLOSE_${c}'`) && setOf(mesaH, "conflict").includes(`'ORDER_POST_CLOSE_${c}'`))
  && setOf(cashH, "denied").includes("'ORDER_POST_CLOSE_FORBIDDEN'") && setOf(mesaH, "denied").includes("'ORDER_POST_CLOSE_FORBIDDEN'")
  && setOf(cashH, "missing").includes("'ORDER_POST_CLOSE_ORDER_NOT_FOUND'") && setOf(mesaH, "missing").includes("'ORDER_POST_CLOSE_ORDER_NOT_FOUND'"));
check("the cancel path passes the typed code through (codeFromRpcBody admits ORDER_*)", /\^\(MESA\|ORDER\|AUTH\)_\[A-Z0-9_\]\+\$/.test(read("src/financial/cancelOrder.js")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
