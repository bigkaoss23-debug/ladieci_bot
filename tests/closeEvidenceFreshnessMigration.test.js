// tests/closeEvidenceFreshnessMigration.test.js — static guard of migration 150 (corrective slice after the adversarial review:
// the V3 close is judged against its evidence and commits closeout + reconciliation + close together; a closeout commits only with the
// terminal close; the Mesa writer refuses legacy paid ambiguity) and of the backend wiring that depends on it.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const FWD_REL = "migrations/2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.sql";
const RBK_REL = "migrations/2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.ROLLBACK.sql";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const PF = require("../scripts/economy139to146Preflight");
let pass = 0, fail = 0;
const check = (label, ok, detail) => { if (ok) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail !== undefined ? "  -> " + String(detail).slice(0, 300) : "")); } };

const fwd = read(FWD_REL), rbk = read(RBK_REL);
const code = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
// the prosrc of a function as the file carries it (between AS $function$ and the closing $function$)
const body = (sql, head) => { const i = sql.indexOf(head); if (i < 0) return null; const a = sql.indexOf("AS $function$", i) + "AS $function$".length; return sql.slice(a, sql.indexOf("$function$", a)); };
const f145 = read("migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.sql");
const MESA_HEAD = "CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(";
const TERMINAL = body(fwd, "CREATE FUNCTION public.close_service_session_with_evidence_v1(");
const DIGEST = body(fwd, "CREATE FUNCTION public.service_close_evidence_digest_v1(");
const LIVE = body(fwd, "CREATE FUNCTION public.service_close_live_evidence_v1(");
const TRIG = body(fwd, "CREATE FUNCTION public.service_closeout_requires_terminal_close_v1(");
const MESA150 = body(fwd, MESA_HEAD), MESA145 = body(f145, MESA_HEAD), MESA_RBK = body(rbk, MESA_HEAD);
const BLOCK_RE = /  -- 150:BEGIN mesa_legacy_paid_ambiguity_guard\n[\s\S]*?  -- 150:END mesa_legacy_paid_ambiguity_guard\n/;
const PIN = { DIGEST: "a7f89499be50f338607ff64f8778f2ae", LIVE: "49163cc1ec55c7f2154e4d76ee77445c", TERMINAL: "a25b330f095ff3441bca034e79e750f7", TRIGGER: "be58c0f28da316fcb8495be7676c2738", MESA: "2d6ebfe704559dd5a9a083025fb77057" };

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist with number 150, used by exactly this pair", fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => /_migration_150\b/.test(x)).sort().join(",") === [FWD_REL, RBK_REL].map((f) => path.basename(f)).sort().join(","));
check("ECONOMY NUMBERING: the migrations >= 140 are exactly the pairs 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156 (152-154 = the POST-ASTRA corrective cycle, 155-156 = the final liveness gate) (151 = the final concurrency fix, after this one) -- 141 / 142 (Fiscal) are NOT in the Economy package",
  [...new Set(fs.readdirSync(path.join(ROOT, "migrations")).map((x) => (/_migration_(1[4-9]\d|[2-9]\d\d)\b/.exec(x) || [])[1]).filter(Boolean))].sort().join(",") === "140,143,144,145,146,147,148,149,150,151,152,153,154,155,156");
check("both files are pure ASCII and run in ONE transaction (BEGIN ... COMMIT)", ![...fwd, ...rbk].some((c) => c.charCodeAt(0) > 127) && /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));
check("no isolation level, no data change: no INSERT / UPDATE / DELETE of a table outside the function bodies, no ALTER TABLE, no GRANT beyond service_role EXECUTE",
  !/ISOLATION\s+LEVEL|SET\s+TRANSACTION/i.test(code(fwd) + code(rbk)) && !/^\s*(INSERT|UPDATE|DELETE)\s/im.test(code(fwd).replace(/\$function\$[\s\S]*?\$function\$/g, "").replace(/INSERT INTO c150_fn_before[\s\S]*?;/g, ""))
  && !/ALTER\s+TABLE/i.test(code(fwd)) && !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)/i.test(code(fwd)));
