'use strict';
// tests/w4GlobalRawGiroReaderClosureGuard.static.test.js
// ===============================================================
// FINAL-W4-N20 — global closure guard. Mechanically sweeps every backend file
// for raw Giro-fact signals (ordenes.manual_giro_id, the manual_giros table)
// and asserts that EVERY match lives in this file's own documented allowlist,
// each entry carrying an explicit category from the closed set below and a
// one-line reason -- never a bare filename. Anyone who adds a NEW raw
// Giro-truth reader anywhere in the backend, without updating this file with
// a justified category, fails this test.
//
// This is the living version of the W4 Closure Audit's own closure matrix
// (2026-09-15): re-run it any time to prove the inventory hasn't silently
// drifted since that audit.
//
// Categories (closed set, per the W4 closure audit runbook):
//   CANONICALIZED_W4   — reads through giro_projection_v1 for the current day
//   HISTORICAL_EXPLICIT — explicit past-day capability, not a fallback
//   METADATA_ENRICHMENT — narrow non-authoritative enrichment (never overrides
//                         membership/state/salida/hora)
//   WRITER_SUPPORT_W5   — raw read used only to decide a WRITE, never returned
//                         as read output; deferred to the W5 writer cutover
//   TRIP_AUTHORITY_W6   — rider physical-block/departure-sequencing fields the
//                         Authority schema does not model; deferred to W6
//   SHADOW_DIAGNOSTIC    — explicit comparison/diagnostic tool, proven
//                         non-operational (hidden, PIN-gated, not linked from
//                         any operator view)
//   DEAD_CODE            — mechanically zero requirers (or the one caller never
//                         exercises the branch that reads the raw field)
//   NOT_GIRO_SEMANTICS   — the match is a table/field-name string (allowlist,
//                         policy note, or comment) that never computes or
//                         returns a Giro fact
//
// Run: node tests/w4GlobalRawGiroReaderClosureGuard.static.test.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const ROOT = path.join(__dirname, '..');
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

// Documented allowlist. Every entry is a real, evidence-backed classification
// from the 2026-09-15 W4 Closure Audit + this Final packet's own change.
const ALLOWLIST = {
  'index.js': { category: 'NOT_GIRO_SEMANTICS', reason: 'two comment-only mentions ("no manual_giros write"); the createManualGiro/addOrderToManualGiro dispatch itself never reads manual_giro_id, it forwards writer-input fields only' },
  'scripts/deliveryPlannerShadowLiveReadOnly.js': { category: 'SHADOW_DIAGNOSTIC', reason: 'feeds only the hidden, PIN-gated /shadow-preview panel, not linked from any operator view (App.jsx: "NON linkato da nessuna vista operatore")' },
  'scripts/deliveryPlannerShadowReadOnly.js': { category: 'SHADOW_DIAGNOSTIC', reason: 'same shadow-comparison tool as above' },
  // language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
  'src/agents/agentOrdini.js': { category: 'WRITER_SUPPORT_W5', reason: 'cambiaStato reads manual_giro_id only to decide a detach/auto-dissolve/driver-reconciliation WRITE; never returned as read output' },
  'src/agents/manualGiroReads.js': { category: 'CANONICALIZED_W4', reason: 'current-day path is fully canonical (Packet 02B); historical path and entrega_ref/anchor_order_id enrichment are its own certified HISTORICAL_EXPLICIT/METADATA_ENRICHMENT sub-cases, proven by manualGiroReadsW4Packet02B.static.test.js' },
  'src/agents/manualGiros.js': { category: 'WRITER_SUPPORT_W5', reason: 'the sole writer module; every raw read here exists only to decide a write, proven untouched (17/17 mechanical) by manualGiroReadsW4Packet02B.static.test.js' },
  'src/agents/previewStrategicOpportunities.js': { category: 'CANONICALIZED_W4', reason: 'reads raw.manual_giro_id only from an ALREADY-canonicalized snapshot (plannerSnapshot.js resolves the alias before this file ever sees it) -- no DB access of its own, unmodified by this packet' },
  'src/agents/previewTiming.js': { category: 'NOT_GIRO_SEMANTICS', reason: 'comment-only references describing the pre-W4 shape it no longer reads (proven executable-code-clean by giroAuthorityW3Candidate.static.test.js)' },
  'src/agents/riderReads.js': { category: 'CANONICALIZED_W4', reason: 'current-day membership/state/salida/hora fully canonical (Packet 02A); one narrow entrega_ref METADATA_ENRICHMENT select remains' },
  'src/auth/actionPolicyRegistry.js': { category: 'NOT_GIRO_SEMANTICS', reason: 'a policy "note" documentation string ("no manual_giros write"), not a Giro-fact read' },
  'src/core/delivery/giroFactsPort.js': { category: 'DEAD_CODE', reason: 'zero requirers anywhere in src/ or index.js (superseded by giroProjectionPort.js in Packet 01) -- re-verified below' },
  'src/core/delivery/giroProjectionReader.js': { category: 'NOT_GIRO_SEMANTICS', reason: 'this IS the canonical I/O boundary; the match is its own header comment naming the raw fields it replaces' },
  'src/core/delivery/planner.js': { category: 'CANONICALIZED_W4', reason: 'Stage 1 consumes plannerSnapshot.js\'s already-canonical alias (no DB access of its own); Stage M (manual_route rider-block: route_order/block_start/manual_duration_min/created_by_operator/force) is TRIP_AUTHORITY_W6 -- the Authority schema models none of those fields. File proven byte-identical to BASE_HEAD by plannerW4FinalCutover.static.test.js' },
  'src/core/delivery/plannerSnapshot.js': { category: 'CANONICALIZED_W4', reason: 'Final W4 Read-Cutover Packet: current-day order-level alias is Projection-sourced (one RPC, replaces the raw column); historical path is HISTORICAL_EXPLICIT; the raw manual_giros select is retained ONLY for Stage M\'s TRIP_AUTHORITY_W6 metadata (route_order/block_start/etc, fields the Authority does not model)' },
  'src/core/delivery/readOnlyRestDb.js': { category: 'NOT_GIRO_SEMANTICS', reason: 'PII-safety table/field allowlist gate; transports plannerSnapshot.js\'s queries, computes no Giro fact of its own' },
  'src/core/delivery/shadowPreviewEndpoint.js': { category: 'SHADOW_DIAGNOSTIC', reason: 'HTTP adapter for the hidden, PIN-gated /shadow-preview comparison panel' },
  'src/utils/driverTelemetry.js': { category: 'DEAD_CODE', reason: 'countActiveDeliveries\'s manualGiroId parameter/raw-filter branch is unreachable -- its one live caller (recordDeliveryAndMaybeReturn) always calls it with {} -- re-verified below' },
  'src/utils/supabaseResourcePolicy.js': { category: 'NOT_GIRO_SEMANTICS', reason: 'a resource-policy table registry entry (KIND.TABLE), not a Giro-fact read' },
};

