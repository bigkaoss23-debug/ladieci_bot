// tests/economy139to146Preflight.test.js — offline guard of scripts/economy139to146Preflight.js (the READ-ONLY rollout preflight of the Economy package 139 -> 156).
// The behaviour on a real catalogue (every mode at every step of the chain, the skipped-144 rollout, the negative controls) is certified on ephemeral PostgreSQL 17;
// this file proves what text can: the candidate files match their certified sha256, every rendered mode is one read-only SELECT, the per-mode expectations follow
// the chain exactly, and 144 is REQUIRED from BEFORE_145 on.
// Run: node tests/economy139to146Preflight.test.js

"use strict";

const PF = require("../scripts/economy139to146Preflight.js");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}
const stripLiterals = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").replace(/'(?:[^']|'')*'/g, "''");

console.log("\n── local files ──");
const files = PF.checkFiles();
check(`the files check passes (${files.filter((x) => x.ok).length}/${files.length}): presence + certified sha256 of the 32 files, the exact chain above 138, manifest rows, bodies, declared guards`, files.every((x) => x.ok), files.filter((x) => !x.ok).map((x) => x.k).join(" | "));

console.log("\n── the chain and the modes ──");
check("the chain is exactly 139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156 (no 141 / 142; 152-154 = the POST-ASTRA corrective cycle; 155-156 = the final liveness gate)", PF.CHAIN.map((c) => c.n).join(",") === "139,140,143,144,145,146,147,148,149,150,151,152,153,154,155,156");
// modes in which migration n is / is not applied (the chain is a strict prefix order)
const AFTER = (n) => Object.keys(PF.MODES).filter((m) => PF.MODES[m].includes(n));
const BEFORE = (n) => Object.keys(PF.MODES).filter((m) => !PF.MODES[m].includes(n));
check("seventeen modes, each the exact prefix of the chain applied before the named step", JSON.stringify(PF.MODES) === JSON.stringify({ PRE_APPLY: [], BEFORE_140: [139], BEFORE_143: [139, 140], BEFORE_144: [139, 140, 143], BEFORE_145: [139, 140, 143, 144], BEFORE_146: [139, 140, 143, 144, 145], BEFORE_147: [139, 140, 143, 144, 145, 146], BEFORE_148: [139, 140, 143, 144, 145, 146, 147], BEFORE_149: [139, 140, 143, 144, 145, 146, 147, 148], BEFORE_150: [139, 140, 143, 144, 145, 146, 147, 148, 149], BEFORE_151: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150], BEFORE_152: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151], BEFORE_153: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152], BEFORE_154: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153], BEFORE_155: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154], BEFORE_156: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155], POST_APPLY: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156] }));
const cancel = PF.FN.find((f) => /order_cancel_v1/.test(f.sig));
check("144 is REQUIRED from BEFORE_145 on: order_cancel_v1 must be the 144 body 26408ba3... in BEFORE_145 / BEFORE_146 / BEFORE_147 / BEFORE_148 / BEFORE_149 / POST_APPLY, the predecessor d75624fd... before",
  ["BEFORE_145", "BEFORE_146", "BEFORE_147", "BEFORE_148", "BEFORE_149", "POST_APPLY"].every((m) => PF.stateFor(cancel.states, PF.MODES[m]) === "26408ba35e2a43420273a6f4c126083d")
  && ["PRE_APPLY", "BEFORE_140", "BEFORE_143", "BEFORE_144"].every((m) => PF.stateFor(cancel.states, PF.MODES[m]) === "d75624fd1393d7dbf94d2155e19626b7"));