const row = (read("migrations/MIGRATION_MANIFEST.md").split("| 150 |")[1] || "").split("\n")[0];
check("MIGRATION_MANIFEST.md row 150 carries the forward and rollback sha256 and says NOT APPLIED", row.includes(sha(FWD_REL)) && row.includes(sha(RBK_REL)) && /NOT APPLIED to staging/.test(row));
const pf150 = PF.CHAIN.find((c) => c.n === 150);
check("the rollout preflight carries 150 (file + rollback sha256 = these files; since the final concurrency fix, 151 and the POST-ASTRA 152 / 153 / 154 and the liveness gate 155 / 156 follow it) and a BEFORE_150 mode",
  !!pf150 && PF.CHAIN.map((c) => c.n).slice(PF.CHAIN.map((c) => c.n).indexOf(150)).join(",") === "150,151,152,153,154,155,156" && pf150.sha === sha(FWD_REL) && pf150.rbkSha === sha(RBK_REL) && JSON.stringify(PF.MODES.BEFORE_150) === "[139,140,143,144,145,146,147,148,149]");
const drift = PF.CHAIN.filter((c) => c.n < 150).filter((c) => sha("migrations/" + c.file) !== c.sha || sha("migrations/" + c.file.replace(/\.sql$/, ".ROLLBACK.sql")) !== c.rbkSha).map((c) => c.n);
check("the 18 files of 139 ... 149 are byte-identical to their certified sha256 (150 changes nothing before it)", drift.length === 0, drift.join(","));
check("no dependency on M141 / M142 / Fiscal", !/period_checkpoint|business_date_of_v1|verifactu|migration_14[12]\b/i.test(code(fwd) + code(rbk)));

