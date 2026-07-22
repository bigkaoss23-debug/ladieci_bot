// Universal PIN login. Synthetic PIN/hash values only; no network or database.
const { createUniversalLoginHandler } = require('../src/auth/login');
const pinPolicy = require('../src/auth/pinPolicy');

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(name);
  passed++;
  console.log('  PASS  ' + name);
}

const actors = [
  ['owner', 'admin', '135724680'],
  ['operator_primary', 'operator', '246813'],
  ['operator_backup', 'operator', '864213'],
  ['rider', 'rider', '135724'],
];

function fixture(options = {}) {
  const calls = { verify: [], reset: [], failed: [], audit: [], ipFail: 0, ipReset: 0 };
  const rows = (options.rows || actors.map(([actor, role, pin]) => ({
    actor, role, active: true, pin_hash: 'HASH:' + pin, session_version: 4,
  })));
  const deps = {
    dao: {
      listActorsForVerify_SENSITIVE: async () => rows,
      getLockState: async (actor) => options.lockedActor === actor
        ? { locked: true, retryAfterSec: 17 }
        : { locked: false, retryAfterSec: 0 },
      resetFailedAttempts: async (actor) => {
        calls.reset.push(actor);
        return { active: options.disableOnReset !== actor, session_version: 9 };
      },
      recordFailedAttempt: async (actor) => { calls.failed.push(actor); },
    },
    jwt: {
      isReady: () => options.jwtReady !== false,
      signToken: (claims) => { calls.claims = claims; return 'TOKEN'; },
      expiresInFor: (role) => ({ admin: '4h', operator: '10h', rider: '12h' }[role]),
    },
    pinPolicy,
    verifyPin: async (pin, hash) => { calls.verify.push(hash); return hash === 'HASH:' + pin; },
    decoyHashPromise: Promise.resolve('DECOY'),
    ipHash: () => 'IP_HASH',
    ipLimiter: {
      check: () => options.ipBlocked ? { blocked: true, retryAfterSec: 23 } : { blocked: false },
      recordFailure: () => { calls.ipFail++; },
      reset: () => { calls.ipReset++; },
    },
    audit: { writeAuthAuditBestEffort: async (entry) => { calls.audit.push(entry); } },
  };
  return { login: createUniversalLoginHandler(deps), calls };
}

(async () => {
  for (const [actor, role, pin] of actors) {
    const { login, calls } = fixture();
    const result = await login({ pin, trustedClientIp: '127.0.0.1' });
    check(`${actor} is recognized from PIN only`, result.status === 200 && result.body.actor === actor && result.body.role === role);
    check(`${actor} receives V2 claims`, result.body.tokenVersion === 2 && calls.claims.sub === actor && calls.claims.role === role && calls.claims.sv === 9);
    check(`${actor} checks all four slots`, calls.verify.length === 4);
  }

  {
    const { login, calls } = fixture();
    const result = await login({ pin: '975318' });
    check('wrong PIN is generic', result.status === 401 && JSON.stringify(result.body) === '{"error":"credenciales incorrectas"}');
    check('wrong PIN does not lock arbitrary actors', calls.failed.length === 0 && calls.ipFail === 1);
    check('wrong PIN checks all four slots', calls.verify.length === 4);
  }

  {
    const duplicateRows = actors.map(([actor, role, pin]) => ({ actor, role, active: true, pin_hash: 'HASH:' + pin }));
    duplicateRows[1].pin_hash = 'HASH:135724';
    const { login, calls } = fixture({ rows: duplicateRows });
    const result = await login({ pin: '135724' });
    check('duplicate PIN fails closed', result.status === 401 && !result.body.token);
    check('duplicate PIN issues no session', calls.reset.length === 0 && !calls.claims);
  }

  {
    const inactiveRows = actors.map(([actor, role, pin]) => ({ actor, role, active: actor !== 'rider', pin_hash: 'HASH:' + pin }));
    const { login, calls } = fixture({ rows: inactiveRows });
    const result = await login({ pin: '135724' });
    check('inactive actor is denied', result.status === 401);
    check('inactive actor uses a decoy slot', calls.verify.includes('DECOY') && calls.verify.length === 4);
  }

  {
    const { login, calls } = fixture({ lockedActor: 'rider' });
    const result = await login({ pin: '135724' });
    check('matched locked actor is blocked', result.status === 429 && result.body.retryAfterSec === 17);
    check('locked actor receives no session', calls.reset.length === 0);
  }

  {
    const { login, calls } = fixture({ ipBlocked: true });
    const result = await login({ pin: '135724' });
    check('IP brute-force limiter remains active', result.status === 429 && calls.verify.length === 0);
  }

  console.log(`\n=== RESULT: ${passed} passed, 0 failed ===`);
})().catch((error) => { console.error('  FAIL  ' + error.message); process.exit(1); });