check("the 144 dependency of 145 / 146 is declared as enforced by THIS preflight only (no migration guard of 145..150 checks it; 151 guards the 144 cancel body itself)", PF.DEPENDENCIES.filter((d) => d.needs.includes(144) && d.m <= 150).every((d) => /PREFLIGHT ONLY/.test(d.enforcedBy))
  && PF.DEPENDENCIES.some((d) => d.m === 151 && d.needs.includes(144) && d.needs.includes(150) && /26408ba3/.test(d.enforcedBy)) && PF.DEPENDENCIES.some((d) => d.m === 145) && PF.DEPENDENCIES.some((d) => d.m === 146) && PF.DEPENDENCIES.some((d) => d.m === 147 && d.needs.includes(146))
  && PF.DEPENDENCIES.some((d) => d.m === 148 && d.needs.includes(145) && d.needs.includes(147) && /PREFLIGHT ONLY/.test(d.enforcedBy))
  && PF.DEPENDENCIES.some((d) => d.m === 149 && d.needs.includes(139) && d.needs.includes(148)));
const opp = PF.FN.find((f) => /order_post_payment_v1/.test(f.sig));
check("order_post_payment_v1 must be the 145 body 799f8093... in BEFORE_146 / BEFORE_147 / BEFORE_148 (148 ABSENT until BEFORE_149) and the 148 body e1ce2229... in BEFORE_149 / POST_APPLY",
  ["BEFORE_146", "BEFORE_147", "BEFORE_148"].every((m) => PF.stateFor(opp.states, PF.MODES[m]) === "799f8093328b4ac81e1ad5a3d37e1bb6") && ["BEFORE_149", "POST_APPLY"].every((m) => PF.stateFor(opp.states, PF.MODES[m]) === "e1ce2229f2418d6a7f91fe50771564f8")
  && ["PRE_APPLY", "BEFORE_140", "BEFORE_143", "BEFORE_144", "BEFORE_145", "BEFORE_146", "BEFORE_147", "BEFORE_148"].every((m) => !PF.MODES[m].includes(148)));
const atomic = PF.FN.find((f) => /close_service_session_and_complete_attempt_v1/.test(f.sig));
check("149: the atomic close f53a677b... and the two 149 trigger functions are ABSENT in every mode up to BEFORE_149 and present with their pins from BEFORE_150 on; the two 149 triggers follow the same rule",
  !!atomic && ["PRE_APPLY", "BEFORE_140", "BEFORE_143", "BEFORE_144", "BEFORE_145", "BEFORE_146", "BEFORE_147", "BEFORE_148", "BEFORE_149"].every((m) => PF.stateFor(atomic.states, PF.MODES[m]) === null)
  && ["BEFORE_150", "POST_APPLY"].every((m) => PF.stateFor(atomic.states, PF.MODES[m]) === "f53a677bf72aebdec2ce90eea8a81668")
  && ["service_session_close_attempt_terminal_v1", "service_closeout_attempt_open_service_v1"].every((n) => { const f = PF.FN.find((x) => x.sig.includes(n)); return f && PF.stateFor(f.states, PF.MODES.BEFORE_149) === null && !!PF.stateFor(f.states, PF.MODES.BEFORE_150) && !!PF.stateFor(f.states, PF.MODES.POST_APPLY); })
  && PF.TRIGGERS.filter((t) => t.states[149]).length === 2 && PF.TRIGGERS.filter((t) => t.states[149]).every((t) => PF.stateFor(t.states, PF.MODES.BEFORE_149) === null && /^CREATE CONSTRAINT TRIGGER .* DEFERRABLE INITIALLY DEFERRED FOR EACH ROW /.test(PF.stateFor(t.states, PF.MODES.BEFORE_150))));
// corrective slice 150
const fn150 = (n) => PF.FN.find((x) => x.sig.startsWith("public." + n + "("));
const NEW150 = { service_close_evidence_digest_v1: "a7f89499be50f338607ff64f8778f2ae", service_close_live_evidence_v1: "49163cc1ec55c7f2154e4d76ee77445c",
  close_service_session_with_evidence_v1: "a25b330f095ff3441bca034e79e750f7", service_closeout_requires_terminal_close_v1: "be58c0f28da316fcb8495be7676c2738" };
