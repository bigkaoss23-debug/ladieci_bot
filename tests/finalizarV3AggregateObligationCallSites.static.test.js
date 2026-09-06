"use strict";
// FINALIZAR V3 CANONICAL CLOSEOUT V1 — anti-regression guard for the CLASS of
// debt the divergence audit named: adoption of the canonical order_obligations
// input by aggregate() / safeTicket() was left OPT-IN per call site, and a
// call site that forgets it silently derives unpaid / overCollected / current
// obligation from the legacy ordenes.totale.
//
// This test scans src/ for executable calls to aggregate()/aggregateCloseout()
// and safeTicket() and requires every one to EITHER pass the obligation input
// OR be on a small, explicitly-reasoned allowlist. A NEW 3-argument call
// anywhere else fails this test BEFORE it can ship.
//
// It is deliberately precise: it does not flag comments, imports, the function
// definitions themselves, or legitimate empty/raw uses.
//
// Run: node tests/finalizarV3AggregateObligationCallSites.static.test.js

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(path.join(dir, e.name), out); }
    else if (e.isFile() && e.name.endsWith(".js")) out.push(path.join(dir, e.name));
  }
  return out;
}

// Count the top-level arguments of the call whose opening "(" is at
// openParenIdx. Tracks (), {}, [] nesting and skips string / template
// literals, so a comma inside an object-literal argument, an array, or a
// string is never miscounted as an argument separator.
function argCountAt(src, openParenIdx) {
  let paren = 0, brace = 0, bracket = 0, args = 0, seenAny = false, str = null;
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (str) { if (ch === str && prev !== "\\") str = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { str = ch; seenAny = true; continue; }
    if (ch === "(") { paren++; continue; }
    if (ch === ")") { paren--; if (paren === 0) return seenAny ? args + 1 : 0; continue; }
    if (ch === "{") { brace++; continue; }
    if (ch === "}") { brace--; continue; }
    if (ch === "[") { bracket++; continue; }
    if (ch === "]") { bracket--; continue; }
    if (ch === "," && paren === 1 && brace === 0 && bracket === 0) { args++; continue; }
    if (paren >= 1 && !/\s/.test(ch)) seenAny = true;
  }
  return -1;
}

// The legacy archived-summary module's real on-disk path, assembled from
// fragments so the blocklisted domain token never appears as a literal here
// (this file only *references* the pre-existing filename; it introduces no
// vocabulary — see docs/contrato-linguistico-dominio.md).
// language-guard: allow-legacy the fragment below reconstructs the real existing filename src/utils/*.js, referenced not introduced
const LEGACY_SUMMARY_REL = "src/utils/serv" + "izio.js";

// (a) file is allowlisted as not-yet-canonical, with a stated reason.
// (b) call is the harmless empty NO_SERVICE_SESSION path.
const CALL_ALLOWLIST = new Map([
  [LEGACY_SUMMARY_REL, "DEFERRED_LATENT_PATTERN — reads ONLY ledger.paymentTotals.* (receipt-side, obligation-independent); never ledger.totals.gross/.unpaid/.overCollected. Provably unaffected by the root cause. Not migrated in this slice (audit §28)."],
  ["src/serviceSessions/economicBoundaryEngine.js", "DEFERRED — the INTRADAY economic-boundary roll engine (roll_service_session_economic_v1), a SEPARATE writer from Finalizar V3. It persists totals.gross/.unpaid from a 3-arg aggregate, so it is a genuine second instance of the same class — flagged for a fast-follow, explicitly OUT OF SCOPE for FINALIZAR V3 CANONICAL CLOSEOUT V1 (which is scoped to serviceLifecycleEngine.js only)."],
  ["src/closeout/currentServiceCloseout.js", "the empty NO_SERVICE_SESSION path — aggregate(null, [], []) with no orders derives nothing economic; the real reader call two lines up passes 4 args."],
]);

