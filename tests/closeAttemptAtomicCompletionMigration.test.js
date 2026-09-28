// tests/closeAttemptAtomicCompletionMigration.test.js — static guard of migration 149 (R4B: terminal close + attempt completion in one transaction).
// The behaviour (atomicity, the two deferred invariants, lock order, crash / retry / concurrency matrix through the real Finalizar caller) is
// certified on ephemeral PostgreSQL 17 (~/Downloads/DELIVERY_ECONOMY_V1_R4B_FINALIZAR_IDENTITY_ATOMIC_2026-09-25.md); this file proves what text can.
// Run: node tests/closeAttemptAtomicCompletionMigration.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const FWD_REL = "migrations/2026-09-25_close_attempt_atomic_completion_v1_migration_149.sql";
const RBK_REL = "migrations/2026-09-25_close_attempt_atomic_completion_v1_migration_149.ROLLBACK.sql";
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, p))).digest("hex");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const code = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); } }

const fwd = read(FWD_REL), rbk = read(RBK_REL);
function bodies(sql) {
  const out = {}; const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(/g; let m;
  while ((m = re.exec(sql))) { const rest = sql.slice(m.index); const o = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest); const bs = m.index + o.index + o[0].length; out[m[1]] = sql.slice(bs, sql.indexOf(o[1], bs)); }
  return out;
}
const B = bodies(fwd);
const PIN = { close_service_session_and_complete_attempt_v1: "f53a677bf72aebdec2ce90eea8a81668", service_session_close_attempt_terminal_v1: "c3e18316e5375981061e57b25cdf8915", service_closeout_attempt_open_service_v1: "aff9e7d796c3b4fd19267ac5f946ac31" };

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist with number 149, used by exactly this pair", fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => /_migration_149\b/.test(x)).sort().join(",") === [FWD_REL, RBK_REL].map((f) => path.basename(f)).sort().join(","));
check("ECONOMY NUMBERING: the migrations >= 140 are exactly the pairs 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156 (152-154 = the POST-ASTRA corrective cycle, 155-156 = the final liveness gate) (150 = the corrective slice, 151 = the final concurrency fix, after this one) -- 141 / 142 (Fiscal) are NOT in the Economy package",
  [...new Set(fs.readdirSync(path.join(ROOT, "migrations")).map((x) => (/_migration_(1[4-9]\d|[2-9]\d\d)\b/.exec(x) || [])[1]).filter(Boolean))].sort().join(",") === "140,143,144,145,146,147,148,149,150,151,152,153,154,155,156");
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));
check("both files are pure ASCII (no transport-encoding dependency)", /^[\x00-\x7f]*$/.test(fwd) && /^[\x00-\x7f]*$/.test(rbk));
const manifestRow = (read("migrations/MIGRATION_MANIFEST.md").split("| 149 |")[1] || "").split("\n")[0];
check("MIGRATION_MANIFEST.md row 149 carries the forward and rollback sha256 and says NOT APPLIED", manifestRow.includes(sha(FWD_REL)) && manifestRow.includes(sha(RBK_REL)) && /NOT APPLIED to staging/.test(manifestRow));
const PF = require("../scripts/economy139to146Preflight.js");
const pf149 = PF.CHAIN.find((c) => c.n === 149);
check("the rollout preflight carries 149 (file + rollback sha256 = these files; since the corrective slice, 150, 151 and the POST-ASTRA 152 / 153 / 154 and the liveness gate 155 / 156 follow it) and a BEFORE_149 mode",
  !!pf149 && pf149.sha === sha(FWD_REL) && pf149.rbkSha === sha(RBK_REL) && PF.CHAIN.map((c) => c.n).slice(PF.CHAIN.map((c) => c.n).indexOf(149)).join(",") === "149,150,151,152,153,154,155,156"
  && JSON.stringify(PF.MODES.BEFORE_149) === "[139,140,143,144,145,146,147,148]");
const drift = PF.CHAIN.filter((c) => c.n < 149).filter((c) => sha("migrations/" + c.file) !== c.sha || sha("migrations/" + c.file.replace(/\.sql$/, ".ROLLBACK.sql")) !== c.rbkSha).map((c) => c.n);
check("the 16 files of 139, 140, 143, 144, 145, 146, 147, 148 are byte-identical to their certified sha256 (149 changes nothing before it)", drift.length === 0, drift.join(","));