check("150: its four new functions are ABSENT in every mode before 150 and present with their pins once 150 is applied (the terminal step carries the 154 body once 154 is applied); its closeout trigger follows the same rule",
  Object.entries(NEW150).every(([n, pin]) => { const f = fn150(n); return f && BEFORE(150).every((m) => PF.stateFor(f.states, PF.MODES[m]) === null)
    && AFTER(150).every((m) => PF.stateFor(f.states, PF.MODES[m]) === (n === "close_service_session_with_evidence_v1" && PF.MODES[m].includes(154) ? "c57584ba03c40ee940e402188fd40d2d" : pin)); })
  && PF.TRIGGERS.length === 6 && (() => { const t = PF.TRIGGERS.find((x) => x.name === "service_closeouts_terminal_close_v1"); return t && t.rel === "public.service_closeouts"
    && BEFORE(150).every((m) => PF.stateFor(t.states, PF.MODES[m]) === null)
    && AFTER(150).every((m) => PF.stateFor(t.states, PF.MODES[m]) === "CREATE CONSTRAINT TRIGGER service_closeouts_terminal_close_v1 AFTER INSERT ON public.service_closeouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_closeout_requires_terminal_close_v1()"); })());
check("mesa_post_payment_v1 is the 145 body 94867e16... from BEFORE_146 through BEFORE_150 and the 150 body 2d6ebfe7... in POST_APPLY",
  (() => { const f = fn150("mesa_post_payment_v1"); return f && ["BEFORE_146", "BEFORE_147", "BEFORE_148", "BEFORE_149", "BEFORE_150"].every((m) => PF.stateFor(f.states, PF.MODES[m]) === "94867e165d0732f36ae4692fc6998c58")
    && PF.stateFor(f.states, PF.MODES.POST_APPLY) === "2d6ebfe704559dd5a9a083025fb77057"; })());
check("the closeout authorities 150 calls or relies on are pinned in EVERY mode, PRE_APPLY included (a drifted staging body stops the rollout before 139)",
  [["create_service_closeout", "e089a36c1cbdcfb1f148a86aaf0ae226"], ["create_service_closeout_reconciliation_v1", "f8f351a9ec2d2754220b95a165a3ae06"], ["capture_closeout_snapshot", "2a3a4b1d746f5bc549991e5f0cdd13c3"],
   ["supersede_closeout_attempt", "1ee565901cad6b66f2e92772aad902ea"], ["acquire_closeout_attempt", "e0e510d074ce61a6cc6b7d505ac38012"], ["order_canonical_obligation_v1", "c68e831344fd537128608567727c2f9d"]]
    .every(([n, pin]) => { const f = fn150(n); return f && Object.keys(PF.MODES).every((m) => PF.stateFor(f.states, PF.MODES[m]) === pin); }));
