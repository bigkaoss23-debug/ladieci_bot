'use strict';
// Access Control V3 — Block V3-B correction: proves the v3 duplicate-check snapshot is
// scoped by workspace_id IN THE DATABASE QUERY ITSELF, not by a Node-side .filter() of
// an unscoped table read. Static text inspection, no DB. Eseguire:
// node tests/pinRotationDaoV3WorkspaceScope.static.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const daoText = read('src/auth/pinRotationDaoV3.js');
const svcText = read('src/auth/pinRotationServiceV3.js');

assert('the DAO defines a workspace-scoped SENSITIVE read',
  /async function listWorkspaceActorsForVerify_SENSITIVE\s*\(\s*workspaceId\s*\)/.test(daoText));

assert('that function\'s query string contains an exact workspace_id=eq. filter',
  /select=actor,role,active,workspace_id,pin_hash&workspace_id=eq\.\$\{encodeURIComponent\(workspaceId\)\}/.test(daoText));

assert('workspaceId is validated (UUID shape) before it reaches the query — no blind interpolation',
  /UUID_RE\.test\(workspaceId\)/.test(daoText) && /throw new AuthDaoError/.test(daoText));

assert('the scoped function is exported', /listWorkspaceActorsForVerify_SENSITIVE,/.test(daoText));

// ── the service consumes the SCOPED read, not the legacy unscoped one ────────────
assert('pinRotationServiceV3.js calls the workspace-scoped DAO read',
  /dao\.listWorkspaceActorsForVerify_SENSITIVE\(\s*workspaceId\s*\)/.test(svcText));

assert('pinRotationServiceV3.js no longer calls the unscoped v2 read for its own snapshot',
  !/dao\.listActorsWithWorkspaceForVerify_SENSITIVE\s*\(\s*\)/.test(svcText));

assert('workspaceId is required before any DAO call is made (fail closed, both caller kinds)',
  /typeof workspaceId !== 'string' \|\| workspaceId\.length === 0\) return FAILED/.test(svcText));

// ── owner classification is role-based, not actor-id-based ───────────────────────
assert('pinRotationServiceV3.js classifies the reserved credential via isOwnerCredentialRole, not actor id',
  /isOwnerCredentialRole\(a\.role\)/.test(svcText));

assert('the duplicate-check loop no longer skips inactive actors',
  !/a\.active !== true \|\| !a\.pin_hash\) continue/.test(svcText));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
