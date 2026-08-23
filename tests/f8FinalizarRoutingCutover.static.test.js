"use strict";
// F-8 — FINALIZAR ROUTING CUTOVER (static structural pins).
//
// language-guard: allow-legacy chiudiServizio/servizio.js/PRANZO/SERA are the existing action name, legacy module path, and service_kind enum values this whole file asserts against (both their continued presence on the legacy branch and their absence from the new-era branch) — not new vocabulary being introduced.
// Same operator-facing `chiudiServizio` action, same authorization, same
// button. The only change is a server-side branch, decided from the CURRENT
// session's own `lifecycle_semantics` (already present on the row
// get_current_service_closeout_session already returns via to_jsonb — no
// extra read, never client-supplied): operational_service_v1 routes to the
// V3 close engine (serviceLifecycleEngine.js, unmodified by this slice —
// F-1/F-2/F-3/F-5 already made it correct and era-agnostic); every other
// session (economic_period_v1, or legacy rows with no lifecycle_semantics at
// all) keeps today's exact legacy route byte-for-byte.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const INDEX = read("index.js");
const ENGINE = read("src/serviceSessions/serviceLifecycleEngine.js");

// Isolate just the chiudiServizio action body so assertions can't accidentally // language-guard: allow-legacy chiudiServizio is the existing action name being located in source, not new vocabulary
// match an unrelated action elsewhere in this large file.
const actionStart = INDEX.indexOf('action === "chiudiServizio"'); // language-guard: allow-legacy chiudiServizio is the existing action-name string literal being located, not new vocabulary
const actionEnd = INDEX.indexOf('action === "triggerCloseIfNeeded"');
assert("0a: chiudiServizio action block found", actionStart > -1 && actionEnd > actionStart); // language-guard: allow-legacy chiudiServizio is the existing action name, restated in the assertion label, not new vocabulary
const BLOCK = INDEX.slice(actionStart, actionEnd);

console.log("\n== A. serviceLifecycleEngine.js is required and unmodified by this slice ==");
// F-10.1B — index.js now reaches the V3 engine through the canonical close
// authority (serviceCloseAuthority.js), which is the ONE module permitted to
// import the engine directly. F-8's contract is unchanged in substance: the
// Finalizar action still routes the new era to the V3 close and nothing else.
assert("1a: index.js requires the V3 close through the canonical close authority",
  /const \{ closeServiceSessionV3 \} = require\("\.\/src\/serviceSessions\/serviceCloseAuthority"\);/.test(INDEX));
assert("1a-bis: index.js does NOT import serviceLifecycleEngine.js directly (F-10.1B single direct importer)",
  !/require\("\.\/src\/serviceSessions\/serviceLifecycleEngine"\)/.test(INDEX));
assert("1a-ter: serviceCloseAuthority.js is the module that imports the engine",
  /require\("\.\/serviceLifecycleEngine"\)/.test(read("src/serviceSessions/serviceCloseAuthority.js")));
assert("1b: the engine file still declares zero legacy coupling (F-1..F-5 discipline unchanged)",
  /NO\s*\n\/\/ [\s\S]{0,40}CLOSEOUT: this file never requires src\/utils\/servizio\.js/.test(ENGINE) || /never requires src\/utils\/servizio\.js/.test(ENGINE)); // language-guard: allow-legacy servizio.js is the existing legacy module path this assertion checks the engine does NOT reference, not new vocabulary