check("150 declares its dependency on 145 (the Mesa body it extends) and 149 (the tip it guards on)", PF.DEPENDENCIES.some((d) => d.m === 150 && d.needs.includes(145) && d.needs.includes(149)));
{ const sql = PF.renderSql("BEFORE_150"); const post = PF.renderSql("POST_APPLY");
  check("BEFORE_150 renders ONE read-only SELECT that requires the 149 ledger row and forbids a 150 row; POST_APPLY requires the 150 row", /applied: 139, 140, 143, 144, 145, 146, 147, 148, 149;/.test(sql) && /pending: 150, 151, 152, 153, 154, 155, 156\)/.test(sql)
    && /\(150, '2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', false\)/.test(sql)
    && /\(150, '2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', true\)/.test(post)
    // (quoted literals stripped first: an expected trigger definition carried as a string, e.g. 'CREATE TRIGGER ...' since 151, writes nothing)
    && !/\b(INSERT INTO|UPDATE [a-z_.]+ SET|DELETE FROM|ALTER (TABLE|FUNCTION)|DROP (TABLE|FUNCTION|TRIGGER)|CREATE (TABLE|FUNCTION|TRIGGER)|TRUNCATE)\b/.test(sql.replace(/'(?:[^']|'')*'/g, "''"))); }
// final concurrency fix 151
{ const f = (n) => PF.FN.find((x) => x.sig.startsWith("public." + n + "("));
  const before = BEFORE(151);
  check("151: the shared gate order_economic_service_gate_v1 is ABSENT in every mode before 151 and present with its pin 3c8c4c46... from BEFORE_152 on",
    !!f("order_economic_service_gate_v1") && before.every((m) => PF.stateFor(f("order_economic_service_gate_v1").states, PF.MODES[m]) === null) && AFTER(151).every((m) => PF.stateFor(f("order_economic_service_gate_v1").states, PF.MODES[m]) === "3c8c4c46dac20285081b85a3313ef576"));
  check("151 replaces the shared obligation core (b4c358e2... -> 2c411d98...) and the totale revision trigger function (49387a6b... -> bfac4ec3...): the 150-state body in every mode before 151, the 151 body from BEFORE_152 on (152-154 do not touch them)",
    [["order_obligation_apply_adjustment_v1", "b4c358e2a3913ba110d400f07059e8e5", "2c411d98f63545c4a4b7d04fd9beb7fe"], ["order_obligation_revision_v1", "49387a6bf8e0ec66694d7bebe14d3d17", "bfac4ec3f428daa91d5d9505d8b1285a"]]
      .every(([n, a, b]) => !!f(n) && before.every((m) => PF.stateFor(f(n).states, PF.MODES[m]) === a) && AFTER(151).every((m) => PF.stateFor(f(n).states, PF.MODES[m]) === b)));
  check("the two adjustment callers and the open lock set 151 relies on are pinned in EVERY mode, PRE_APPLY included; the cancel caller is the 144 body from BEFORE_145 on",
    [["order_apply_commercial_adjustment_v1", "bfac890abc0e6103466649d37fe92ddf"], ["mesa_post_commercial_adjustment_v1", "76c4eb343b741fd1746aebdd738c7cea"], ["open_operational_service_v1", "497183409192e9a15c0f3b33c2d336ba"]]
      .every(([n, pin]) => !!f(n) && Object.keys(PF.MODES).every((m) => PF.stateFor(f(n).states, PF.MODES[m]) === pin))
      && ["BEFORE_151", "POST_APPLY"].every((m) => PF.stateFor(cancel.states, PF.MODES[m]) === "26408ba35e2a43420273a6f4c126083d"));
  check("the totale revision trigger 151 relies on is required, exactly as certified, in every mode",
    (() => { const t = PF.TRIGGERS.find((x) => x.name === "ordenes_order_obligation_revision_v1"); return t && t.rel === "public.ordenes" && Object.keys(PF.MODES).every((m) => PF.stateFor(t.states, PF.MODES[m]) === "CREATE TRIGGER ordenes_order_obligation_revision_v1 AFTER UPDATE OF totale ON public.ordenes FOR EACH ROW EXECUTE FUNCTION order_obligation_revision_v1()"); })());
  const sql = PF.renderSql("BEFORE_151"); const post = PF.renderSql("POST_APPLY");
  check("BEFORE_151 renders ONE read-only SELECT that requires the 150 ledger row and forbids a 151 row; POST_APPLY requires the 151 row",
    /applied: 139, 140, 143, 144, 145, 146, 147, 148, 149, 150;/.test(sql) && /pending: 151, 152, 153, 154, 155, 156\)/.test(sql)
      && /\(151, '2026-09-26_economic_close_gate_v1_migration_151\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', false\)/.test(sql)
      && /\(151, '2026-09-26_economic_close_gate_v1_migration_151\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', true\)/.test(post)
      && /\(150, '2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', true\)/.test(sql)); }