console.log("\n── guards (fail closed) ──");
check("chain tip: refuses unless close_service_session_and_complete_attempt_v1 is the 149 body f53a677b... with its two triggers", /IS DISTINCT FROM 'f53a677bf72aebdec2ce90eea8a81668'/.test(code(fwd)) && /service_sessions_close_attempt_terminal_v1', 'service_closeout_attempts_open_service_v1'\)\) <> 2/.test(code(fwd)));
check("every authority the terminal step calls or relies on is pinned to its certified body (close v3, completion, acquire, supersede, capture, create closeout, reconciliation, canonical obligation) and the Mesa writer to the 145 body",
  ["a6680181760dd8dabfa29aa43c786906", "f96adc7871c50751fdd7a4b1aebf3783", "e0e510d074ce61a6cc6b7d505ac38012", "1ee565901cad6b66f2e92772aad902ea", "2a3a4b1d746f5bc549991e5f0cdd13c3",
   "e089a36c1cbdcfb1f148a86aaf0ae226", "f8f351a9ec2d2754220b95a165a3ae06", "c68e831344fd537128608567727c2f9d", "94867e165d0732f36ae4692fc6998c58"].every((h) => code(fwd).includes("'" + h + "'")));
check("refuses an already-applied state (any 150 object present, or a 150 block in the Mesa writer)", /already applied \(an object of migration 150 already exists\)/.test(fwd) && /position\('-- 150:BEGIN ' IN/.test(fwd));

console.log("\n── #1: the terminal step judges the evidence, then commits everything or nothing ──");
const at = (s) => TERMINAL.indexOf(s);
check("the lock prefix of close_service_session_v3 (lifecycle advisory -> L0 -> pointer FOR UPDATE) is taken BEFORE the evidence is judged",
  at("pg_advisory_xact_lock(hashtext('service_session_lifecycle'))") > 0 && at("pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'))") > at("pg_advisory_xact_lock(hashtext('service_session_lifecycle'))")
  && at("FROM public.service_session_state WHERE singleton = true FOR UPDATE") > at("LA_DIECI_DRIVER_STATO") && at("service_close_live_evidence_v1(") > at("FOR UPDATE;"));
check("stale evidence returns CLOSE_EVIDENCE_STALE BEFORE any write (no closeout, no reconciliation, no close)",
  at("'CLOSE_EVIDENCE_STALE'") > 0 && at("'CLOSE_EVIDENCE_STALE'") < at("public.create_service_closeout(") && at("'CLOSE_EVIDENCE_STALE'") < at("public.create_service_closeout_reconciliation_v1(")
  && at("'CLOSE_EVIDENCE_STALE'") < at("v_result := public.close_service_session_and_complete_attempt_v1("));
check("freshness (a): the attempt's snapshot payload vs the live facts, through the SAME digest", (TERMINAL.match(/public\.service_close_evidence_digest_v1\(/g) || []).length === 2
  && /v_snapshot\.payload->'orders', v_snapshot\.payload->'tableSessions', v_snapshot\.payload->'financialEvents', v_snapshot\.payload->'orderObligations'/.test(TERMINAL)
  && /v_live->'orders', v_live->'tableSessions', v_live->'financialEvents', v_live->'orderObligations'/.test(TERMINAL));
check("freshness (b): the receipts attributed to the service are exactly p_receipt_ids (or, for a reconciliation committed before 150, none newer than it)",
  /ARRAY\(SELECT DISTINCT x FROM unnest\(p_receipt_ids\) x ORDER BY 1\) IS DISTINCT FROM\s+ARRAY\(SELECT t\.id FROM public\.payment_transactions t WHERE t\.service_session_id = p_service_session_id ORDER BY 1\)/.test(TERMINAL)
  && /t\.created_at > v_recon\.created_at/.test(TERMINAL));
check("closeout -> reconciliation -> 149 close + completion inside ONE block; any refusal raises LD150 and rolls the block back (no closeout / reconciliation survives)",
  at("public.create_service_closeout(") < at("public.create_service_closeout_reconciliation_v1(") && at("public.create_service_closeout_reconciliation_v1(") < at("v_result := public.close_service_session_and_complete_attempt_v1(")
  && (TERMINAL.match(/RAISE EXCEPTION '[a-z ]+' USING ERRCODE = 'LD150'/g) || []).length === 5 && /EXCEPTION WHEN SQLSTATE 'LD150' THEN/.test(TERMINAL)
  && /\(v_result->>'attemptCompleted'\) IS DISTINCT FROM 'true'/.test(TERMINAL));
check("an already-closed service answers from its own facts (this attempt completed + its closeout), never through the current-service pointer, and writes nothing",
  /IF v_session\.status = 'closed' THEN\s+IF v_attempt\.status = 'completed'\s+AND EXISTS \(SELECT 1 FROM public\.service_closeouts c WHERE c\.service_session_id = p_service_session_id AND c\.closeout_correlation_id = p_closeout_correlation_id\)/.test(TERMINAL)
  && at("IF v_session.status = 'closed' THEN") < at("service_close_live_evidence_v1("));
check("the digest covers exactly the facts the closeout and its classification are computed from (orders: id, estado, totale, cobrado, ya_pagado, metodo_pago; tables: id + status/covers, an empty table by id only; the event and obligation id sets)",
  ["e->>'estado'", "trim_scale((e->>'totale')::numeric)", "e->>'cobrado'", "e->>'ya_pagado'", "e->>'metodo_pago'", "e->'covers_total'", "e->>'status'", "'empty'", "'events['", "'obligations['"].every((t) => DIGEST.includes(t)));
check("the live evidence reads the four sets with exactly the engine's service scope (service_session_id = the service)",
  ["FROM public.ordenes o WHERE o.service_session_id = p_service_session_id", "FROM public.table_sessions t WHERE t.service_session_id = p_service_session_id",
   "FROM public.order_financial_events e WHERE e.service_session_id = p_service_session_id", "FROM public.order_obligations b WHERE b.service_session_id = p_service_session_id"].every((t) => LIVE.includes(t)));
check("the closeout trigger: AFTER INSERT, DEFERRABLE INITIALLY DEFERRED, refuses unless the service is closed (or rolled_over) at commit",
  /CREATE CONSTRAINT TRIGGER service_closeouts_terminal_close_v1\n  AFTER INSERT ON public\.service_closeouts\n  DEFERRABLE INITIALLY DEFERRED\n  FOR EACH ROW\n  EXECUTE FUNCTION public\.service_closeout_requires_terminal_close_v1\(\);/.test(fwd)
  && /v_status IS DISTINCT FROM 'closed' AND v_status IS DISTINCT FROM 'rolled_over'/.test(TRIG) && /SERVICE_CLOSEOUT_WITHOUT_TERMINAL_CLOSE/.test(TRIG));

console.log("\n── #2: the Mesa writer refuses legacy paid ambiguity ──");
check("the forward Mesa body minus the 150 block is the 145 body byte for byte", !!MESA150 && MESA150.replace(BLOCK_RE, "") === MESA145 && md5(MESA145) === "94867e165d0732f36ae4692fc6998c58");
const blk = (MESA150.match(BLOCK_RE) || [""])[0];
check("the block sits right after MESA_ALREADY_SETTLED, before the 145 pointer lock (after the idempotent replay and the table's ordenes FOR UPDATE)",
  MESA150.indexOf(blk) === MESA150.indexOf("'MESA_ALREADY_SETTLED'") + MESA150.slice(MESA150.indexOf("'MESA_ALREADY_SETTLED'")).indexOf("\n") + 1
  && MESA150.indexOf(blk) < MESA150.indexOf("-- 145:BEGIN receipt_service_pointer_lock") && MESA150.indexOf(blk) > MESA150.indexOf("ORDER BY o.id\n   FOR UPDATE;"));
check("it raises the 148 code and SQLSTATE (55000 ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED) on a paid mirror with a positive canonical outstanding (148 formula), and takes NO lock",
  /RAISE EXCEPTION 'ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED' USING ERRCODE='55000'/.test(blk) && /\(o\.cobrado IS TRUE OR o\.ya_pagado IS TRUE\)/.test(blk)
  && /round\(public\.order_canonical_obligation_v1\(o\.order_uid\) \* 100\)::bigint\n\s+> COALESCE/.test(blk) && /e\.type IN \('payment','payment_imported','refund'\)/.test(blk) && !/FOR (UPDATE|SHARE)/.test(code(blk)));

console.log("\n── post-conditions and rollback ──");
check("the five md5 pins of the post-conditions are the bodies the file carries", md5(DIGEST) === PIN.DIGEST && md5(LIVE) === PIN.LIVE && md5(TERMINAL) === PIN.TERMINAL && md5(TRIG) === PIN.TRIGGER && md5(MESA150) === PIN.MESA
  && Object.values(PIN).every((h) => fwd.includes("'" + h + "'")));
check("the preflight FN / TRIGGERS states for 150 are exactly those pins and that trigger definition",
  [["service_close_evidence_digest_v1", PIN.DIGEST], ["service_close_live_evidence_v1", PIN.LIVE], ["close_service_session_with_evidence_v1", PIN.TERMINAL], ["service_closeout_requires_terminal_close_v1", PIN.TRIGGER], ["mesa_post_payment_v1", PIN.MESA]]
    .every(([n, h]) => { const f = PF.FN.find((x) => x.sig.startsWith("public." + n + "(")); return f && f.states[150] === h; })
  && (PF.TRIGGERS.find((t) => t.name === "service_closeouts_terminal_close_v1") || { states: {} }).states[150] === "CREATE CONSTRAINT TRIGGER service_closeouts_terminal_close_v1 AFTER INSERT ON public.service_closeouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_closeout_requires_terminal_close_v1()");
check("post-conditions: posture of the new functions (INVOKER, search_path, service_role only), exact trigger, the 150 + 145 blocks once each, Mesa posture unchanged, every other function byte-identical",
  /must be SECURITY INVOKER, search_path public, pg_temp, EXECUTE for service_role only/.test(fwd) && /not installed exactly as certified/.test(fwd) && /the 150 block and the 145 block exactly once each/.test(fwd)
  && /owner \/ SECURITY \/ search_path \/ ACL \/ signature \/ return of mesa_post_payment_v1 changed/.test(fwd) && /other functions changed/.test(fwd));
check("the rollback refuses unless every 150 object is the certified one, drops the trigger + four functions and restores the 145 Mesa body VERBATIM",
  Object.values(PIN).every((h) => rbk.includes("'" + h + "'")) && /DROP TRIGGER service_closeouts_terminal_close_v1 ON public\.service_closeouts;/.test(rbk)
  && ["service_closeout_requires_terminal_close_v1()", "close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])", "service_close_live_evidence_v1(uuid)", "service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)"].every((sig) => rbk.includes("DROP FUNCTION public." + sig + ";"))
  && MESA_RBK === MESA145 && /IS DISTINCT FROM '94867e165d0732f36ae4692fc6998c58'/.test(rbk));

console.log("\n── backend wiring ──");
const ENGINE = read("src/serviceSessions/serviceLifecycleEngine.js");
check("the engine's only terminal step is transition.closeWithEvidence (main path + CASE B); the bare close and the 149 step alone are never called",
  (ENGINE.match(/transition\.closeWithEvidence\(/g) || []).length === 2 && !/transition\.closeAndCompleteAttempt\(/.test(ENGINE) && !/transition\.close\(/.test(ENGINE));
check("the engine reads the service's receipts BEFORE it builds the reconciliation, on both paths", ENGINE.indexOf("receiptIds = await readReceiptIds(serviceSessionId);") < ENGINE.indexOf("const reconciliationArgs = await reconciliation.buildRpcArgs(")
  && ENGINE.indexOf("resumeReceiptIds = await readReceiptIds(serviceSessionId);") < ENGINE.indexOf("resumeReconciliation = await reconciliation.buildRpcArgs("));
check("a stale round supersedes its attempt and starts a fresh one, bounded (3 rounds), and is never reported as success",
  /const MAX_EVIDENCE_ROUNDS = 3;/.test(ENGINE) && /attempts\.supersede\(\{ closeoutCorrelationId: outcome\.closeoutCorrelationId, actor, reason: "CLOSE_EVIDENCE_STALE" \}\)/.test(ENGINE) && /code: "V3_CLOSE_EVIDENCE_STALE"/.test(ENGINE)
  && /transitionResult\.code === "CLOSE_EVIDENCE_STALE" \? "V3_CLOSE_COMMITTED_EVIDENCE_STALE"/.test(ENGINE));
check("a resumed attempt computes its closeout from ITS snapshot (ALREADY_CAPTURED), never from newer reads", /if \(captureResult\.created === false\) \{[\s\S]{0,400}\(\{ orders, tableSessions, financialEvents, orderObligations \} = frozen\);/.test(ENGINE));
check("resource policy registers rpc/close_service_session_with_evidence_v1 (POST)", /entry\('rpc\/close_service_session_with_evidence_v1', KIND\.RPC, \['POST'\]/.test(read("src/utils/supabaseResourcePolicy.js")));
check("the Mesa HTTP layer answers ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED as a typed 409 conflict", /'ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED',\n  \]\);/.test(read("src/tables/mesaHttpHandlers.js")));

console.log("\n── transition wire contract (closeWithEvidence) ──");
const { createServiceLifecycleV3Transition } = require("../src/serviceSessions/serviceLifecycleV3Transition");
(async () => {
  const S = "11111111-1111-4111-8111-111111111111", C = "22222222-2222-4222-8222-222222222222";
  const att = (o = {}) => ({ closeout_correlation_id: C, service_session_id: S, status: "completed", ...o });
  const T = (fn) => createServiceLifecycleV3Transition({ rpc: fn });
  const args = { serviceSessionId: S, closeoutCorrelationId: C, actor: "op", source: "test", closeout: { p_order_count: 1 }, reconciliation: { p_gross_cents: 1 }, receiptIds: ["r1"] };
  let seen = null;
  let r = await T(async (name, a) => { seen = { name, a }; return { ok: true, body: { ok: true, code: "V3_CLOSED", attemptCompleted: true, attempt: att(), session: { id: S, status: "closed" }, closeout: { id: "co" }, reconciliation: { id: "rec" } } }; }).closeWithEvidence(args);
  check("success only with THIS attempt completed; the RPC is close_service_session_with_evidence_v1 with the payloads passed through", r.success === true && r.closeoutRow.id === "co" && r.reconciliationRow.id === "rec"
    && seen.name === "close_service_session_with_evidence_v1" && seen.a.p_closeout.p_order_count === 1 && seen.a.p_reconciliation.p_gross_cents === 1 && seen.a.p_receipt_ids[0] === "r1" && seen.a.p_closed_by === "op");
  r = await T(async () => ({ ok: true, body: { ok: true, code: "V3_CLOSED", attemptCompleted: true, attempt: att({ closeout_correlation_id: "other" }) } })).closeWithEvidence(args);
  check("another attempt completed is NOT a success (V3_CLOSE_ATTEMPT_NOT_CONFIRMED)", r.success === false && r.code === "V3_CLOSE_ATTEMPT_NOT_CONFIRMED");
  r = await T(async () => ({ ok: true, body: { ok: false, code: "CLOSE_EVIDENCE_STALE", stale: ["service_facts"], closeoutCommitted: false } })).closeWithEvidence(args);
  check("CLOSE_EVIDENCE_STALE comes back typed with its reasons and whether a closeout was already committed", r.success === false && r.code === "CLOSE_EVIDENCE_STALE" && r.stale[0] === "service_facts" && r.closeoutCommitted === false);
  r = await T(async () => { throw new Error("network"); }).closeWithEvidence(args);
  check("a transport failure is a failure (outcome unknown), never a success", r.success === false && r.code === "SERVICE_LIFECYCLE_V3_TRANSITION_TRANSPORT_ERROR");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