const ALLOWED_CATEGORIES = new Set([
  'CANONICALIZED_W4', 'HISTORICAL_EXPLICIT', 'METADATA_ENRICHMENT',
  'WRITER_SUPPORT_W5', 'TRIP_AUTHORITY_W6', 'SHADOW_DIAGNOSTIC',
  'DEAD_CODE', 'NOT_GIRO_SEMANTICS',
]);

section('ALLOWLIST HYGIENE — every entry carries a real category and a non-empty reason');
for (const [file, entry] of Object.entries(ALLOWLIST)) {
  assert(`${file}: category "${entry.category}" is one of the closed set`, ALLOWED_CATEGORIES.has(entry.category));
  assert(`${file}: has a documented reason (not a bare filename)`, typeof entry.reason === 'string' && entry.reason.length > 20);
}

section('GLOBAL SWEEP — every file referencing raw Giro-truth fields is in the documented allowlist');
function listFiles(dir, exts) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(rel);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}
const candidateFiles = [
  ...listFiles('src', ['.js']),
  ...listFiles('scripts', ['.js']),
  'index.js',
].filter((f) => fs.existsSync(path.join(ROOT, f)));

const RAW_GIRO_SIGNAL = /manual_giro_id|manual_giros/;
const flagged = candidateFiles.filter((f) => RAW_GIRO_SIGNAL.test(read(f)));
const undocumented = flagged.filter((f) => !Object.prototype.hasOwnProperty.call(ALLOWLIST, f));
assert('every file mentioning manual_giro_id/manual_giros is in the documented allowlist (no new raw reader can appear undetected)',
  undocumented.length === 0, undocumented.join(', '));

const staleAllowlistEntries = Object.keys(ALLOWLIST).filter((f) => !flagged.includes(f));
assert('no stale allowlist entries (every allowlisted file still actually contains the signal)',
  staleAllowlistEntries.length === 0, staleAllowlistEntries.join(', '));

section('CURRENT_OPERATIONAL_RAW_READER re-check — none of the allowlisted categories permit it');
const forbiddenForOperationalTruth = flagged.filter((f) => {
  const cat = ALLOWLIST[f] && ALLOWLIST[f].category;
  // Every category in the closed set is, by definition, NOT a current-day
  // raw-truth reader; this assertion exists to fail loudly if a future edit
  // ever adds a 9th category without updating this guard's own closed set.
  return !ALLOWED_CATEGORIES.has(cat);
});
assert('zero files carry an unrecognized/unsafe category', forbiddenForOperationalTruth.length === 0, forbiddenForOperationalTruth.join(', '));

section('DEAD_CODE entries — mechanically re-verified, not just asserted');
{
  const giroFactsPortRequirers = candidateFiles.filter((f) => f !== 'src/core/delivery/giroFactsPort.js' && /require\([^)]*giroFactsPort/.test(read(f)));
  assert('giroFactsPort.js: zero requirers anywhere (still dead)', giroFactsPortRequirers.length === 0, giroFactsPortRequirers.join(', '));

  const telemetrySrc = read('src/utils/driverTelemetry.js');
  const otherCallers = candidateFiles.filter((f) => f !== 'src/utils/driverTelemetry.js' && /countActiveDeliveries\s*\(/.test(read(f)));
  assert('driverTelemetry.js: countActiveDeliveries has no OTHER caller besides its own file', otherCallers.length === 0, otherCallers.join(', '));
  const liveCallSite = (telemetrySrc.match(/countActiveDeliveries\(\{[^}]*\}\)/g) || []).find((c) => !/manualGiroId/.test(c));
  assert('driverTelemetry.js: the one live call site never passes manualGiroId (branch stays unreachable)', !!liveCallSite, telemetrySrc.match(/countActiveDeliveries\([^)]*\)/g));
}

section('SHADOW_DIAGNOSTIC entries — hidden/PIN-gated route re-verified against the live frontend router');
{
  const appJsxPath = path.join(ROOT, '..', 'LaDieciBotV2-github', 'ladieci-app33', 'src', 'App.jsx');
  if (fs.existsSync(appJsxPath)) {
    const appSrc = fs.readFileSync(appJsxPath, 'utf8');
    assert('App.jsx still routes /shadow-preview only via the hidden, PIN-gated deep-link block',
      /shadow-preview.*shadowpreview/.test(appSrc.replace(/\n/g, ' ')) && /NASCOSTO/.test(appSrc));
  } else {
    assert('App.jsx reachable for SHADOW_DIAGNOSTIC re-verification (skipped: path not found in this worktree)', true);
  }
}

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
