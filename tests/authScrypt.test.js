// Test per src/auth/scrypt.js — Access Control V2 Block B1.
// Eseguire: node tests/authScrypt.test.js
//
// Path note: il contratto proponeva test/auth/scrypt.test.js, ma il progetto
// usa la convenzione flat tests/*.test.js (nessun runner esterno) — adattato.
//
// Nessun PIN reale: valori SINTETICI. Gli hash si stampano SOLO troncati al
// prefisso non segreto (scrypt$1$32768$8$1$…), mai salt/digest interi.

const crypto = require('crypto');
const scrypt = require('../src/auth/scrypt');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};
const prefix = (h) => (typeof h === 'string' ? h.split('$').slice(0, 5).join('$') + '$…' : String(h));

// helper: build a valid-alphabet, correct-length, NON-canonical base64url string
function makeNonCanonical(buf) {
  const b = buf.toString('base64url');
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = b[b.length - 1];
  for (const c of alpha) {
    if (c === last) continue;
    const cand = b.slice(0, -1) + c;
    const dec = Buffer.from(cand, 'base64url');
    if (dec.length === buf.length && dec.equals(buf)) return cand;
  }
  return null;
}

(async () => {
  const PIN = '12345678';        // synthetic
  const WRONG = '87654321';      // synthetic
  const h = await scrypt.hashPin(PIN);
  console.log('  (sample hash, truncated): ' + prefix(h));

  // 1 correct
  assert('hash→verify correct PIN', (await scrypt.verifyPin(PIN, h)) === true);
  // 2 wrong
  assert('verify wrong PIN → false', (await scrypt.verifyPin(WRONG, h)) === false);
  // 3 / 14 same pin → different salt → different hash, both verify
  const h2 = await scrypt.hashPin(PIN);
  assert('same PIN twice → different hash (salt)', h !== h2);
  assert('both hashes verify', (await scrypt.verifyPin(PIN, h)) && (await scrypt.verifyPin(PIN, h2)));
  // 4 format
  assert('isValidFormat(real hash) true', scrypt.isValidFormat(h) === true);
  assert('format regex shape', /^scrypt\$1\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(h));

  // 5 malformed structures → verify false, needsRehash true, isValidFormat false
  const malformed = [
    'scrypt$1$32768$8$1$onlysixsegments',                       // 6 segments
    h + '$extra',                                               // 8 segments
    h.replace('scrypt$', 'bcrypt$'),                            // wrong scheme
    'scrypt$1$32x68$8$1$' + crypto.randomBytes(16).toString('base64url') + '$' + crypto.randomBytes(32).toString('base64url'), // non-int N
    'scrypt$1$32768$8$1$@@@invalid@@@$' + crypto.randomBytes(32).toString('base64url'), // invalid base64
  ];
  let m_ok = true;
  for (const s of malformed) {
    if ((await scrypt.verifyPin(PIN, s)) !== false) m_ok = false;
    if (scrypt.needsRehash(s) !== true) m_ok = false;
    if (scrypt.isValidFormat(s) !== false) m_ok = false;
  }
  assert('malformed → verify false + needsRehash true + isValidFormat false', m_ok);

  // 6 wrong salt / digest length
  const badSalt = 'scrypt$1$32768$8$1$' + crypto.randomBytes(15).toString('base64url') + '$' + crypto.randomBytes(32).toString('base64url');
  const badDigest = 'scrypt$1$32768$8$1$' + crypto.randomBytes(16).toString('base64url') + '$' + crypto.randomBytes(31).toString('base64url');
  assert('salt ≠ 16 bytes → false', (await scrypt.verifyPin(PIN, badSalt)) === false);
  assert('digest ≠ 32 bytes → false', (await scrypt.verifyPin(PIN, badDigest)) === false);

  // 7 unknown version
  const v2 = 'scrypt$2$32768$8$1$' + crypto.randomBytes(16).toString('base64url') + '$' + crypto.randomBytes(32).toString('base64url');
  assert('unknown version → verify false', (await scrypt.verifyPin(PIN, v2)) === false);
  assert('unknown version → needsRehash true', scrypt.needsRehash(v2) === true);

  // 8 off-policy params must NOT call crypto.scrypt
  const offPolicy = 'scrypt$1$16384$8$1$' + crypto.randomBytes(16).toString('base64url') + '$' + crypto.randomBytes(32).toString('base64url');
  const realScrypt = crypto.scrypt; let scryptCalls = 0;
  crypto.scrypt = function (...a) { scryptCalls++; return realScrypt.apply(this, a); };
  const offRes = await scrypt.verifyPin(PIN, offPolicy);
  crypto.scrypt = realScrypt;
  assert('off-policy params → verify false', offRes === false);
  assert('off-policy params → scrypt NOT invoked', scryptCalls === 0, `calls=${scryptCalls}`);
  assert('off-policy params → needsRehash true', scrypt.needsRehash(offPolicy) === true);

  // 9 base64url strictness: padding / invalid chars / non-canonical rejected
  const salt = crypto.randomBytes(16), dig = crypto.randomBytes(32);
  const padded = 'scrypt$1$32768$8$1$' + Buffer.from(salt).toString('base64') + '$' + dig.toString('base64url'); // std base64 (has +/=)
  const plusChar = 'scrypt$1$32768$8$1$' + (salt.toString('base64url').slice(0, -1) + '+') + '$' + dig.toString('base64url');
  const nc = makeNonCanonical(dig);
  const nonCanon = nc ? ('scrypt$1$32768$8$1$' + salt.toString('base64url') + '$' + nc) : null;
  assert('padding/std-base64 rejected', scrypt.isValidFormat(padded) === false);
  assert('invalid char (+) rejected', scrypt.isValidFormat(plusChar) === false);
  assert('non-canonical base64url rejected', nc ? (scrypt.isValidFormat(nonCanon) === false) : true, nc ? '' : '(no nc variant found — skipped)');

  // 10 PIN > 128 bytes
  const bigPin = 'a'.repeat(129);
  let hashRejected = false;
  try { await scrypt.hashPin(bigPin); } catch (_) { hashRejected = true; }
  assert('hashPin rejects >128-byte PIN', hashRejected);
  assert('verifyPin false for >128-byte PIN', (await scrypt.verifyPin(bigPin, h)) === false);

  // 11 Unicode counted in BYTES not chars
  const uni43 = 'ñ'.repeat(43); // 43 * 2 bytes = 86 bytes → valid
  const uni65 = 'ñ'.repeat(65); // 130 bytes → invalid
  const uh = await scrypt.hashPin(uni43);
  assert('unicode 86 bytes → hash+verify ok', (await scrypt.verifyPin(uni43, uh)) === true);
  let uniRej = false; try { await scrypt.hashPin(uni65); } catch (_) { uniRej = true; }
  assert('unicode 130 bytes → hashPin rejects (byte count)', uniRej);
  assert('unicode 130 bytes → verifyPin false', (await scrypt.verifyPin(uni65, uh)) === false);

  // 12 stored not a string
  assert('stored=null → verify false', (await scrypt.verifyPin(PIN, null)) === false);
  assert('stored=number → verify false', (await scrypt.verifyPin(PIN, 12345)) === false);
  assert('stored=null → needsRehash true', scrypt.needsRehash(null) === true);
  assert('stored=null → isValidFormat false', scrypt.isValidFormat(null) === false);

  // 13 no console output from the module during a batch
  const methods = ['log', 'warn', 'error', 'info', 'debug', 'trace'];
  const orig = {}; let consoleCalls = 0;
  for (const mth of methods) { orig[mth] = console[mth]; console[mth] = () => { consoleCalls++; }; }
  await scrypt.hashPin(PIN);
  await scrypt.verifyPin(PIN, h);
  await scrypt.verifyPin(WRONG, h);
  await scrypt.verifyPin(PIN, 'totally-broken');
  scrypt.needsRehash(h); scrypt.isValidFormat(h); scrypt.needsRehash('x');
  for (const mth of methods) console[mth] = orig[mth];
  assert('module emits ZERO console output', consoleCalls === 0, `calls=${consoleCalls}`);

  // 15 CURRENT immutable
  assert('CURRENT is frozen', Object.isFrozen(scrypt.CURRENT));
  const beforeN = scrypt.CURRENT.N;
  try { scrypt.CURRENT.N = 1; } catch (_) {}
  assert('CURRENT.N unchanged after mutation attempt', scrypt.CURRENT.N === beforeN && beforeN === 32768);

  // 16 verifyPin never throws over a matrix of malformed inputs
  const junk = [undefined, null, '', 0, {}, [], 'scrypt', 'scrypt$1', 'a$b$c$d$e$f$g',
    'scrypt$1$32768$8$1$$', 'scrypt$1$0$0$0$AAAA$AAAA', h.slice(0, -3), h + 'zzz'];
  let neverThrew = true;
  for (const j of junk) {
    try { const r = await scrypt.verifyPin(PIN, j); if (r !== false) neverThrew = false; }
    catch (_) { neverThrew = false; }
  }
  assert('verifyPin never throws + always false on malformed matrix', neverThrew);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('  FATAL  ' + e.message); process.exit(1); });
