'use strict';
// S4 — reads public.ladieci_schema_migrations (MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md
// §15) to report migration-authority status. Read-only: this module never writes to
// ladieci_schema_migrations or to any Supabase-owned migration-history table.
//
// COMPATIBILITY CONTRACT (§15): "each release declares REQUIRED_MIGRATIONS, containing
// only post-epoch (kind <> 'bootstrap') filenames, all verified by construction... missing
// != empty => ERROR in /status; order intake is never blocked... Checksum mismatch => ERROR,
// never auto-repaired." REQUIRED_MIGRATIONS is this release's own declared dependency list —
// empty today because S4 is the epoch itself and nothing yet depends on a post-S4 migration.
// A later slice that needs a hard "this migration must be present and verified" signal in
// /status appends {filename, checksum_sha256} here; nothing else in this file changes.
const REQUIRED_MIGRATIONS = Object.freeze([]);

const { sbSelect } = require('./supabase');

async function getMigrationStatus() {
  const rows = await sbSelect(
    'ladieci_schema_migrations',
    'select=filename,checksum_sha256,apply_order,kind,verification_status'
  );

  const verifiedRows = rows.filter(r => r.verification_status === 'verified');
  const headVerified = verifiedRows.length
    ? Math.max(...verifiedRows.map(r => r.apply_order))
    : null;
  const headRecorded = rows.length
    ? Math.max(...rows.map(r => r.apply_order))
    : null;
  const unverifiedCount = rows.length - verifiedRows.length;

  const verifiedByFilename = new Map(verifiedRows.map(r => [r.filename, r]));
  const missingRequired = [];
  const checksumMismatches = [];
  for (const req of REQUIRED_MIGRATIONS) {
    const found = verifiedByFilename.get(req.filename);
    if (!found) {
      missingRequired.push(req.filename);
    } else if (found.checksum_sha256 !== req.checksum_sha256) {
      checksumMismatches.push({
        filename: req.filename,
        expected: req.checksum_sha256,
        recorded: found.checksum_sha256,
      });
    }
  }

  const level = (missingRequired.length > 0 || checksumMismatches.length > 0)
    ? 'red'
    : (unverifiedCount > 0 ? 'yellow' : 'green');

  return {
    level,
    headVerified,
    headRecorded,
    unverifiedCount,
    missingRequired,
    checksumMismatches,
  };
}

// S4 SHADOW FIX — §15: "the boot check logs both heads for one full service
// before /status reports on them." The boot-time log (index.js) calls
// getMigrationStatus() directly and unconditionally, unaffected by any of
// this. /status must not expose head_verified/head_recorded/unverified_count/
// missing_required/checksum_mismatches, and migration authority must not
// influence /status's overall level, until a genuine post-boot service has
// completed.
//
// SHADOW_COMPLETION_RULE: a public.service_sessions row exists with
// status='closed' (DB-enforced 1:1 with closed_at IS NOT NULL, so this is
// the one unambiguous terminal signal — 'rolled_over' is a different,
// non-close terminal outcome and is deliberately NOT counted here, matching
// this fix's own test matrix, which names "closes"/"closed" throughout, not
// "terminates"), opened_at strictly after this process's own BOOT_TIME (so a
// session already open at boot, or a historical session closed before boot,
// never counts), and open_source <> 'test_fixture' (the existing marker this
// project already uses for synthetic fixtures — see the TEST-S1-ACCEPTANCE
// row from S1's own live acceptance testing).
//
// Once true for this process, it stays true: a monotonic, in-memory,
// per-boot latch — never persisted, never re-armed without a real restart,
// matching "no manual cutover, no restart required" and "do not persist a
// global shadow-already-completed-forever flag".
let _shadowWindowElapsed = false;

async function hasShadowWindowElapsed(bootTimeIso) {
  if (_shadowWindowElapsed) return true;
  const rows = await sbSelect(
    'service_sessions',
    `status=eq.closed&open_source=neq.test_fixture&opened_at=gt.${encodeURIComponent(bootTimeIso)}&limit=1`
  );
  if (Array.isArray(rows) && rows.length > 0) {
    _shadowWindowElapsed = true;
  }
  return _shadowWindowElapsed;
}

// What /status itself consumes. Before shadow completion: a non-consuming
// marker only, per §15's "before /status reports on them" — never the real
// heads, never a level that could influence _worstLevel. After completion:
// the exact, unchanged getMigrationStatus() shape.
async function getMigrationStatusForStatusEndpoint(bootTimeIso) {
  const elapsed = await hasShadowWindowElapsed(bootTimeIso);
  if (!elapsed) {
    return { phase: 'shadow' };
  }
  return getMigrationStatus();
}

// Test-only: resets the in-memory latch so each test starts from a fresh
// per-boot state. Never called from production code.
function _resetShadowWindowForTests() {
  _shadowWindowElapsed = false;
}

module.exports = {
  getMigrationStatus,
  REQUIRED_MIGRATIONS,
  hasShadowWindowElapsed,
  getMigrationStatusForStatusEndpoint,
  _resetShadowWindowForTests,
};
