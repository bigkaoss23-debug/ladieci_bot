// tests/port55PlannerD1SafetyParity.test.js
// ===========================================================================
// PORT-55 — D1 SAFETY PARITY.
//
// The three premium planner preview actions were restored onto this line from
// backup/v2-planner-rider-conflict-compatible-giro-2026-06-17. This line's
// src/core/delivery/planner.js was OLDER than the donor's in exactly one place:
// it had no D1 physical guard, so evaluateNewOrder could schedule a delivery
// whose forno_out lay in the PAST and still mark it "valid" — the operator
// could then confirm a physically impossible order (the can_confirm bug).
//
// This file is the proof that:
//   1. the guard is present and fires,
//   2. it does not fire one minute too eagerly (boundary is strict `<`),
//   3. ordinary future orders are still confirmable,
//   4. buildPlan — the only non-test consumer of this module on this line
//      (scripts/deliveryPlannerShadowReadOnly.js) — is byte-for-byte
//      unregressed against the pre-port committed version,
//   5. the preview layer never leaks a past forno_out to the client, and
//   6. the three actions are actually registered, so the frontend can never
//      fall back to "Planner no disponible" via an unknown-action 404 again.
//
// Run: node tests/port55PlannerD1SafetyParity.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { evaluateNewOrder, buildPlan, _internal } = require("../src/core/delivery/planner");
const { previewOrderPlanner } = require("../src/agents/previewOrderPlanner");
const { nowMadridHHMM, plannerBusinessDate } = require("../src/core/delivery/plannerClock");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? "  -> " + extra : ""}`); }
}
const ord = (o) => ({ tipo_consegna: "DOMICILIO", estado: "NUEVO", n_pizze: 1, ...o });
const sep = (r) => (r.options || []).find((o) => o && o.type === "separate") || null;

// margineCotturaMin default is 5 (DEFAULTS.margineCotturaMin, marked "D1").
const COTTURA = 5;

// ── 1. The guard fires: forno_out would be in the past ─────────────────────
console.log("\n-- 1. D1 fires on a physically impossible hora --");
{
  // now 20:00, delivery asked for 20:02, andata 5 => needed forno_out 19:57,
  // which is before now + cottura (20:05). Impossible.
  const r = evaluateNewOrder({ now: "20:00", orders: [] },
    ord({ id: "#new", zona: "Q1", hora: "20:02", andata_min: 5 }));
  const s = sep(r);
  check("separate option exists", !!s);
  check("status is blocked, NOT valid", s && s.status === "blocked", s && s.status);
  check("too_early flag set", !!(s && s.too_early === true));
  check("min_hora advertised", !!(s && s.min_hora), s && String(s.min_hora));
  check("min_hora = now + cottura + andata = 20:10", s && s.min_hora === "20:10", s && s.min_hora);
  check("required_forno_out NOT leaked (null)", s && s.required_forno_out === null, String(s && s.required_forno_out));
  check("salida NOT leaked (null)", s && s.salida === null, String(s && s.salida));
  check("reason names the minimum", !!(s && /muy pronta/.test(String(s.reason))), s && s.reason);
}

// ── 2. Boundary: exactly at the minimum is NOT too early ───────────────────
console.log("\n-- 2. D1 boundary is strict (< not <=) --");
{
  // now 20:00, andata 5 => earliest feasible forno_out 20:05, earliest delivery 20:10.
  const r = evaluateNewOrder({ now: "20:00", orders: [] },
    ord({ id: "#new", zona: "Q1", hora: "20:10", andata_min: 5 }));
  const s = sep(r);
  check("exactly-at-minimum is NOT too_early", !!s && !s.too_early, JSON.stringify(s && s.too_early));
  check("exactly-at-minimum exposes a forno_out", !!(s && s.required_forno_out), String(s && s.required_forno_out));
  const r2 = evaluateNewOrder({ now: "20:00", orders: [] },
    ord({ id: "#new", zona: "Q1", hora: "20:09", andata_min: 5 }));
  check("one minute earlier IS too_early", !!(sep(r2) && sep(r2).too_early === true));
}

// ── 3. Ordinary future order stays confirmable ─────────────────────────────
console.log("\n-- 3. normal future order unaffected --");
{
  const r = evaluateNewOrder({ now: "17:00", orders: [] },
    ord({ id: "#new", zona: "Q1", hora: "20:00", andata_min: 5 }));
  const s = sep(r);
  check("status valid", s && s.status === "valid", s && s.status);
  check("no too_early flag at all", s && !("too_early" in s));
  check("forno_out present", !!(s && s.required_forno_out), String(s && s.required_forno_out));
  check("salida present", !!(s && s.salida), String(s && s.salida));
}

// ── 4. buildPlan non-regression vs the pre-port committed planner ──────────
console.log("\n-- 4. buildPlan unregressed vs HEAD (pre-port) --");
{
  const rel = "src/core/delivery/planner.js";
  const tmp = path.join(ROOT, "src/core/delivery/planner.PORT55HEAD.tmp.js");
  let headMod = null;
  try {
    fs.writeFileSync(tmp, execFileSync("git", ["show", `HEAD:${rel}`], { cwd: ROOT, encoding: "utf8" }));
    headMod = require(tmp);
  } catch (e) {
    check("could load HEAD planner for comparison", false, String(e.message || e));
  }
  if (headMod) {
    const snapshots = [
      { now: "17:00", orders: [ord({ id: "#001", zona: "Q1", hora: "20:00", andata_min: 1 }),
                               ord({ id: "#002", zona: "Q1", hora: "20:00", andata_min: 4 })] },
      { now: "17:00", driver: { libero_desde: "20:37" },
        orders: [ord({ id: "Q5a", zona: "Q5", hora: "20:35", andata_min: 12 }),
                 ord({ id: "Q5b", zona: "Q5", hora: "20:35", andata_min: 13 }),
                 ord({ id: "Q5c", zona: "Q5", hora: "20:35", andata_min: 14 })] },
      { now: "20:00", orders: [] },
      { now: "19:30", orders: [ord({ id: "#a", zona: "Q2", hora: "21:00", andata_min: 8 }),
                               ord({ id: "#b", zona: "Q3", hora: "21:10", andata_min: 9 }),
                               ord({ id: "#c", zona: "Q2", hora: "21:05", andata_min: 8 })] },
    ];
    let same = true, firstBad = "";
    snapshots.forEach((snap, i) => {
      const a = JSON.stringify(buildPlan(JSON.parse(JSON.stringify(snap))));
      const b = JSON.stringify(headMod.buildPlan(JSON.parse(JSON.stringify(snap))));
      if (a !== b) { same = false; if (!firstBad) firstBad = `snapshot #${i}`; }
    });
    check("buildPlan output identical to HEAD on 4 snapshots", same, firstBad);
    // And prove the comparison is not vacuous: evaluateNewOrder MUST differ.
    const impossible = ord({ id: "#new", zona: "Q1", hora: "20:02", andata_min: 5 });
    const mine = sep(evaluateNewOrder({ now: "20:00", orders: [] }, impossible));
    const theirs = sep(headMod.evaluateNewOrder({ now: "20:00", orders: [] }, impossible));
    check("anti-no-op: HEAD evaluateNewOrder lacked the guard", !!(mine.too_early && !theirs.too_early),
      `mine=${mine.too_early} head=${theirs.too_early}`);
    check("anti-no-op: HEAD would have said valid (the bug)", theirs.status === "valid", theirs.status);
    try { fs.unlinkSync(tmp); } catch (_) {}
    delete require.cache[require.resolve(tmp)];
  }
}

