// Benchmark for src/auth/scrypt.js — Access Control V2 Block B1 (dev-only).
// Serial benchmark: warm-up, ≥20 hash, ≥20 verify-correct, ≥20 verify-wrong.
// Reports p50/p95 per category, RSS before/after, Node version + platform.
// Prints NO PIN and NO full hash. Run: node scripts/bench_scrypt.js
'use strict';
const scrypt = require('../src/auth/scrypt');

const N = 25;
const PIN = '12345678';   // synthetic
const WRONG = '87654321'; // synthetic

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
async function timeIt(fn) {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6; // ms
}
function summarize(label, arr) {
  const s = [...arr].sort((a, b) => a - b);
  console.log(`  ${label.padEnd(16)} n=${arr.length}  p50=${pct(s, 50).toFixed(1)}ms  p95=${pct(s, 95).toFixed(1)}ms  min=${s[0].toFixed(1)}  max=${s[s.length - 1].toFixed(1)}`);
  return pct(s, 95);
}

(async () => {
  console.log(`node=${process.version} platform=${process.platform} arch=${process.arch}`);
  console.log(`params: N=${scrypt.CURRENT.N} r=${scrypt.CURRENT.r} p=${scrypt.CURRENT.p} keylen=${scrypt.CURRENT.keylen} maxmem=${scrypt.CURRENT.maxmem}`);
  const rssBefore = process.memoryUsage().rss;

  // warm-up
  const h0 = await scrypt.hashPin(PIN);
  await scrypt.verifyPin(PIN, h0);

  const hashT = [], vOkT = [], vBadT = [];
  const hashes = [];
  for (let i = 0; i < N; i++) hashT.push(await timeIt(async () => hashes.push(await scrypt.hashPin(PIN))));
  for (let i = 0; i < N; i++) vOkT.push(await timeIt(async () => { await scrypt.verifyPin(PIN, hashes[i]); }));
  for (let i = 0; i < N; i++) vBadT.push(await timeIt(async () => { await scrypt.verifyPin(WRONG, hashes[i]); }));

  console.log('\nlatency:');
  const p95h = summarize('hashPin', hashT);
  const p95vo = summarize('verify-correct', vOkT);
  const p95vb = summarize('verify-wrong', vBadT);

  const rssAfter = process.memoryUsage().rss;
  console.log(`\nRSS: before=${(rssBefore / 1048576).toFixed(1)}MiB after=${(rssAfter / 1048576).toFixed(1)}MiB delta=${((rssAfter - rssBefore) / 1048576).toFixed(1)}MiB`);

  const worstP95 = Math.max(p95h, p95vo, p95vb);
  const GO = worstP95 <= 250, NOGO = worstP95 > 400;
  console.log(`\nworst p95 = ${worstP95.toFixed(1)}ms  → ${NOGO ? 'NO-GO (>400ms)' : (GO ? 'GO (≤250ms)' : 'MARGINAL (250–400ms)')}`);
  process.exit(0);
})().catch((e) => { console.log('bench error: ' + e.message); process.exit(1); });