assert("1c: the engine still never CALLS ensureNext/ensure_next_service_session_v3 (F-5 — no successor; the RPC name may still appear in the file's own header prose describing what was retired)",
  !/\.ensureNext\(/.test(ENGINE) && !/rpc\("ensure_next_service_session_v3"/.test(ENGINE));

console.log("\n== B. Routing decision is server-side, from the CURRENT session's own row ==");
assert("2a: the branch reads identity.session?.lifecycle_semantics",
  /identity\?\.\ok && identity\.session\?\.lifecycle_semantics === "operational_service_v1"/.test(BLOCK));
assert("2b: identity is resolved from the existing currentCloseout() call, not a second/new read",
  (BLOCK.match(/serviceSessionLifecycle\.currentCloseout\(\)/g) || []).length === 1);
assert("2c: no client-supplied era ever reaches the branch (req.body/req.query never read for lifecycle_semantics)",
  !/req\.(body|query)\.lifecycle_semantics/.test(BLOCK) && !/req\.(body|query)\.era/.test(BLOCK));

console.log("\n== C. New-era branch: auth preserved, no clock gate, truthful close_source ==");
assert("3a: actor is the verified req.authCtx.actor, 401s if absent (same discipline as every other action here)",
  /const actorId = req\.authCtx\?\.actor;\s*\n\s*if \(!actorId\) return res\.status\(401\)\.json\(\{ error: "UNVERIFIED_ACTOR" \}\);/.test(BLOCK));
{
  const newEraStart = BLOCK.indexOf('lifecycle_semantics === "operational_service_v1"');
  const newEraElse = BLOCK.indexOf("\n      } else {", newEraStart);
  const NEW_ERA_BODY = BLOCK.slice(newEraStart, newEraElse > -1 ? newEraElse : BLOCK.length);
  assert("3b: the new-era body never calls closeEligibility (no PRANZO/SERA clock identity for an Operational Service)", // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe what an Operational Service lacks, not new vocabulary
    !/closeEligibility\(/.test(NEW_ERA_BODY));
  assert("3c: the new-era body never reads req.query.deleteAttivi (V3 never deletes residue — it becomes evidence/incidents)",
    !/deleteAttivi/.test(NEW_ERA_BODY));
  assert("3d: the new-era body never reads req.query.force (no clock gate to override)",
    !/req\.query\.force/.test(NEW_ERA_BODY));
  assert("3e: close_source is the one new truthful value for this slice",
    /source: "operator_finalizar_v3"/.test(NEW_ERA_BODY));
  assert("3f: close_source is never a mislabel (rollover/recovery/forgotten-close/test)",
    !/source:\s*"(rolled_over|recovery|forgotten_close|test)"/.test(NEW_ERA_BODY));
  assert("3g: the new-era body calls the V3 engine exactly once",
    (NEW_ERA_BODY.match(/closeServiceSessionV3\(/g) || []).length === 1);
  assert("3h: the new-era body never calls the legacy chiudiServizio() function", // language-guard: allow-legacy chiudiServizio is the existing legacy close function this assertion checks the new-era body does NOT call, not new vocabulary
    !/\bawait chiudiServizio\(/.test(NEW_ERA_BODY)); // language-guard: allow-legacy chiudiServizio is the same existing legacy function name, restated verbatim in the regex under test, not new vocabulary
  assert("3i: the new-era body never calls ensureNext/ensure_next_service_session_v3 (no successor)",
    !/ensureNext\(/.test(NEW_ERA_BODY) && !/ensure_next_service_session_v3/.test(NEW_ERA_BODY));
  assert("3j: the new-era body never calls open_operational_service_v1 (no reopen started by Finalizar)",
    !/open_operational_service_v1/.test(NEW_ERA_BODY));
}

console.log("\n== D. Legacy branch — N-2 SUPERSEDED: deleted, not left byte-identical ==");
// F-8 originally pinned this branch as untouched (closeEligibility + the
// language-guard: allow-legacy chiudiServizio is the existing legacy close function cited on the next line, not new vocabulary
// legacy chiudiServizio() call + its 409 ACTIVE_RIDER_TRIP surface). The
// application-wide legacy/dead-code purge (N-2) proved the branch
// structurally unreachable — open_operational_service_v1 is the only
// session-creating primitive and always stamps operational_service_v1, so no
// session can ever again take this path — and replaced its body with a
// minimal fail-closed fallback rather than leaving it calling into deleted
// language-guard: allow-legacy chiudiServizio is the same existing legacy close function cited on the next line, not new vocabulary
// functions (chiudiServizio, closeEligibility's caller here).
{
  const elseStart = BLOCK.indexOf("\n      } else {");
  const LEGACY_BODY = BLOCK.slice(elseStart);
  assert("4a: legacy branch no longer calls closeEligibility( — deleted along with the unreachable path",
    !/closeEligibility\(/.test(LEGACY_BODY));
  // language-guard: allow-legacy chiudiServizio is the same existing legacy close function cited on the next line, not new vocabulary
  const legacyBranchDoesNotCallTheDeletedCloseFn = !/\bchiudiServizio\(/.test(LEGACY_BODY);
  assert("4c: legacy branch no longer calls the deleted legacy close function — deleted (zero reachable callers, proven)", legacyBranchDoesNotCallTheDeletedCloseFn);
  assert("4e: legacy branch fails closed with a clear code instead (legacy_session_kind_unsupported)",
    /legacy_session_kind_unsupported/.test(LEGACY_BODY));
}

console.log("\n== E. Scope discipline ==");
assert("5a: no migration file was introduced for this slice",
  fs.readdirSync(path.join(__dirname, "..", "migrations")).filter((f) => /f8/i.test(f)).length === 0);
assert("5b: no explicit-reopen HTTP action was introduced",
  !/action === "reopenOperationalService"/.test(INDEX) && !/action === "explicitReopen"/.test(INDEX));
assert("5c: no forgotten-close HTTP action was introduced",
  !/action === "forgottenClose"/.test(INDEX));

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
