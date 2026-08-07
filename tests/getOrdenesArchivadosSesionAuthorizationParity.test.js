// LISTOS_ARCHIVADOS_V1 — authorization-parity proof for the new read action
// getOrdenesArchivadosSesion, added as a session-scoped terminal-orders sibling
// of getOrdenes for the Listos "Archivados" feature.
//
// Two things are proven here, across all three registries that classify it
// (src/auth/legacyActionRoles.js -- the LIVE guard; src/auth/authorizationContract.js
// and src/auth/actionPolicyRegistry.js -- unwired parallel/future registries with
// their own completeness tests):
//
//   1. getOrdenesArchivadosSesion's resolved permissions equal getOrdenes' MINUS
//      rider. getOrdenes' rider reachability comes from a separate index.js
//      intercept (riderReads.getRiderOrdenes()) that scopes results to that
//      rider's own deliveries -- the new action has no such scoping and must
//      never be rider-reachable.
//   2. every OTHER action's resolved permissions are byte-identical to the
//      last COMMITTED version of each file (HEAD, i.e. before this change) --
//      not just re-asserted against a hand-transcribed spec, but diffed
//      against the actual prior file content, so a typo that silently widened
//      an unrelated action's access would fail this test.
//
// Run: node tests/getOrdenesArchivadosSesionAuthorizationParity.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const NEW_ACTION = 'getOrdenesArchivadosSesion';

// Load the git-committed (pre-this-change) version of a module by writing its
// HEAD content to a temp sibling file (so its own relative requires still
// resolve) and requiring it fresh, then cleaning up.
function requireAtHead(relPath) {
  const src = execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: ROOT, encoding: 'utf8' });
  const abs = path.join(ROOT, relPath);
  const tmp = abs.replace(/\.js$/, '.HEAD.tmp.js');
  fs.writeFileSync(tmp, src);
  try {
    delete require.cache[require.resolve(tmp)];
    return require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ═══ 1. legacyActionRoles.js — the LIVE guard ═══════════════════════════════
{
  const live = require('../src/auth/legacyActionRoles');
  const before = requireAtHead('src/auth/legacyActionRoles.js');

  assert('[live] getOrdenesArchivadosSesion is a known action', live.isKnownAction(NEW_ACTION));
  assert('[live] operator ALLOW', live.isAllowed('operator', NEW_ACTION));
  assert('[live] admin ALLOW', live.isAllowed('admin', NEW_ACTION));
  assert('[live] rider DENY (deliberate -- getOrdenes\' rider scoping is not replicated)',
    live.isAllowed('rider', NEW_ACTION) === false);
  assert('[live] permission set == getOrdenes MINUS rider',
    JSON.stringify([...live.getActionRule(NEW_ACTION).roles].sort()) ===
    JSON.stringify([...live.getActionRule('getOrdenes').roles].filter((r) => r !== 'rider').sort()));

  // Every action known BEFORE this change resolves identically now, for every role.
  let allUnchanged = true;
  for (const action of before.ALL_ACTIONS) {
    for (const role of ['admin', 'operator', 'rider']) {
      if (before.isAllowed(role, action) !== live.isAllowed(role, action)) {
        allUnchanged = false;
        console.log(`    drift: ${role} x ${action}: was ${before.isAllowed(role, action)}, now ${live.isAllowed(role, action)}`);
      }
    }
  }
  assert('[live] every pre-existing action\'s permissions are byte-identical to HEAD', allUnchanged);
  assert('[live] exactly one action added vs HEAD',
    live.ALL_ACTIONS.length === before.ALL_ACTIONS.length + 1 &&
    live.ALL_ACTIONS.includes(NEW_ACTION) && !before.ALL_ACTIONS.includes(NEW_ACTION));
}

// ═══ 2. authorizationContract.js — B4 draft (unwired, own completeness test) ═
{
  const live = require('../src/auth/authorizationContract');
  const before = requireAtHead('src/auth/authorizationContract.js');

  const newAllowed = live.getActionContract(NEW_ACTION).allowed;
  const ordenesAllowed = live.getActionContract('getOrdenes').allowed;
  assert('[contract] operator ALLOW', newAllowed.includes('operator'));
  assert('[contract] admin ALLOW', newAllowed.includes('admin'));
  assert('[contract] rider DENY', !newAllowed.includes('rider'));
  assert('[contract] permission set == getOrdenes MINUS rider',
    JSON.stringify([...newAllowed].sort()) === JSON.stringify([...ordenesAllowed].filter((r) => r !== 'rider').sort()));
  assert('[contract] not fresh-auth (matches getOrdenes)', !live.requiresFreshAuth(NEW_ACTION));
  assert('[contract] not machine-only', !live.isMachineOnly(NEW_ACTION));

  let allUnchanged = true;
  for (const action of before.CANONICAL_ACTIONS) {
    for (const p of ['admin', 'operator', 'rider', 'service']) {
      if (before.isAllowed(p, action) !== live.isAllowed(p, action)) {
        allUnchanged = false;
        console.log(`    drift: ${p} x ${action}: was ${before.isAllowed(p, action)}, now ${live.isAllowed(p, action)}`);
      }
    }
  }
  assert('[contract] every pre-existing action\'s permissions are byte-identical to HEAD', allUnchanged);
  assert('[contract] exactly one action added vs HEAD',
    live.CANONICAL_ACTIONS.length === before.CANONICAL_ACTIONS.length + 1 &&
    live.CANONICAL_ACTIONS.includes(NEW_ACTION) && !before.CANONICAL_ACTIONS.includes(NEW_ACTION));
}

// ═══ 3. actionPolicyRegistry.js — V3 draft (unwired, own completeness test) ═
{
  const live = require('../src/auth/actionPolicyRegistry');
  const before = requireAtHead('src/auth/actionPolicyRegistry.js');

  const ROLE_CODES = ['owner', 'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'legacy_operator'];
  const newRoles = live.rolesFor(NEW_ACTION);
  const ordenesRoles = live.rolesFor('getOrdenes');
  assert('[policy] operator-equivalent legacy_operator ALLOW', newRoles.includes('legacy_operator'));
  assert('[policy] owner ALLOW', newRoles.includes('owner'));
  assert('[policy] rider DENY', !newRoles.includes('rider'));
  assert('[policy] role set == getOrdenes MINUS rider',
    JSON.stringify([...newRoles].sort()) === JSON.stringify([...ordenesRoles].filter((r) => r !== 'rider').sort()));

  let allUnchanged = true;
  for (const entry of before.ACTION_POLICY_REGISTRY) {
    for (const role of ROLE_CODES) {
      const wasAllowed = before.rolesFor(entry.action).includes(role);
      const isAllowedNow = live.rolesFor(entry.action).includes(role);
      if (wasAllowed !== isAllowedNow) {
        allUnchanged = false;
        console.log(`    drift: ${role} x ${entry.action}: was ${wasAllowed}, now ${isAllowedNow}`);
      }
    }
  }
  assert('[policy] every pre-existing action\'s resolved roles are byte-identical to HEAD', allUnchanged);
  assert('[policy] exactly one action added vs HEAD',
    live.ACTION_POLICY_REGISTRY.length === before.ACTION_POLICY_REGISTRY.length + 1 &&
    live.ACTION_POLICY_REGISTRY.some((e) => e.action === NEW_ACTION) &&
    !before.ACTION_POLICY_REGISTRY.some((e) => e.action === NEW_ACTION));
}

console.log(`\ngetOrdenesArchivadosSesionAuthorizationParity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
