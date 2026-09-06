"use strict";
// P0-C1 — RUNTIME LIFECYCLE AUTHORITY + AVAILABILITY CONTAINMENT — static guard.
// UPDATED F-8 (owner-authorized, conscious change to this exact test — the
// tripwire's own stated purpose, not a silent weakening): Claim 2 below no
// longer asserts blanket V3 unreachability. F-8's whole job is to make
// the V3 close engine module reachable from index.js for ONE specific case.
// The old blanket claim is replaced by a NARROWER, still-strict one — see
// "Claim 2 (F-8 contract)" below. Claim 1 (performIncidentSafeRollover
// gating) is completely untouched by F-8 and asserted exactly as before.
//
// Source-inspection proof (not just behavioral tests) of the structural
// claims this codebase's runtime lifecycle authority depends on:
//
//   1. Every real, reachable call site of performIncidentSafeRollover — the
//      V2 incident-safe orchestrator that actually mutates lifecycle state —
//      sits behind the SAME LEGACY_AUTOMATIC_LIFECYCLE_ENABLED-style gate.
//      Before P0-C1, ensureServiceSession.js's silent recovery pre-check was
//      the one exception; this test locks in that it no longer is, and fails
//      loudly if a future edit ever reintroduces an ungated call site.
//   2. (F-8 contract) the V3 close engine's closeServiceV3 export is
// language-guard: allow-legacy chiudiServizio is the existing action name this whole Claim-2 paragraph describes the new reachability contract for, not new vocabulary
//      reachable from index.js, but ONLY from inside the chiudiServizio
//      action's server-side `lifecycle_semantics === "operational_service_v1"`
//      branch — never unconditionally, never from the legacy/else branch,
// language-guard: allow-legacy servizio.js/incidentSafeRollover.js/ensureServiceSession.js are the existing legacy module paths this paragraph names as still-unreachable, not new vocabulary
//      never from any OTHER file (the legacy close module, the incident-safe
//      rollover orchestrator, the session-ensure module — the economic_
//      period_v1/legacy machinery — must still never reach it at all), and
//      never via a second HTTP Finalizar action. The legacy branch must
// language-guard: allow-legacy chiudiServizio is the same existing legacy close function this line names as the transitional path's own call target, not new vocabulary
//      still exclusively use the transitional chiudiServizio()/
//      closeEligibility() path; the new-era branch must never itself call
// language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe a clock identity the new-era branch must never have, not new vocabulary
//      closeEligibility() (no PRANZO/SERA clock identity) or the legacy
// language-guard: allow-legacy chiudiServizio is the same existing legacy close function this line names as what the new-era branch must never call, not new vocabulary
//      chiudiServizio() function, must never read an era from req.body/
//      req.query (era is server-resolved only), and must never call
//      ensureNext()/ensure_next_service_session_v3/
//      open_operational_service_v1 (no successor, no reopen). This guard
//      exists so a future session cannot silently widen V3 to every era,
//      remove the branch, cross-route either era onto the other's path,
//      reintroduce a successor, or let the frontend pick the era — without a
//      conscious, reviewed change to this exact test.
//
// Comment-stripped scan, same technique as
// tests/serviceLifecycleV3EngineLegacyNonInterference.static.test.js — a
// file's own prose legitimately needs to name these identifiers to explain
// why/how; only an actual code reference counts.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

