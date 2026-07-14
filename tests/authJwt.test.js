// Test per src/auth/jwt.js — B3. Eseguire: node tests/authJwt.test.js
// Secret sintetico via env; nessun secret reale stampato.
const crypto = require('crypto');
process.env.AUTH_JWT_SECRET_B64URL = crypto.randomBytes(32).toString('base64url'); // ≥32 bytes canonical

const jwt = require('../src/auth/jwt');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  → ' + d : '')); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sig = (h, p) => crypto.createHmac('sha256', Buffer.from(process.env.AUTH_JWT_SECRET_B64URL, 'base64url')).update(h + '.' + p).digest('base64url');
const now = () => Math.floor(Date.now() / 1000);

assert('isReady with valid secret', jwt.isReady() === true);

// sign/verify roundtrip + TTL per role
for (const [role, sub, ttl] of [['admin', 'owner', 14400], ['operator', 'operator_primary', 36000], ['operator', 'operator_backup', 36000], ['rider', 'rider', 43200]]) {
  const t = jwt.signToken({ role, sub, sv: 1 });
  const p = jwt.verifyToken(t);
  assert(`sign+verify ${role}/${sub}`, p && p.role === role && p.sub === sub && p.v === 2 && p.sv === 1);
  assert(`TTL ${role} = ${ttl}`, p && (p.exp - p.iat) === ttl);
}
assert('expiresInFor', jwt.expiresInFor('admin') === '4h' && jwt.expiresInFor('rider') === '12h');

// invalid sign inputs
assert('sign rejects bad role/sub', jwt.signToken({ role: 'operator', sub: 'owner', sv: 1 }) === null);
assert('sign rejects sv<1', jwt.signToken({ role: 'admin', sub: 'owner', sv: 0 }) === null);
assert('sign rejects non-int sv', jwt.signToken({ role: 'admin', sub: 'owner', sv: 1.5 }) === null);

// verify strict rejections
const good = jwt.signToken({ role: 'admin', sub: 'owner', sv: 3 });
assert('verify good', jwt.verifyToken(good) !== null);
assert('reject 2 segments', jwt.verifyToken(good.split('.').slice(0, 2).join('.')) === null);
assert('reject tampered payload (sig mismatch)', (() => { const [h, , s] = good.split('.'); return jwt.verifyToken(h + '.' + b64({ role: 'admin', sub: 'owner', iat: now(), exp: now() + 100, sv: 99, v: 2 }) + '.' + s) === null; })());
// wrong alg
{ const h = b64({ alg: 'none', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'owner', iat: now(), exp: now() + 100, sv: 1, v: 2 }); assert('reject alg none', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
{ const h = b64({ alg: 'HS512', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'owner', iat: now(), exp: now() + 100, sv: 1, v: 2 }); assert('reject alg HS512', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
// v != 2
{ const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'owner', iat: now(), exp: now() + 100, sv: 1, v: 1 }); assert('reject v!=2', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
// role/sub mismatch
{ const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'rider', iat: now(), exp: now() + 100, sv: 1, v: 2 }); assert('reject role/sub mismatch', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
// sv < 1
{ const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'owner', iat: now(), exp: now() + 100, sv: 0, v: 2 }); assert('reject sv<1', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
// expired
{ const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'owner', iat: now() - 20000, exp: now() - 100, sv: 1, v: 2 }); assert('reject expired', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
// iat too far future
{ const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'owner', iat: now() + 3600, exp: now() + 3600 + 100, sv: 1, v: 2 }); assert('reject future iat', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
// TTL above role limit
{ const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ role: 'rider', sub: 'rider', iat: now(), exp: now() + 43200 + 1000, sv: 1, v: 2 }); assert('reject TTL above role', jwt.verifyToken(h + '.' + p + '.' + sig(h, p)) === null); }
// non-canonical base64url
assert('reject non-canonical b64url segment', jwt.verifyToken(good + '=') === null);
assert('reject non-string', jwt.verifyToken(12345) === null && jwt.verifyToken(null) === null);
// wrong signature (different secret)
{ const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ role: 'admin', sub: 'owner', iat: now(), exp: now() + 100, sv: 1, v: 2 }); const bad = crypto.createHmac('sha256', crypto.randomBytes(32)).update(h + '.' + p).digest('base64url'); assert('reject wrong signature', jwt.verifyToken(h + '.' + p + '.' + bad) === null); }

// fail-closed: reload module with a too-short secret
delete require.cache[require.resolve('../src/auth/jwt')];
process.env.AUTH_JWT_SECRET_B64URL = crypto.randomBytes(16).toString('base64url'); // only 16 bytes
const jwt2 = require('../src/auth/jwt');
assert('not ready with <32 byte secret', jwt2.isReady() === false);
assert('sign returns null when not ready', jwt2.signToken({ role: 'admin', sub: 'owner', sv: 1 }) === null);
assert('verify returns null when not ready', jwt2.verifyToken(good) === null);
// missing secret
delete require.cache[require.resolve('../src/auth/jwt')];
delete process.env.AUTH_JWT_SECRET_B64URL;
const jwt3 = require('../src/auth/jwt');
assert('not ready with missing secret', jwt3.isReady() === false);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
