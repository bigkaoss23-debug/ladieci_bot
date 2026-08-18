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

  // ── Claim 1a: index.js's 3 automatic entry points are still gated ────────
  const callSites = indexJs.split("performIncidentSafeRollover(").length - 1;
  assert("index.js: exactly 3 real call sites of performIncidentSafeRollover( (unchanged count — no new automatic entry point silently added)", callSites === 3, `found ${callSites}`);

  const flagDefLine = indexRaw.match(/const LEGACY_AUTOMATIC_LIFECYCLE_ENABLED\s*=\s*process\.env\.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED\s*!==\s*"false";/);
  assert("index.js: LEGACY_AUTOMATIC_LIFECYCLE_ENABLED is still defined with default-true (\"!== false\") semantics", !!flagDefLine);

  assert(
    "index.js: triggerCloseIfNeeded's call site is still literally inside an `if (!LEGACY_AUTOMATIC_LIFECYCLE_ENABLED)` skip guard",
    /if \(!LEGACY_AUTOMATIC_LIFECYCLE_ENABLED\) \{[\s\S]{0,400}?skipped: true, reason: "legacy_automatic_lifecycle_frozen"/.test(indexJs),
  );

  assert(
    "index.js: close-tick + boot catch-up registration is still gated by `if (LEGACY_AUTOMATIC_LIFECYCLE_ENABLED) { schedulaCloseTick(); catchUpChiusura(); }`",
    /if \(LEGACY_AUTOMATIC_LIFECYCLE_ENABLED\) \{\s*schedulaCloseTick\(\);\s*catchUpChiusura\(\);\s*\}/.test(indexJs),
  );

  // ── Claim 1b: ensureServiceSession.js's rollover call is now gated too ───
  assert(
    "ensureServiceSession.js: still exactly ONE call site of performRollover( (the DI-injected performIncidentSafeRollover)",
    (ensureJs.split("performRollover(").length - 1) === 1,
  );
  assert(
    "ensureServiceSession.js: automaticLifecycleEnabled is a DI parameter on createEnsureCurrentServiceSession, defaulting to the SAME env var + semantics as index.js's flag",
    /automaticLifecycleEnabled\s*=\s*\(\)\s*=>\s*process\.env\.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED\s*!==\s*"false"/.test(ensureJs),
  );
  assert(
    "ensureServiceSession.js: the rollover-due branch is gated by `isRolloverDue(...) && automaticLifecycleEnabled()` — not a bare isRolloverDue(...) check",
    /if \(isRolloverDue\(classification\) && automaticLifecycleEnabled\(\)\)/.test(ensureJs),
  );
  assert(
    "ensureServiceSession.js: no OTHER, ungated reference to performRollover slipped in outside that one gated branch",
    (() => {
      const idx = ensureJs.indexOf("performRollover(");
      if (idx === -1) return false;
      const before = ensureJs.slice(Math.max(0, idx - 400), idx);
      return /isRolloverDue\(classification\) && automaticLifecycleEnabled\(\)/.test(before);
    })(),
  );

  // ── Claim 2 (F-8 contract): V3 reachable from index.js ONLY inside the ───
  // ── era-aware branch; every other legacy file is still fully unreachable, ─
  // ── exactly as P0-C1 originally required. ────────────────────────────────
  const v3EngineFile = "serviceLifecycleEngine";

  // 2a-2c. The legacy/automatic machinery must still never reach V3 at all —
  // unchanged from the original P0-C1 claim, just no longer including index.js.
  const legacyOnlyScanTargets = [ // language-guard: allow-legacy servizio.js is the existing legacy module path in this fixture list, not new vocabulary
    "src/utils/servizio.js",
    "src/serviceSessions/incidentSafeRollover.js",
    "src/serviceSessions/ensureServiceSession.js",
  ];
  for (const rel of legacyOnlyScanTargets) {
    const stripped = readStripped(rel);
    assert(
      `${rel}: still does not require/import the V3 engine module (economic_period_v1/legacy machinery stays unreachable to V3, per F-8 point 6)`,
      !new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(stripped),
    );
  }

  // 2d. index.js DOES now require the engine — the F-8 contract itself.
  assert(
    `index.js: DOES require/import the V3 engine module (F-8 point 1 — the deliberate cutover this test now asserts, not the old blanket containment)`,
    new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(indexJs),
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
    "new-era branch: calls closeServiceV3( exactly once (F-8 point 2 — V3 reachable here, and only here)",
    (newEraBody.match(/closeServiceV3\(/g) || []).length === 1,
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

  assert(
    "legacy/economic_period_v1 branch: still exclusively uses closeEligibility( + the legacy close function (F-8 point 3 — transitional path untouched)",
    /closeEligibility\(/.test(legacyBody) && legacyBody.includes(legacyCloseFnCall),
  );
  assert(
    "legacy/economic_period_v1 branch: NEVER calls closeServiceV3( (F-8 point 6 — economic_period_v1 must never reach V3)",
    !/closeServiceV3\(/.test(legacyBody),
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
  const requiringFiles = allSrcFiles.filter((f) => new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(stripComments(fs.readFileSync(f, "utf8"))));
  assert(
    "src/**/*.js (excluding the engine's own files): zero files require the V3 engine module — index.js remains the ONLY authorized caller anywhere in application code",
    requiringFiles.length === 0,
    JSON.stringify(requiringFiles.map((f) => path.relative(ROOT, f))),
  );

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