// POST-ASTRA corrective cycle 152 / 153 / 154
{ const f = (n) => PF.FN.find((x) => x.sig.startsWith("public." + n + "("));
  check("152 / 153 / 154: each new function is ABSENT in every mode before its migration and present with its certified pin from the next mode on",
    [["order_post_close_obligation_resolution_v1", 152, "d79f71a2a40350307493ea1807b5fa77"], ["order_apply_editor_patch_v1", 153, "d5f962866a565fe63eb0842124829cfe"], ["service_close_day_evidence_digest_v1", 154, "f637aa2eaa3baec55bf7e88332d3d345"]]
      .every(([n, k, pin]) => !!f(n) && BEFORE(k).every((m) => PF.stateFor(f(n).states, PF.MODES[m]) === null) && AFTER(k).every((m) => PF.stateFor(f(n).states, PF.MODES[m]) === pin)));
  check("154 replaces the terminal close step: the 150 body a25b330f... up to BEFORE_154, the 154 body c57584ba... from BEFORE_155 on (POST_APPLY included)",
    ["BEFORE_151", "BEFORE_152", "BEFORE_153", "BEFORE_154"].every((m) => PF.stateFor(f("close_service_session_with_evidence_v1").states, PF.MODES[m]) === "a25b330f095ff3441bca034e79e750f7")
      && ["BEFORE_155", "BEFORE_156", "POST_APPLY"].every((m) => PF.stateFor(f("close_service_session_with_evidence_v1").states, PF.MODES[m]) === "c57584ba03c40ee940e402188fd40d2d"));
  check("152 extends three order_obligations constraints and adds one: the pre-152 definition before 152, the 152 definition after (the absent one null before)",
    ["order_obligations_source_chk", "order_obligations_cause_presence_chk", "order_obligations_adjustment_provenance_chk", "order_obligations_post_close_resolution_chk"].every((n) => { const c = PF.CONSTRAINTS.find((x) => x.name === n); return c && c.rel === "public.order_obligations"
      && BEFORE(152).every((m) => PF.stateFor(c.states, PF.MODES[m]) === (n === "order_obligations_post_close_resolution_chk" ? null : c.states[0])) && AFTER(152).every((m) => PF.stateFor(c.states, PF.MODES[m]) === c.states[152]) && c.states[0] !== c.states[152]; })
      && PF.CONSTRAINTS.filter((c) => c.rel === "public.payment_transactions").length === 2);
  check("152 / 153 / 154 declare their dependencies (152 <- 151; 153 <- 151 + 152; 154 <- 150 + 151 + 152 + 153 and the backend deployed before it)",
    PF.DEPENDENCIES.some((d) => d.m === 152 && d.needs.includes(151)) && PF.DEPENDENCIES.some((d) => d.m === 153 && d.needs.includes(152))
      && PF.DEPENDENCIES.some((d) => d.m === 154 && [150, 151, 152, 153].every((n) => d.needs.includes(n)) && /BACKEND/.test(d.enforcedBy)));
  const sql = PF.renderSql("BEFORE_154"); const post = PF.renderSql("POST_APPLY"); const b152 = PF.renderSql("BEFORE_152");
  check("BEFORE_154 requires the 153 ledger row and forbids a 154 row; POST_APPLY requires the 154 row; the 152 column is required exactly from BEFORE_153 on",
    /applied: 139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153;/.test(sql) && /pending: 154, 155, 156\)/.test(sql)
      && /\(154, '2026-09-26_close_day_evidence_freshness_v1_migration_154\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', false\)/.test(sql)
      && /\(154, '2026-09-26_close_day_evidence_freshness_v1_migration_154\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', true\)/.test(post)
      && /resolution_service_session_id \(152\) present/.test(sql) && /resolution_service_session_id \(152\) absent/.test(b152)); }
