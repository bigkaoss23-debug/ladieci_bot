"use strict";
// P0-C1 — RUNTIME LIFECYCLE AUTHORITY + AVAILABILITY CONTAINMENT — static guard.
//
// Source-inspection proof (not just behavioral tests) of the two structural
// claims SERVICE_LIFECYCLE_ECONOMIC_BOUNDARY_AUDIT_REPORT.md's root-cause
// audit and P0_C1_RUNTIME_LIFECYCLE_AUTHORITY_REPORT.md both depend on:
//
//   1. Every real, reachable call site of performIncidentSafeRollover — the
//      V2 incident-safe orchestrator that actually mutates lifecycle state —
//      sits behind the SAME LEGACY_AUTOMATIC_LIFECYCLE_ENABLED-style gate.
//      Before P0-C1, ensureServiceSession.js's silent recovery pre-check was
//      the one exception; this test locks in that it no longer is, and fails
//      loudly if a future edit ever reintroduces an ungated call site.
//   2. serviceLifecycleEngine.js's closeServiceV3 (V3's close engine) remains
//      unreachable from any live entry point. This is a deliberate
//      containment decision (V3_RUNTIME_CUTOVER_REMAINING — see the P0-C1
//      report), not an oversight — this guard exists so a future session
//      cannot silently wire V3 in as a FIFTH mutation path without a
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

  // ── Claim 2: V3's close engine remains unreachable — deliberate containment ─
  const v3EngineFile = "serviceLifecycleEngine";
  const scanTargets = ["index.js", "src/utils/servizio.js", "src/serviceSessions/incidentSafeRollover.js", "src/serviceSessions/ensureServiceSession.js"];
  for (const rel of scanTargets) {
    const stripped = readStripped(rel);
    assert(
      `${rel}: does not require/import ${v3EngineFile}.js (V3 close engine stays unreachable — containment, not cutover, per P0-C1)`,
      !new RegExp(`require\\([^)]*${v3EngineFile}['"]\\)`).test(stripped),
    );
  }
  // Walk src/ once more, generically, so this guard also catches a new file
  // that requires it from anywhere — not just the four historically-relevant
  // ones above.
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
    "src/**/*.js (excluding the engine's own files): zero files require serviceLifecycleEngine.js — V3 has no reachable caller anywhere in application code",
    requiringFiles.length === 0,
    JSON.stringify(requiringFiles.map((f) => path.relative(ROOT, f))),
  );

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