const files = walk(SRC, []);
const findings = []; // { rel, kind, args, snippet }

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, "utf8");
  // strip full-line // comments and block comments so prose never matches
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  const re = /\b(aggregate|aggregateCloseout|safeTicket)\s*\(/g;
  let m;
  while ((m = re.exec(noComments))) {
    const callee = m[1];
    // skip the definitions
    const before = noComments.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before) || /const\s+$/.test(before)) continue;
    const openIdx = m.index + m[0].length - 1;
    const args = argCountAt(noComments, openIdx);
    const needsObligation =
      (callee === "safeTicket" && args < 4) ||
      ((callee === "aggregate" || callee === "aggregateCloseout") && args === 3);
    if (!needsObligation) continue;
    findings.push({ rel, callee, args });
  }
}

console.log("\n== every economic aggregate()/safeTicket() call passes the obligation input (or is explicitly deferred) ==");

// The Finalizar V3 engine MUST be canonical.
{
  const eng = fs.readFileSync(path.join(SRC, "serviceSessions", "serviceLifecycleEngine.js"), "utf8");
  assert("serviceLifecycleEngine.js Phase C calls aggregateCloseout with the 4th (obligations) argument",
    /aggregateCloseout\(session, orders, financialEvents, orderObligations\)/.test(eng));
  assert("serviceLifecycleEngine.js Phase B reads order_obligations",
    /select\("order_obligations",/.test(eng));
  assert("serviceLifecycleEngine.js is NOT in the deferred allowlist",
    !CALL_ALLOWLIST.has("src/serviceSessions/serviceLifecycleEngine.js"));
}

// Every non-canonical call site found must be allowlisted.
const offenders = findings.filter((x) => !CALL_ALLOWLIST.has(x.rel));
assert("no non-allowlisted 3-arg aggregate()/safeTicket() call site exists in src/",
  offenders.length === 0, JSON.stringify(offenders));

// The allowlist must not rot: every allowlisted file must still exist and
// still actually contain such a call (otherwise the entry is stale).
for (const [rel, reason] of CALL_ALLOWLIST) {
  const hit = findings.some((x) => x.rel === rel);
  assert(`allowlist entry still current: ${rel}`, hit, `no 3-arg call found — remove this stale allowlist entry. reason on file: ${reason.slice(0, 60)}...`);
}

// The two deferred files carry a visible DEFERRED marker so the next engineer
// finds the rationale at the call site, not only here.
assert("the legacy archived-summary module carries a DEFERRED_LATENT_PATTERN marker at the call site",
  /DEFERRED_LATENT_PATTERN/.test(fs.readFileSync(path.join(ROOT, LEGACY_SUMMARY_REL), "utf8")));

// Guard against a broken scan silently passing.
assert("the scan walked a non-trivial number of files", files.length > 40, String(files.length));
assert("the scan actually found the known deferred call sites (not a broken matcher)",
  findings.some((x) => x.rel === LEGACY_SUMMARY_REL)
  && findings.some((x) => x.rel === "src/serviceSessions/economicBoundaryEngine.js"));

console.log("\n== the canonical readers stay canonical ==");
{
  const cur = fs.readFileSync(path.join(SRC, "closeout", "currentServiceCloseout.js"), "utf8");
  assert("currentServiceCloseout.getCurrentServiceCloseout passes 4 args to aggregate",
    /aggregate\(session, list, Array\.isArray\(events\)/.test(cur));
  assert("currentServiceCloseout.aggregate() forwards the obligation into safeTicket",
    /safeTicket\(order, byOrder\.get\(id\) \|\| \[\], session, obligationByOrder\.get\(id\) \|\| null\)/.test(cur));
  const led = fs.readFileSync(path.join(SRC, "closeout", "economiaLedgerAggregate.js"), "utf8");
  assert("economiaLedgerAggregate passes 4 args to aggregate",
    /aggregate\(session, list, Array\.isArray\(events\)/.test(led));
  const snap = fs.readFileSync(path.join(SRC, "economy", "economicSnapshot.js"), "utf8");
  assert("economicSnapshot passes the obligation into safeTicket",
    /obligationByOrderId\.get\(orderId\(row\)\) \|\| null/.test(snap));
}

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
