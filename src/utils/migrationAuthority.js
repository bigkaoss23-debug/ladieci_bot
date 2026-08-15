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

module.exports = { getMigrationStatus, REQUIRED_MIGRATIONS };