function stripComments(text) {
  let out = ""; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i]; const c2 = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && c2 === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c; out += c; i++;
      while (i < n) {
        if (text[i] === "\\") { out += text[i] + (i + 1 < n ? text[i + 1] : ""); i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readStripped = (rel) => stripComments(read(rel));

(async () => {
  console.log("\n== P0-C1 runtime lifecycle authority — static guard ==\n");

  const indexRaw = read("index.js");
  const indexJs = readStripped("index.js");
  const ensureJs = readStripped("src/serviceSessions/ensureServiceSession.js");

  // ── Claim 1a: SUPERSEDED BY N-2 (application-wide legacy/dead-code purge) ─
  // P0-C1 originally proved the 3 automatic entry points (close-tick, boot
  // catch-up, external-cron triggerCloseIfNeeded) were GATED by the same env
  // flag. That invariant no longer applies, because the whole subsystem is
  // gone, not gated: performIncidentSafeRollover/incidentSafeRollover.js had
  // zero reachable production callers (V3/serviceLifecycleEngine.js and F-10/
  // forgottenCloseRecovery.js both replaced it and never depended on it), and
  // its own call sites in index.js (serviceCloseTick, catchUpChiusura,
  // scheduleDeferredCloseRetry) were deleted along with it. The assertions
  // below are strictly stronger than the ones they replace — a gate can be
  // switched on by an env var, a deleted file/call site cannot.
  assert(
    "index.js: ZERO call sites of performIncidentSafeRollover( — the automatic scheduler is removed, not gated",
    (indexJs.split("performIncidentSafeRollover(").length - 1) === 0,
  );
  assert(
    "index.js: LEGACY_AUTOMATIC_LIFECYCLE_ENABLED is gone — no flag left to flip (comment-stripped: explanatory prose may still name the retired flag to say why it's absent, per this file's own established convention)",
    !/LEGACY_AUTOMATIC_LIFECYCLE_ENABLED/.test(indexJs),
  );
  assert(
    "index.js: serviceCloseTick/schedulaCloseTick/catchUpChiusura/scheduleDeferredCloseRetry/deferredCloseRetryPlan are not defined anywhere",
    !/function serviceCloseTick|function schedulaCloseTick|function catchUpChiusura|function scheduleDeferredCloseRetry|function deferredCloseRetryPlan/.test(indexJs),
  );
  assert(
    "index.js: triggerCloseIfNeeded is still registered (an external cron may still ping this URL) but is unconditionally, permanently inert",
    /action === "triggerCloseIfNeeded"\) \{[\s\S]{0,400}?result = \{ success: true, skipped: true, reason: "legacy_automatic_lifecycle_retired" \};/.test(indexJs),
  );
  assert(
    "src/serviceSessions/incidentSafeRollover.js: file no longer exists",
    !fs.existsSync(path.join(ROOT, "src/serviceSessions/incidentSafeRollover.js")),
  );
  assert(
    "src/serviceSessions/autoCloseDecision.js: file no longer exists",
    !fs.existsSync(path.join(ROOT, "src/serviceSessions/autoCloseDecision.js")),
  );
  assert(
    "src/serviceSessions/sessionRolloverClassification.js: file no longer exists",
    !fs.existsSync(path.join(ROOT, "src/serviceSessions/sessionRolloverClassification.js")),
  );
  assert(
    "src/serviceSessions/pendingActivityGuard.js: file no longer exists",
    !fs.existsSync(path.join(ROOT, "src/serviceSessions/pendingActivityGuard.js")),
  );
  // language-guard: allow-legacy servizio.js/chiudiServizio are the existing module path and deleted function name cited on the next line, not new vocabulary
  const legacyCloseFunctionGone = !/\bchiudiServizio\b/.test(readStripped("src/utils/servizio.js"));
  assert("the legacy close module has its deleted close function gone — not required/exported anywhere", legacyCloseFunctionGone);
  // language-guard: allow-legacy chiudiServizio/servizio are the same existing deleted function name and module path cited on the next line, not new vocabulary
  const indexNeverRequiresLegacyCloseFunction = !/\{[^}]*\bchiudiServizio\b[^}]*\}\s*=\s*require\(["']\.\/src\/utils\/servizio["']\)/.test(indexJs);
  assert("index.js does not require the deleted legacy close function from the legacy close module", indexNeverRequiresLegacyCloseFunction);

  // ── Claim 1b: SUPERSEDED BY LEGACY WRITER HARDENING ──────────────────────
  // P0-C1 originally proved the page-load ensure's rollover call was GATED by
  // the same env flag as index.js's three automatic triggers. That is no
  // longer the invariant, because the call site itself is gone: the silent
  // ensure can no longer close, roll or create anything under ANY
  // configuration. The assertions below are strictly stronger than the ones
  // they replace -- a gate can be switched on by an env var, an absent call
  // site cannot.
  assert(
    "ensureServiceSession.js: ZERO call sites of performRollover( — the page-load close is removed, not gated",
    (ensureJs.split("performRollover(").length - 1) === 0,
  );
  assert(
    "ensureServiceSession.js: no automaticLifecycleEnabled seam remains — there is no flag left to flip",
    !/automaticLifecycleEnabled/.test(ensureJs),
  );
  assert(
    "ensureServiceSession.js: does not import the rollover engine at all",
    !/require\(["'].*incidentSafeRollover["']\)/.test(ensureJs),
  );
  assert(
    "ensureServiceSession.js: no rollover classification is performed on the read path either",
    !/isRolloverDue|classifySessionForRollover/.test(ensureJs),
  );

  // ── Claim 2 (F-8 contract): V3 reachable from index.js ONLY inside the ───
  // ── era-aware branch; every other legacy file is still fully unreachable, ─
  // ── exactly as P0-C1 originally required. ────────────────────────────────
  const v3EngineFile = "serviceLifecycleEngine";
  // F-10.1B — the ONE module permitted to import the engine directly.
  const v3AuthorityFile = "serviceCloseAuthority";
  // Explicit allowlists. Deliberately exact relative paths, never globs or
  // directory exemptions: a new caller must be added here consciously.
  const AUTHORIZED_DIRECT_ENGINE_IMPORTERS = ["src/serviceSessions/serviceCloseAuthority.js"];
  // O-4 (ledger 108) — forgottenCloseRecovery.js, the second certified caller
  // F-10 added, is deleted: O-3 (ledger 107) made an open
  // operational_service_v1 unconditional continuity regardless of Business
  // Day, so the recovery it existed to perform can no longer be triggered.
  //
  // STALE SERVICE PROTECTION V1 (2026-09-06, migration 120) — a second
  // certified caller returns, EXACTLY the "future second caller" the
  // serviceCloseAuthority.js facade header explicitly reserved itself for:
  // src/serviceSessions/staleServiceRecovery.js. It runs the canonical
  // AUTO_CLOSE_SAFE predicate over existing facts and, only when safe,
  // finalizes a stale (past-Business-Day) service through this SAME facade —
  // never a second close implementation, and it holds no lifecycle policy
  // that would belong in the facade (2h below still asserts the facade is
  // transport-only).
  const AUTHORIZED_AUTHORITY_CALLERS = ["index.js", "src/serviceSessions/staleServiceRecovery.js"];
  assert(
    "O-4: src/serviceSessions/forgottenCloseRecovery.js file no longer exists",
    !fs.existsSync(path.join(ROOT, "src/serviceSessions/forgottenCloseRecovery.js")),
  );

  // 2a-2c. The legacy/automatic machinery must still never reach V3 at all —
  // unchanged from the original P0-C1 claim, just no longer including index.js.
  // incidentSafeRollover.js dropped from this list — N-2 deleted the file
  // entirely rather than leaving it to scan (see the file-existence
  // assertions in Claim 1a above).
  const legacyOnlyScanTargets = [ // language-guard: allow-legacy servizio.js is the existing legacy module path in this fixture list, not new vocabulary
    "src/utils/servizio.js",
    "src/serviceSessions/ensureServiceSession.js",
  ];
  for (const rel of legacyOnlyScanTargets) {
    const stripped = readStripped(rel);
    assert(
      `${rel}: still does not require/import the V3 engine module (economic_period_v1/legacy machinery stays unreachable to V3, per F-8 point 6)`,
      !new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(stripped),
    );
  }

  // 2d. F-10.1B — index.js reaches V3 through the canonical close authority,
  // and must NOT import the engine directly any more. F-10 legitimately added
  // a SECOND close caller (forgotten-close recovery, driven from order
  // intake) which O-4 (ledger 108) later retired once O-3 (ledger 107) made
  // that recovery structurally unreachable. The facade stays regardless of
  // caller count: exactly one file in the entire application imports the
  // engine.
  assert(
    `index.js: does NOT import the V3 engine directly (F-10.1B — the engine has exactly one direct importer, the canonical authority)`,
    !new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(indexJs),
  );
  assert(
    `index.js: DOES require/import the canonical close authority (F-8 point 1 preserved through the F-10.1B facade)`,
    new RegExp(`require\\([^)]*${v3AuthorityFile}['"]\\)`).test(indexJs),
  );

  // 2e. Exactly ONE Finalizar action block exists — no second/parallel
  const finalizarActionMarker = 'action === "chiudiServizio"'; // language-guard: allow-legacy chiudiServizio is the existing action-name string literal being located, not new vocabulary
  // HTTP endpoint was introduced (F-8 point 7).
  const finalizarActionBlockCount = indexJs.split(finalizarActionMarker).length - 1;
  assert(
    "index.js: exactly ONE Finalizar action block (no second/parallel Finalizar HTTP endpoint introduced)",
    finalizarActionBlockCount === 1,
    `found ${finalizarActionBlockCount}`,
  );

  // Isolate the Finalizar action body and its two branches, same technique as
  // tests/f8FinalizarRoutingCutover.static.test.js — but asserted
  // independently here, under this tripwire's own authority.
  const actionStart = indexJs.indexOf(finalizarActionMarker);
  const actionEnd = indexJs.indexOf('action === "triggerCloseIfNeeded"');
  const finalizarBlock = actionStart > -1 && actionEnd > actionStart ? indexJs.slice(actionStart, actionEnd) : "";
  assert("index.js: Finalizar action block is locatable for the branch checks below", finalizarBlock.length > 0);

  const newEraMarker = 'lifecycle_semantics === "operational_service_v1"';
  const newEraStart = finalizarBlock.indexOf(newEraMarker);
  assert(
    "index.js: the server-side lifecycle_semantics === \"operational_service_v1\" branch marker is present (F-8 point 2 — this is the ONLY thing this test recognizes as the era gate; removing it fails this test by design)",
    newEraStart > -1,
  );
  const newEraElse = finalizarBlock.indexOf("\n      } else {", newEraStart);
  const newEraBody = newEraStart > -1 ? finalizarBlock.slice(newEraStart, newEraElse > -1 ? newEraElse : finalizarBlock.length) : "";
  const legacyBody = newEraElse > -1 ? finalizarBlock.slice(newEraElse) : "";

  const legacyCloseFnCall = "await chiudiServizio("; // language-guard: allow-legacy chiudiServizio is the existing legacy close function name this constant holds for the branch checks below, not new vocabulary
  assert(
    "new-era branch: calls closeServiceSessionV3( exactly once (F-8 point 2 + F-10.1B — V3 reachable here, and only here, now via the canonical close authority)",
    (newEraBody.match(/closeServiceSessionV3\(/g) || []).length === 1,
  );
  assert(
    "new-era branch: NEVER calls the legacy close function (new-era must never fall back to the legacy close path)",
    !newEraBody.includes(legacyCloseFnCall),
  );
  assert(
    "new-era branch: NEVER calls closeEligibility( (F-8 point 5 — no legacy service_kind clock identity for an Operational Service)",
    !/closeEligibility\(/.test(newEraBody),
  );
  assert(
    "new-era branch: NEVER reads an era from req.body/req.query (F-8 point 4 — the frontend never chooses the era)",
    !/req\.(body|query)\.lifecycle_semantics/.test(newEraBody) && !/req\.(body|query)\.era/.test(newEraBody),
  );
  assert(
    "new-era branch: NEVER calls ensureNext/ensure_next_service_session_v3/open_operational_service_v1 (F-8 point 8 — no successor, no reopen)",
    !/ensureNext\(/.test(newEraBody) && !/ensure_next_service_session_v3/.test(newEraBody) && !/open_operational_service_v1/.test(newEraBody),
  );

  // N-2 — the legacy/economic_period_v1 branch used to exclusively use the
  // language-guard: allow-legacy chiudiServizio is the existing legacy close function cited on the next line, not new vocabulary
  // legacy close gate + its close function (F-8 point 3, "transitional path
  // untouched"). That transitional path is retired: the branch is now
  // structurally unreachable (open_operational_service_v1 is the only
  // session-creating primitive and always stamps operational_service_v1;
  // live DB has zero economic_period_v1 sessions open, none can be newly
  // opened), so it was replaced with a minimal fail-closed fallback rather
  // than left calling into deleted functions.
  const legacyBranchNoLongerCallsLegacyClose = !/closeEligibility\(/.test(legacyBody) && !legacyBody.includes(legacyCloseFnCall);
  assert("legacy/economic_period_v1 branch: no longer calls the clock gate or the deleted legacy close function — both deleted", legacyBranchNoLongerCallsLegacyClose);
  assert(
    "legacy/economic_period_v1 branch: fails closed with a clear code instead (legacy_session_kind_unsupported)",
    /legacy_session_kind_unsupported/.test(legacyBody),
  );
  assert(
    "legacy/economic_period_v1 branch: NEVER calls the V3 close (F-8 point 6 — economic_period_v1 must never reach V3)",
    !/closeServiceV3\(/.test(legacyBody) && !/closeServiceSessionV3\(/.test(legacyBody),
  );

  // 2f. Walk src/ once more, generically, so this guard also catches a new
  // file that requires the engine from anywhere OTHER than index.js — the
  // ONE authorized entry point under the F-8 contract.
  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith(".js") && !entry.name.includes(v3EngineFile)) out.push(full);
    }
    return out;
  }
  const allSrcFiles = walk(path.join(ROOT, "src"));
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

  // 2f. EXACTLY ONE application module may import the V3 engine directly.
  const engineImporters = allSrcFiles
    .filter((f) => new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(stripComments(fs.readFileSync(f, "utf8"))))
    .map(rel)
    .sort();
  assert(
    "src/**/*.js: the V3 engine has EXACTLY ONE direct importer — the canonical close authority (F-10.1B)",
    JSON.stringify(engineImporters) === JSON.stringify(AUTHORIZED_DIRECT_ENGINE_IMPORTERS),
    JSON.stringify(engineImporters),
  );
  assert(
    "index.js: still does not import the V3 engine directly (checked again in the generic walk)",
    !new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(indexJs),
  );

  // 2g. Only explicitly certified modules may call the canonical authority.
  const authorityCallers = allSrcFiles
    .filter((f) => new RegExp(`require\\([^)]*${v3AuthorityFile}['"]\\)`).test(stripComments(fs.readFileSync(f, "utf8"))))
    .map(rel)
    .filter((r) => !r.endsWith(`${v3AuthorityFile}.js`))
    .concat(new RegExp(`require\\([^)]*${v3AuthorityFile}['"]\\)`).test(indexJs) ? ["index.js"] : [])
    .sort();
  assert(
    "the canonical close authority has EXACTLY the certified caller — index.js (operator Finalizar); a second caller must be certified explicitly",
    JSON.stringify(authorityCallers) === JSON.stringify([...AUTHORIZED_AUTHORITY_CALLERS].sort()),
    JSON.stringify(authorityCallers),
  );

  // 2h. The authority is transport only — no lifecycle policy of its own.
  const authorityBody = stripComments(fs.readFileSync(path.join(ROOT, "src/serviceSessions/serviceCloseAuthority.js"), "utf8"));
  for (const f of ["abandoned_forgotten_close", "operator_finalizar_v3", "business_date", "rolled_over"]) {
    assert(
      `serviceCloseAuthority.js: holds no lifecycle policy of its own (must not contain "${f}")`,
      !authorityBody.includes(f),
    );
  }

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