console.log("\n── scope: three NEW functions, two NEW deferred triggers, nothing re-issued ──");
check("exactly three CREATE FUNCTION (never CREATE OR REPLACE: nothing existing is re-issued)", (code(fwd).match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/g) || []).length === 3 && !/CREATE\s+OR\s+REPLACE\s+FUNCTION/.test(code(fwd)));
check("the three new bodies are the certified ones (md5 pins)", Object.entries(PIN).every(([n, m]) => B[n] && md5(B[n]) === m), JSON.stringify(Object.fromEntries(Object.entries(B).map(([n, b]) => [n, md5(b)]))));
check("no ALTER TABLE / CREATE TABLE / DROP / INSERT / UPDATE / DELETE in the forward file (no schema or data change)", !/\b(ALTER\s+TABLE|CREATE\s+TABLE|CREATE\s+INDEX|DROP\s|INSERT\s+INTO\s+public|DELETE\s+FROM)/i.test(code(fwd).replace(/INSERT INTO c149_fn_before/, "")) && !/UPDATE\s+public\./i.test(code(fwd)));
check("close_service_session_v3 and complete_closeout_attempt are called, never redefined", !/FUNCTION\s+public\.(close_service_session_v3|complete_closeout_attempt)\s*\(/.test(code(fwd)));

console.log("\n── the terminal step ──");
const T = B.close_service_session_and_complete_attempt_v1 || "";
const at = (s) => T.indexOf(s);
check("evidence first: snapshot AND reconciliation of THIS correlation for THIS service, else CLOSE_EVIDENCE_INCOMPLETE with no write",
  /FROM public\.service_closeout_snapshots\s+WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id/.test(T)
  && /FROM public\.service_closeout_reconciliations\s+WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id/.test(T)
  && at("'CLOSE_EVIDENCE_INCOMPLETE'") > -1 && at("'CLOSE_EVIDENCE_INCOMPLETE'") < at("public.close_service_session_v3("));
check("close, then completion of the SAME correlation, inside one block; a refused completion raises LD149 (rolls the close back) and answers ATTEMPT_COMPLETION_REFUSED",
  at("public.close_service_session_v3(p_service_session_id, p_closeout_correlation_id, p_closed_by, p_source)") > -1
  && at("public.complete_closeout_attempt(p_closeout_correlation_id, p_closed_by)") > at("public.close_service_session_v3(")
  && /IS DISTINCT FROM 'COMPLETED' THEN\s+RAISE EXCEPTION 'close attempt completion refused' USING ERRCODE = 'LD149';/.test(T)
  && /EXCEPTION WHEN SQLSTATE 'LD149' THEN\s+[^\n]*\n\s+RETURN jsonb_build_object\('ok',false,'code','ATTEMPT_COMPLETION_REFUSED'/.test(T));
check("ALREADY_CLOSED is a success ONLY for this exact attempt already completed (CLOSED_ATTEMPT_NOT_COMPLETED / ATTEMPT_NOT_FOUND otherwise)",
  /WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id;\s+IF NOT FOUND THEN\s+RETURN jsonb_build_object\('ok',false,'code','ATTEMPT_NOT_FOUND'\);/.test(T)
  && /IF v_attempt\.status <> 'completed' THEN\s+RETURN jsonb_build_object\('ok',false,'code','CLOSED_ATTEMPT_NOT_COMPLETED'/.test(T));
check("every success carries attemptCompleted:true and the attempt row", (T.match(/'attemptCompleted',true/g) || []).length === 2);
check("no lock of its own before the close (it takes exactly the close's locks, then the attempt row via the completion)", !/FOR (UPDATE|SHARE)|pg_advisory/i.test(T));
check("SECURITY INVOKER, search_path public, pg_temp; EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role only",
  !/SECURITY DEFINER/.test(fwd.slice(fwd.indexOf("CREATE FUNCTION public.close_service_session_and_complete_attempt_v1"), fwd.indexOf("$function$", fwd.indexOf("CREATE FUNCTION public.close_service_session_and_complete_attempt_v1"))))
  && /REVOKE ALL ON FUNCTION public\.close_service_session_and_complete_attempt_v1\(uuid,uuid,text,text\) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public\.close_service_session_and_complete_attempt_v1\(uuid,uuid,text,text\) TO service_role;/.test(fwd));

console.log("\n── the two invariants ──");
check("service_sessions: CONSTRAINT TRIGGER, AFTER UPDATE OF status, DEFERRABLE INITIALLY DEFERRED, only on a transition INTO 'closed'",
  /CREATE CONSTRAINT TRIGGER service_sessions_close_attempt_terminal_v1\n\s+AFTER UPDATE OF status ON public\.service_sessions\n\s+DEFERRABLE INITIALLY DEFERRED\n\s+FOR EACH ROW\n\s+WHEN \(NEW\.status = 'closed' AND OLD\.status IS DISTINCT FROM 'closed'\)/.test(fwd));
check("... refuses the COMMIT while an attempt of that service is active", /a\.service_session_id = NEW\.id AND a\.status = 'active'\) THEN\s+RAISE EXCEPTION 'SERVICE_CLOSED_WITH_ACTIVE_CLOSEOUT_ATTEMPT'/.test(B.service_session_close_attempt_terminal_v1 || ""));
check("service_closeout_attempts: CONSTRAINT TRIGGER, AFTER INSERT, DEFERRABLE INITIALLY DEFERRED, only for an active attempt",
  /CREATE CONSTRAINT TRIGGER service_closeout_attempts_open_service_v1\n\s+AFTER INSERT ON public\.service_closeout_attempts\n\s+DEFERRABLE INITIALLY DEFERRED\n\s+FOR EACH ROW\n\s+WHEN \(NEW\.status = 'active'\)/.test(fwd));
check("... reads the service row FOR SHARE (waits for a concurrent close, judges its committed result) and refuses an active attempt of a closed service",
  /FROM public\.service_sessions s WHERE s\.id = NEW\.service_session_id FOR SHARE;/.test(B.service_closeout_attempt_open_service_v1 || "") && /RAISE EXCEPTION 'CLOSEOUT_ATTEMPT_FOR_CLOSED_SERVICE'/.test(B.service_closeout_attempt_open_service_v1 || ""));

console.log("\n── guards, post-conditions, rollback ──");
const cf = code(fwd);
check("guards: close_service_session_v3 = 139 body, complete_closeout_attempt pinned, chain tip = 148, not already applied",
  /IS DISTINCT FROM 'a6680181760dd8dabfa29aa43c786906'/.test(cf) && /IS DISTINCT FROM 'f96adc7871c50751fdd7a4b1aebf3783'/.test(cf) && /IS DISTINCT FROM 'e1ce2229f2418d6a7f91fe50771564f8'/.test(cf) && /already applied/.test(cf));
check("post-conditions pin the three bodies with the same md5 as the file carries", Object.values(PIN).every((m) => (cf.match(new RegExp(m, "g")) || []).length === 1));
check("post-conditions: exact trigger definitions, both called bodies unchanged, every other function byte-identical", /pg_get_triggerdef\(t\.oid\) = 'CREATE CONSTRAINT TRIGGER service_sessions_close_attempt_terminal_v1/.test(cf) && /other functions changed/.test(cf));
const cr = code(rbk);
check("rollback: refuses unless every 149 body is the certified one, drops exactly the two triggers and the three functions, re-checks the called bodies",
  Object.values(PIN).every((m) => cr.includes(m)) && (cr.match(/^DROP (TRIGGER|FUNCTION) /gm) || []).length === 5 && /DROP TRIGGER service_sessions_close_attempt_terminal_v1 ON public\.service_sessions;/.test(cr)
  && /DROP TRIGGER service_closeout_attempts_open_service_v1 ON public\.service_closeout_attempts;/.test(cr) && cr.includes("a6680181760dd8dabfa29aa43c786906") && !/CREATE /.test(cr.replace(/CREATE TEMP TABLE/, "")));
check("the preflight expects the same three bodies in POST_APPLY", ["close_service_session_and_complete_attempt_v1", "service_session_close_attempt_terminal_v1", "service_closeout_attempt_open_service_v1"].every((n) => PF.stateFor(PF.FN.find((f) => f.sig.includes(n)).states, PF.MODES.POST_APPLY) === PIN[n]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