// ── 5. Preview layer never exposes an impossible confirmation ──────────────
console.log("\n-- 5. previewOrderPlanner refuses to confirm a past forno_out --");
{
  const deps = {
    now: () => "20:00",
    resolveDeliveryFields: async () => ({ zona: "Q1", durata_andata_min: 5, geo_source: "test" }),
    loadPlannerSnapshot: async () => ({ now: "20:00", orders: [] }),
  };
  const run = async () => {
    const impossible = await previewOrderPlanner(
      { tipo_consegna: "DOMICILIO", direccion: "test 1", hora: "20:02" }, deps);
    const rec = impossible.recommendation || {};
    check("ok payload returned", impossible.ok === true, JSON.stringify(impossible.error || ""));
    check("can_confirm_requested_hora = false", rec.can_confirm_requested_hora === false,
      String(rec.can_confirm_requested_hora));
    check("forno_out NOT leaked to client", rec.forno_out === null, String(rec.forno_out));
    check("salida_driver NOT leaked to client", rec.salida_driver === null, String(rec.salida_driver));
    check("reason = requested_hora_too_soon", rec.reason === "requested_hora_too_soon", String(rec.reason));
    check("recommended_hora falls back to a feasible time", !!rec.recommended_hora, String(rec.recommended_hora));

    const fine = await previewOrderPlanner(
      { tipo_consegna: "DOMICILIO", direccion: "test 1", hora: "21:00" }, deps);
    const rec2 = fine.recommendation || {};
    check("feasible order IS confirmable", rec2.can_confirm_requested_hora === true,
      String(rec2.can_confirm_requested_hora));
    check("feasible order exposes forno_out", !!rec2.forno_out, String(rec2.forno_out));
  };
  return run().then(finish, (e) => { check("preview chain threw", false, String(e && e.message)); finish(); });
}

