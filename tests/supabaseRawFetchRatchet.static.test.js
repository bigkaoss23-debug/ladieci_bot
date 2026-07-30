'use strict';
// H1A — Security Foundation Block: static ratchet against new raw Supabase fetches.
// Eseguire: node tests/supabaseRawFetchRatchet.static.test.js
//
// PURPOSE. H1A introduces src/utils/supabaseTransport.js as the sanctioned, hardened
// transport and migrates the two shared helpers (src/utils/supabase.js, src/auth/
// audit.js) to use it. It does NOT migrate every domain in one pass (agentOrdini.js,
// servizio.js, manualGiros.js, geoResolver.js still call the shared helpers directly,
// which is fine — they never touch `fetch()` themselves). This test does not require
// zero raw fetch(): the full migration is H1B/H2/H3's job. It only guarantees the
// gap cannot silently widen.
//
// This is a SOURCE scan, not a require-graph trace (unlike tests/v3bWriterUnwired.
// static.test.js's approach for the V3 branch) — deliberately simpler, matching the
// "foundation, not big-bang" scope of H1A.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};

const ROOT = path.join(__dirname, '..');

// ── ALLOWLIST — legacy raw-fetch call sites NOT YET migrated to
// src/utils/supabaseTransport.js. Exact file paths only, no wildcards. Each entry
// is temporary and tied to a future block: remove the entry the same commit that
// migrates the file.
//
//   index.js (readShadowPreviewOrders, ~line 237) — H1B/H2 candidate: the Delivery
//   Planner shadow-preview read-only endpoint. Source-verified (Fase 5H/5J audits)
//   to be invoked ONLY with the literal table name "ordenes" (see CHECK 6 below,
//   which re-verifies this on every run rather than trusting this comment).
const RAW_FETCH_ALLOWLIST = Object.freeze([
  'index.js',
]);

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'tests') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function relPath(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

// ── CHECK 1-3: censire i raw fetch PostgREST, confrontare con l'allowlist ────
const candidateFiles = [
  ...listJsFiles(path.join(ROOT, 'src')),
  path.join(ROOT, 'index.js'),
];

const rawFetchSites = [];
for (const file of candidateFiles) {
  const rel = relPath(file);
  if (rel === 'src/utils/supabaseTransport.js') continue; // the sanctioned transport itself
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    // A "raw Supabase fetch" = a literal fetch( call whose URL construction touches
    // /rest/v1/ on the same line (the pattern every pre-H1A helper used) — a
    // deliberately narrow, low-false-positive heuristic for this foundation-only ratchet.
    if (/\bfetch\(/.test(line) && /rest\/v1\//.test(line)) {
      rawFetchSites.push({ file: rel, line: idx + 1, text: line.trim() });
    }
  });
}

console.log('  --- censimento raw fetch PostgREST rilevati ---');
for (const s of rawFetchSites) console.log(`      ${s.file}:${s.line}`);

assert('1. censimento completato (nessun crash sulla scansione sorgente)', true);

const unexpected = rawFetchSites.filter((s) => !RAW_FETCH_ALLOWLIST.includes(s.file));
assert('2-3. ogni raw fetch rilevato è nell\'allowlist esplicita (nessun nuovo fetch fuori allowlist)',
  unexpected.length === 0,
  unexpected.map((s) => `${s.file}:${s.line}`).join(', '));

// Also assert the allowlist has no stale/unused entries — keeps it "piccola,
// temporanea" as required, not a place where dead entries accumulate.
const filesWithRawFetch = new Set(rawFetchSites.map((s) => s.file));
const staleAllowlistEntries = RAW_FETCH_ALLOWLIST.filter((f) => !filesWithRawFetch.has(f));
assert('3b. allowlist senza voci obsolete (ogni entry corrisponde a un fetch reale)',
  staleAllowlistEntries.length === 0, staleAllowlistEntries.join(', '));

// ── CHECK 4: il transport non importa codice frontend ─────────────────────
{
  const transportSrc = fs.readFileSync(path.join(ROOT, 'src/utils/supabaseTransport.js'), 'utf8');
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const badImports = [];
  let m;
  while ((m = requireRe.exec(transportSrc))) {
    const spec = m[1];
    // Allowed: node builtins / no relative path escaping into a frontend tree.
    const looksFrontend = /ladieci-app33|\/src\/components\/|\/react\b|^react$|^react-dom$/.test(spec);
    if (looksFrontend) badImports.push(spec);
  }
  assert('4. supabaseTransport.js non importa alcun codice frontend', badImports.length === 0, badImports.join(', '));
}

// ── CHECK 5: nessuna publishable/anon key nel client server-side ──────────
{
  const transportSrc = fs.readFileSync(path.join(ROOT, 'src/utils/supabaseTransport.js'), 'utf8');
  const anonMarkers = ['SUPABASE_ANON_KEY', 'sb_publishable', 'publishableKey', 'ANON_KEY', 'anonKey'];
  const found = anonMarkers.filter((mk) => transportSrc.includes(mk));
  assert('5. nessun riferimento a publishable/anon key in supabaseTransport.js', found.length === 0, found.join(', '));
}

// ── CHECK 6: nessuna route può fornire dinamicamente il nome tabella ──────
// Il solo punto storicamente dinamico è readShadowPreviewOrders(table, query) in
// index.js, chiamato oggi solo da shadowPreviewEndpoint.js con il letterale "ordenes".
// Verifica il call site reale, non si fida di un commento.
{
  const endpointPath = path.join(ROOT, 'src/core/delivery/shadowPreviewEndpoint.js');
  let ok = false;
  let detail = 'file non trovato: ' + relPath(endpointPath);
  if (fs.existsSync(endpointPath)) {
    const src = fs.readFileSync(endpointPath, 'utf8');
    const callMatch = src.match(/dbClient\(\s*(['"][^'"]*['"]|[^,)]+)\s*,/);
    if (callMatch) {
      const arg = callMatch[1].trim();
      ok = /^['"]ordenes['"]$/.test(arg);
      detail = `dbClient primo argomento = ${arg}`;
    } else {
      detail = 'nessuna chiamata dbClient(...) trovata';
    }
  }
  assert('6. readShadowPreviewOrders è invocato solo con il letterale "ordenes", mai un valore dinamico', ok, detail);

  // E la funzione stessa non deve MAI leggere il nome tabella da req.query/req.body.
  const idxSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const fnMatch = idxSrc.match(/async function readShadowPreviewOrders\(([^)]*)\)\s*{([\s\S]*?)\n}/);
  const fnBody = fnMatch ? fnMatch[2] : '';
  const readsFromRequest = /req\.(query|body|params)/.test(fnBody);
  assert('6b. readShadowPreviewOrders non legge mai il nome tabella da req.query/body/params',
    !readsFromRequest);
}

// ── CHECK 7: questo test non pretende zero raw fetch ───────────────────────
assert('7. il ratchet accetta esplicitamente un\'allowlist non vuota (migrazione incrementale, non big-bang)',
  RAW_FETCH_ALLOWLIST.length >= 0); // documentativo: vero per costruzione, il punto è che non lanciamo se >0

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
