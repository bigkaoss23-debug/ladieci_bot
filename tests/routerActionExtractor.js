'use strict';
// Test-only helper (B4). Extracts the set of dispatched router action names from
// index.js WITHOUT importing/wiring the router. No AST parser is available in
// node_modules, so this uses a bounded lexical scan with anti-no-op controls;
// the B4 test drives it with negative controls (synthetic sources) to prove it
// actually detects added / removed / misspelled / duplicated actions.
//
// Dispatch shape in index.js (both app.get("/api") and app.post("/api")):
//   ... if (action === "NAME") { ... } else if (action === "NAME2") { ... }
// `action` is sourced from req.query.action / req.body.action. There is no
// switch/case. We extract every string literal compared with `action === "..."`.
const fs = require('fs');
const path = require('path');

// Matches:  action === "name"  |  action === 'name'  (any surrounding spacing).
const ACTION_CMP_RE = /action\s*===\s*(["'])([^"']+)\1/g;

// Extract from an arbitrary source string (used by negative controls).
function extractActionsFromSource(source) {
  if (typeof source !== 'string') return [];
  const out = [];
  let m;
  ACTION_CMP_RE.lastIndex = 0;
  while ((m = ACTION_CMP_RE.exec(source)) !== null) {
    out.push(m[2]);
  }
  return out;
}

// Extract the DEDUPED set (array) of router actions from the live index.js.
function extractRouterActions(indexPath) {
  const p = indexPath || path.join(__dirname, '..', 'index.js');
  const source = fs.readFileSync(p, 'utf8');
  return [...new Set(extractActionsFromSource(source))];
}

// Same as above but preserves duplicates (so a duplicate route is detectable).
function extractRouterActionsWithDuplicates(indexPath) {
  const p = indexPath || path.join(__dirname, '..', 'index.js');
  const source = fs.readFileSync(p, 'utf8');
  return extractActionsFromSource(source);
}

module.exports = {
  extractActionsFromSource,
  extractRouterActions,
  extractRouterActionsWithDuplicates,
};
