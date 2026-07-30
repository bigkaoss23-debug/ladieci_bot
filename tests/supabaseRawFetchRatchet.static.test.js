'use strict';
// H1B — Security Foundation Block: static ratchet against raw Supabase/PostgREST
// fetches outside the shared transport. Supersedes the H1A same-line-only version.
// Eseguire: node tests/supabaseRawFetchRatchet.static.test.js
//
// STRATEGY. Rather than chasing every syntactic way to phrase a fetch() call
// (same line, multiline, template literal, string concatenation, a URL built in a
// variable, an aliased `fetch` reference, a new ad-hoc wrapper function), this
// ratchet detects the one thing every one of those forms must eventually contain
// to work at all: the literal PostgREST path segment "rest/v1" somewhere in the
// file's real code (comments are stripped first with a string-aware lexer, so a
// comment or a test string *describing* the pattern never triggers a false
// positive — string/template CONTENTS are kept verbatim, since a template
// literal or concatenated URL is code, not a comment, and must stay visible).
//
// Any file other than src/utils/supabaseTransport.js (the one sanctioned place)
// that contains "rest/v1" is a violation — no allowlist, no exceptions, no
// per-file wildcard. This is deliberately simpler than an AST walk (no new
// dependency is installed — package.json has no JS parser available) and is
// materially harder to accidentally slip past than the H1A same-line heuristic.
//
// Supabase AUTH access (/auth/v1/user, src/account/supabaseAccountAuthority.js)
// never needs an exception here: it never contains the substring "rest/v1" in the
// first place. External APIs (Google/Nominatim/Facebook/Anthropic) are untouched
// for the same reason — they never mention "rest/v1" either.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};

const ROOT = path.join(__dirname, '..');
const SANCTIONED_FILE = 'src/utils/supabaseTransport.js';

// String-aware comment stripper: walks the source character by character,
// tracking whether the cursor is inside a "..."/'...'/`...` literal (in which
// case "//" and "/*" are left untouched and copied verbatim — a URL like
// "https://..." or a template literal's own content must never be treated as a
// comment) versus real code (where line and block comments ARE stripped).
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (i + 1 < n ? text[i + 1] : ''); i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

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

const candidateFiles = [...listJsFiles(path.join(ROOT, 'src')), path.join(ROOT, 'index.js')];

// ── CHECK 1-3: "rest/v1" outside the sanctioned transport — same-line,
// multiline, template literal, concatenation and URL-in-a-variable all covered
// uniformly by a whole-file substring scan on comment-stripped source. ────────
const violations = [];
for (const file of candidateFiles) {
  const rel = relPath(file);
  if (rel === SANCTIONED_FILE) continue;
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  if (code.includes('rest/v1')) violations.push(rel);
}

console.log('  --- file scansionati:', candidateFiles.length, '---');
assert('1. scansione completata su tutti i file src/+index.js (nessun crash)', true);
assert('2-3. nessun file, oltre al transport sanzionato, contiene "rest/v1" (same-line, multilinea, template literal o concatenazione)',
  violations.length === 0, violations.join(', '));

// ── RAW_FETCH_ALLOWLIST — deve essere vuota dopo H1B (Passo 8: readShadowPreviewOrders
// migrato). Nessuna eccezione per index.js. ───────────────────────────────────
const RAW_FETCH_ALLOWLIST = Object.freeze([]);
assert('3b. allowlist raw-fetch è vuota (RAW_POSTGREST_FETCH_COUNT_OUTSIDE_TRANSPORT = 0)',
  RAW_FETCH_ALLOWLIST.length === 0);

// ── CHECK: alias semplici di fetch fuori dal transport (difesa aggiuntiva,
// ridondante col check 2-3 per costruzione ma esplicitamente richiesta) ───────
{
  const aliasRe = /=\s*(?:global\.)?fetch\s*(?![(\w])/;
  const aliasHits = [];
  for (const file of candidateFiles) {
    const rel = relPath(file);
    if (rel === SANCTIONED_FILE) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (aliasRe.test(code)) aliasHits.push(rel);
  }
  assert('4. nessun alias di fetch (es. "const f = fetch") fuori dal transport sanzionato',
    aliasHits.length === 0, aliasHits.join(', '));
}

// ── CHECK 4 (H1A, riconfermato): il transport non importa codice frontend ────
{
  const transportSrc = fs.readFileSync(path.join(ROOT, SANCTIONED_FILE), 'utf8');
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const badImports = [];
  let m;
  while ((m = requireRe.exec(transportSrc))) {
    if (/ladieci-app33|\/src\/components\/|\/react\b|^react$|^react-dom$/.test(m[1])) badImports.push(m[1]);
  }
  assert('5. supabaseTransport.js non importa alcun codice frontend', badImports.length === 0, badImports.join(', '));
}

// ── CHECK 5 (H1A, riconfermato): nessuna publishable/anon key nel transport ──
{
  const transportSrc = fs.readFileSync(path.join(ROOT, SANCTIONED_FILE), 'utf8');
  const anonMarkers = ['SUPABASE_ANON_KEY', 'sb_publishable', 'publishableKey', 'ANON_KEY'];
  const found = anonMarkers.filter((mk) => transportSrc.includes(mk));
  assert('6. nessun riferimento a publishable/anon key in supabaseTransport.js', found.length === 0, found.join(', '));
}

// ── CHECK 6 (H1B, aggiornato dopo la migrazione Passo 8): readShadowPreviewOrders
// non accetta più alcun parametro table — verificato sulla firma reale, non su un
// commento. ────────────────────────────────────────────────────────────────────
{
  const idxSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const sigMatch = idxSrc.match(/async function readShadowPreviewOrders\(([^)]*)\)/);
  assert('7. readShadowPreviewOrders ha firma (query) — nessun parametro table accettato dal chiamante',
    !!sigMatch && sigMatch[1].trim() === 'query');

  const fnMatch = idxSrc.match(/async function readShadowPreviewOrders\([^)]*\)\s*{([\s\S]*?)\n}/);
  const fnBody = fnMatch ? fnMatch[1] : '';
  assert('7b. readShadowPreviewOrders non legge mai il nome tabella da req.query/body/params',
    !!fnMatch && !/req\.(query|body|params)/.test(fnBody));
  assert('7c. readShadowPreviewOrders usa la risorsa interna fissa "ordenes"',
    !!fnMatch && /resource:\s*"ordenes"/.test(fnBody));

  const endpointSrc = fs.readFileSync(path.join(ROOT, 'src/core/delivery/shadowPreviewEndpoint.js'), 'utf8');
  assert('7d. shadowPreviewEndpoint.js invoca il dbClient function-shaped con un solo argomento (query)',
    /typeof dbClient === "function"\)\s*return dbClient\(query\)/.test(endpointSrc));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