// FINAL LIVENESS GATE 155 / 156
{ const f = (n) => PF.FN.find((x) => x.sig.startsWith("public." + n + "("));
  const P155 = [["start_rider_trip_v2", "0323fbb1bab76a12fd2be3fed0b3187e", "baa7e42e28b15565e93f5da66374a6a9"], ["giro_authority_create_or_move_v1", "e4966ba63a075f6914c26d6508cfef00", "b5823fc5417a92007295efe531a899f0"],
    ["giro_authority_attach_or_move_v1", "85fb8a84ed311edfa02c11a4c7f9afec", "4f39a046a0c4f04ef4ea5cc548328f03"], ["giro_authority_consume_intent_v1", "3dde47553cc347d097735df8ba7ca5aa", "2a59a168d43c398d9e34d3ae651d1ea4"]];
  check("155 replaces exactly the four Planner bodies: the predecessor pin in every mode before 155 (PRE_APPLY included), the 155 pin from BEFORE_156 on",
    P155.every(([n, a, b]) => !!f(n) && BEFORE(155).every((m) => PF.stateFor(f(n).states, PF.MODES[m]) === a) && AFTER(155).every((m) => PF.stateFor(f(n).states, PF.MODES[m]) === b))
      && PF.FN.filter((x) => x.states[155]).length === 4);
  check("156 adds close_gate_window_fact_insert_v1 (6ed381c0...) and its two BEFORE INSERT triggers (order_financial_events, cash_counts): absent in every mode before 156, exact in POST_APPLY",
    !!f("close_gate_window_fact_insert_v1") && BEFORE(156).every((m) => PF.stateFor(f("close_gate_window_fact_insert_v1").states, PF.MODES[m]) === null) && PF.stateFor(f("close_gate_window_fact_insert_v1").states, PF.MODES.POST_APPLY) === "6ed381c0bcfa60fb48250c5dbb63ef2c"
      && ["public.order_financial_events", "public.cash_counts"].every((rel) => { const t = PF.TRIGGERS.find((x) => x.name === "a0_close_gate_window_fact_v1" && x.rel === rel); return t && BEFORE(156).every((m) => PF.stateFor(t.states, PF.MODES[m]) === null)
        && PF.stateFor(t.states, PF.MODES.POST_APPLY) === "CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON " + rel + " FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1()"; }));
  check("155 / 156 declare their dependencies (155 <- 151 + 152 + 153 + 154; 156 <- 154 + 155), both DB-only",
    PF.DEPENDENCIES.some((d) => d.m === 155 && [151, 152, 153, 154].every((n) => d.needs.includes(n)) && /DB-only/.test(d.enforcedBy))
      && PF.DEPENDENCIES.some((d) => d.m === 156 && [154, 155].every((n) => d.needs.includes(n)) && /DB-only/.test(d.enforcedBy)));
  const b155 = PF.renderSql("BEFORE_155"); const b156 = PF.renderSql("BEFORE_156"); const post = PF.renderSql("POST_APPLY");
  check("BEFORE_155 requires the 154 ledger row and forbids 155 / 156; BEFORE_156 requires 155 and forbids 156; POST_APPLY requires both; the trigger checks are per relation",
    /pending: 155, 156\)/.test(b155) && /pending: 156\)/.test(b156) && /pending: none\)/.test(post)
      && /\(155, '2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', false\)/.test(b155)
      && /\(155, '2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', true\)/.test(b156)
      && /\(156, '2026-09-27_close_gate_on_window_facts_v1_migration_156\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', false\)/.test(b156)
      && /\(156, '2026-09-27_close_gate_on_window_facts_v1_migration_156\.sql', '[0-9a-f]{16}', '[0-9a-f]{64}', true\)/.test(post)
      && /t\.tgname = e\.name AND t\.tgrelid = to_regclass\(e\.rel\)/.test(post) && /exist on no relation other than the ones listed for them/.test(post)); }
check("the close_service_session_v3 (139) and complete_closeout_attempt bodies 149 calls are pinned in every mode from BEFORE_140 on",
  Object.keys(PF.MODES).filter((m) => m !== "PRE_APPLY").every((m) => PF.stateFor(PF.FN.find((f) => /close_service_session_v3/.test(f.sig)).states, PF.MODES[m]) === "a6680181760dd8dabfa29aa43c786906" && PF.stateFor(PF.FN.find((f) => /complete_closeout_attempt/.test(f.sig)).states, PF.MODES[m]) === "f96adc7871c50751fdd7a4b1aebf3783"));