function finish() {
  // ── 6. Registration regression guard (anti "unknown action") ─────────────
  console.log("\n-- 6. the three actions are actually registered --");
  const ACTIONS = ["previewOrderPlanner", "previewStrategicOpportunities", "previewManualGiroRoute"];
  const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const roles = require("../src/auth/legacyActionRoles");
  const policy = require("../src/auth/actionPolicyRegistry");
  const contract = require("../src/auth/authorizationContract");
  for (const a of ACTIONS) {
    check(`${a}: dispatcher branch present`, indexSrc.includes(`action === "${a}"`));
    check(`${a}: known to the LIVE role map`, roles.isKnownAction(a));
    check(`${a}: admin allowed`, roles.isAllowed("admin", a));
    check(`${a}: operator allowed`, roles.isAllowed("operator", a));
    check(`${a}: rider DENIED`, !roles.isAllowed("rider", a));
    check(`${a}: in B4 canonical actions`, contract.CANONICAL_ACTIONS.includes(a));
    check(`${a}: in V3-A policy registry`, !!policy.getActionPolicy(a));
    check(`${a}: V3-A resolves operator+admin roles`, policy.isKnownAction(a));
  }

  // ── 7. read-only guarantee over the ported modules ───────────────────────
  console.log("\n-- 7. ported planner modules perform no writes --");
  const PORTED = [
    "src/agents/previewOrderPlanner.js", "src/agents/previewStrategicOpportunities.js",
    "src/agents/previewManualGiroRoute.js", "src/agents/resolveDeliveryFieldsReadOnly.js",
    "src/core/delivery/plannerSnapshot.js", "src/core/delivery/readOnlyRestDb.js",
    "src/core/delivery/premiumPlannerBridge.js", "src/core/delivery/premiumPlannerOpportunities.js",
    "src/core/delivery/strategicOpportunities.js", "src/core/delivery/routeTimeline.js",
    "src/core/delivery/routeImpact.js", "src/core/delivery/riderSaving.js",
    "src/core/delivery/deliveryChannels.js", "src/core/delivery/deliveryLegs.js",
    "src/core/delivery/deliveryProposalSelector.js",
  ];
  const WRITE_RE = /\b(sbInsert|sbUpdate|sbUpsert|sbDelete)\b|['"]\s*(POST|PATCH|PUT|DELETE)\s*['"]/;
  // Strip comments first: several of these files DOCUMENT their read-only
  // contract by naming the write helpers they refuse to use ("nessun sbInsert
  // /sbUpdate/..."), and a prose promise must not read as a violation.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:'"\`])\/\/.*$/, "$1")).join("\n");
  for (const rel of PORTED) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    const m = src.match(WRITE_RE);
    check(`${rel}: no write verb in code`, !m, m ? m[0] : "");
  }

  // ── 8. the clock helper speaks this line's Business Day ──────────────────
  console.log("\n-- 8. plannerClock uses the 04:00 Business Day, not the donor's 06:00 --");
  check("03:30 Madrid belongs to the previous business day",
    plannerBusinessDate(new Date("2026-08-25T01:30:00Z")) === "2026-08-24");
  check("04:30 Madrid belongs to the same business day",
    plannerBusinessDate(new Date("2026-08-25T02:30:00Z")) === "2026-08-25");
  check("05:30 Madrid is NOT pushed back (donor's 06:00 shift would have)",
    plannerBusinessDate(new Date("2026-08-25T03:30:00Z")) === "2026-08-25");
  check("nowMadridHHMM renders HH:MM", /^\d{2}:\d{2}$/.test(String(nowMadridHHMM())), String(nowMadridHHMM()));
  check("nowMadridHHMM never renders 24:00",
    nowMadridHHMM(new Date("2026-08-24T22:00:00Z")) === "00:00",
    String(nowMadridHHMM(new Date("2026-08-24T22:00:00Z"))));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