console.log("\n── rendered SQL (every mode) ──");
for (const mode of Object.keys(PF.MODES)) {
  const sql = PF.renderSql(mode); const code = stripLiterals(sql);
  const ok = /^WITH\b/m.test(code) && (code.match(/;/g) || []).length === 1 && /;\s*$/.test(code)
    && !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COPY|CALL|DO|SET|RESET|LOCK|VACUUM|ANALYZE|COMMENT|SECURITY)\b/i.test(code.replace(/\bFOR\s+UPDATE\b/gi, "x"))
    && !/FOR\s+(UPDATE|SHARE|NO KEY|KEY)/i.test(code) && !/pg_advisory|nextval|setval|set_config|dblink|pg_read_file|lo_import/i.test(code);
  check(`${mode}: ONE read-only SELECT (single statement, no DML / DDL / locking / side-effect function outside string literals), ends with the VERDICT row`, ok && sql.includes(`'VERDICT ${mode}'`));
  const applied = PF.MODES[mode]; const tip = applied.length ? applied[applied.length - 1] : 138;
  check(`${mode}: expects ledger tip ${tip}, exactly the rows ${applied.join(",") || "(none)"} above 138, and the registry byte proof for each applied file`, sql.includes(`= ${tip}\n`) && sql.includes(`= '${applied.join(",")}'`) && PF.CHAIN.every((c) => sql.includes(`(${c.n}, '${c.file}', '${c.sha.slice(0, 16)}', '${c.sha}', ${applied.includes(c.n)})`)));
}
const post = PF.renderSql("POST_APPLY");
check("the isolation / encoding / version checks are present: 17.x, read committed (default + session), no override (this database, roles, functions), UTF8, byte-safe client, the 146 transport literal",
  /BETWEEN 170000 AND 179999/.test(post) && /default_transaction_isolation'\) = 'read committed'/.test(post) && /transaction_isolation'\) = 'read committed'/.test(post)
  && /setdatabase IN \(0, \(SELECT oid FROM pg_database WHERE datname = current_database\(\)\)\)/.test(post) && /rolconfig/.test(post) && /proconfig/.test(post)
  && /server_encoding'\) = 'UTF8'/.test(post) && /client_encoding'\) IN \('UTF8', 'SQL_ASCII'\)/.test(post) && /octet_length\('¬ß'\) = 4 AND md5\('¬ß'\) = '45e0e64ed4f04e4ea4e6e21148e2eadc'/.test(post));
check("no 141 / 142 anywhere in the expectations; the registry check is strict unless explicitly disabled for an ephemeral database", /apply_order IN \(141, 142\)/.test(post) && !/'1 matching statement\(s\)',\s*true/.test(post) && /'1 matching statement\(s\)',\s*true/.test(PF.renderSql("POST_APPLY", { noRegistry: true })));
let threw = false; try { PF.renderSql("BEFORE_142"); } catch (e) { threw = true; }
check("an unknown mode (e.g. BEFORE_142) is refused", threw);

console.log("\n── post-final-blind H-1: 149 + 150 are one guarded step ──");
check("every mode checks section E: no closeout committed for a service that is still open / closing",
  Object.keys(PF.MODES).every((m) => /SELECT 'E', 'no closeout committed for a service that is still open \/ closing/.test(PF.renderSql(m))
    && /JOIN public\.service_sessions s ON s\.id = c\.service_session_id WHERE s\.status IN \('open', 'closing'\)\)/.test(PF.renderSql(m))));
{ const r = require("child_process").spawnSync(process.execPath, [require("path").join(__dirname, "..", "scripts", "economy139to146Preflight.js"), "run", "--mode", "BEFORE_150"], { encoding: "utf8" });
  check("the CLI refuses BEFORE_150 as a resting mode (exit 1, before any connection) and names the guarded step", r.status === 1 && /economy149150GuardedStep\.js/.test(r.stderr)); }
check("150 is declared as applied together with 149 by the guarded step", PF.DEPENDENCIES.some((d) => d.m === 150 && /ONE guarded step/.test(d.enforcedBy)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
