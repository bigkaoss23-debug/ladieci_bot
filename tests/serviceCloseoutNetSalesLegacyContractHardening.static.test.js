"use strict";
// SERVICE_CLOSEOUT_NET_SALES_LEGACY_CONTRACT_HARDENING_V1 — the guard test.
//
// Authority: SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md (2026-09-09,
// verdict ECONOMIC_FISCAL_CONTRACT_HARDENING_REQUIRED). This slice does NOT
// change what net_sales_cents means or how it is computed. It:
//   (A) makes the legacy semantics self-documenting at the schema — migration
//       125, COMMENT ON COLUMN only;
//   (C) removes the wire exposure — net_sales_cents no longer projected onto the
//       public closeout object that the service-close HTTP response returns.
//
// This test is the STANDING guard that keeps (C) true and stops a NEW consumer
// of the ambiguous legacy value from appearing silently in production source.
// It scans src/ itself: a new file that reads net_sales_cents / netSalesCents,
// or a new executable read inside one of the four allowlisted files, or
// publicCloseout() re-exposing the field onto the service-close HTTP response,
// all fail the build.
//
// No live Postgres for a NEW, unapplied migration — the migration-125 contract
// is asserted against its own bytes, same division of labour as every prior
// *.static.test.js.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); }
};

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MIG = path.join(ROOT, "migrations");
const TOKEN = /net_sales_cents|netSalesCents/;
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

// ── walk src/ for every *.js file, collect token lines ─────────────────────
function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}
const srcFiles = walk(SRC, []);
const tokenHits = {}; // relPath -> [{ n, text, executable }]
for (const abs of srcFiles) {
  const rel = path.relative(SRC, abs).split(path.sep).join("/");
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const hits = [];
  lines.forEach((text, i) => {
    if (TOKEN.test(text)) hits.push({ n: i + 1, text, executable: !isCommentLine(text) });
  });
  if (hits.length) tokenHits[rel] = hits;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n== A. PRODUCTION-SOURCE CONSUMER ALLOWLIST ==");

// Exactly these four src/ files may mention the token, and only in the shapes
// pinned below. Everything else — economic readers, the public serializer,
// reports/analytics/exports, API projections, a future Fiscal Candidate — is
// forbidden. Adding a fifth file, or a new executable read inside one of these
// four, fails here.
const ALLOWED_FILES = [
  "serviceSessions/serviceLifecycleEngine.js",
  "serviceSessions/economicBoundaryEngine.js",
  "closeout/serviceCloseoutCreation.js",
  "closeout/serviceCloseouts.js",
];

const seenFiles = Object.keys(tokenHits).sort();
assert(
  "A1: no production-source file outside the allowlist mentions net_sales_cents / netSalesCents",
  seenFiles.every((f) => ALLOWED_FILES.includes(f)),
  "unexpected: " + seenFiles.filter((f) => !ALLOWED_FILES.includes(f)).join(", ")
);
assert(
  "A2: every allowlisted file is actually still present in the scan (allowlist not stale)",
  ALLOWED_FILES.every((f) => f === "closeout/serviceCloseouts.js" || seenFiles.includes(f)),
  "missing: " + ALLOWED_FILES.filter((f) => f !== "closeout/serviceCloseouts.js" && !seenFiles.includes(f)).join(", ")
);

// ── per-file exact shape + count of EXECUTABLE (non-comment) token lines ────
function execLines(rel) {
  return (tokenHits[rel] || []).filter((h) => h.executable).map((h) => h.text.trim());
}

// WRITERS — compute the legacy value and hand it to the close writer. Exactly
// two executable token lines each: the Math.max computation and the create()
// argument. A third would mean a new read.
for (const rel of ["serviceSessions/serviceLifecycleEngine.js", "serviceSessions/economicBoundaryEngine.js"]) {
  const ex = execLines(rel);
  assert(`B-${rel}: exactly 2 executable token lines (compute + pass-to-writer)`, ex.length === 2, JSON.stringify(ex));
  assert(`B-${rel}: the computation is the frozen legacy formula`,
    ex.some((l) => l === "const netSalesCents = Math.max(0, grossSalesCents - refundedCents);"), JSON.stringify(ex));
  assert(`B-${rel}: the other executable line only passes netSalesCents to create()`,
    ex.filter((l) => l !== "const netSalesCents = Math.max(0, grossSalesCents - refundedCents);")
      .every((l) => /(^|,\s*)netSalesCents,$/.test(l)), JSON.stringify(ex));
}

// PERSISTENCE — serviceCloseoutCreation.js: destructures the param and maps it
// to the RPC arg p_net_sales_cents. Exactly two executable token lines.
{
  const rel = "closeout/serviceCloseoutCreation.js";
  const ex = execLines(rel);
  assert(`B-${rel}: exactly 2 executable token lines (destructure + RPC arg)`, ex.length === 2, JSON.stringify(ex));
  assert(`B-${rel}: one destructures the netSalesCents param`, ex.includes("netSalesCents,"), JSON.stringify(ex));
  assert(`B-${rel}: one maps it to the RPC param p_net_sales_cents`,
    ex.includes("p_net_sales_cents: netSalesCents,"), JSON.stringify(ex));
}

// PUBLIC SERIALIZER — serviceCloseouts.js: the wire exposure is REMOVED. The
// token may survive ONLY inside the explanatory comment; zero executable
// occurrences.
{
  const rel = "closeout/serviceCloseouts.js";
  const ex = execLines(rel);
  assert(`C1-${rel}: ZERO executable token lines (public projection dropped)`, ex.length === 0, JSON.stringify(ex));
  const body = fs.readFileSync(path.join(SRC, rel), "utf8");
  assert(`C2-${rel}: publicCloseout() does not assign netSalesCents`,
    !/netSalesCents\s*:/.test(body.split("\n").filter((l) => !isCommentLine(l)).join("\n")));
  assert(`C3-${rel}: it does not read row.net_sales_cents in executable code`,
    !/row\.net_sales_cents/.test(body.split("\n").filter((l) => !isCommentLine(l)).join("\n")));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n== C. WIRE-EXPOSURE REGRESSION — publicCloseout() runtime shape ==");
{
  const { publicCloseout } = require("../src/closeout/serviceCloseouts");
  const row = {
    id: "co-x", service_session_id: "s-x", closeout_correlation_id: "corr-x",
    business_date: "2026-09-09", service_kind: null,
    opened_at: "2026-09-08T20:13:37Z", closed_at: "2026-09-09T15:18:17Z",
    close_source: "operator_finalizar_v3", close_reason: null, closed_by: "owner",
    gross_sales_cents: 2400, net_sales_cents: 2100, total_discounts_cents: 0,
    total_refunds_cents: 300, total_void_cents: 0,
    paid_amount_cents: 1600, unpaid_exposure_cents: 0, order_count: 1,
    cash_amount_cents: 1000, card_amount_cents: 600, bizum_amount_cents: 0, other_amount_cents: 0,
    current_obligation_cents: 1600, over_collected_cents: 0,
    open_orders_at_close: 0, occupied_tables_at_close: 0, kitchen_pending_count: 0,
    listo_count: 0, delivery_pending_count: 0, incident_count: 0, critical_incident_count: 0,
    created_at: "2026-09-09T15:18:16Z",
  };
  const out = publicCloseout(row);
  assert("D1: netSalesCents is NOT on the public closeout financial group", !("netSalesCents" in out.financial));
  assert("D2: no snake_case net_sales_cents leaks either", !("net_sales_cents" in out.financial) && !("net_sales_cents" in out));
  assert("D3: every canonical financial fact IS still projected",
    ["grossSalesCents", "totalDiscountsCents", "totalRefundsCents", "totalVoidCents", "paidAmountCents",
     "unpaidExposureCents", "orderCount", "cashAmountCents", "cardAmountCents", "bizumAmountCents",
     "otherAmountCents", "currentObligationCents", "overCollectedCents"].every((k) => k in out.financial),
    JSON.stringify(Object.keys(out.financial)));
  assert("D4: the canonical values are unchanged (gross 2400 / obligation 1600 / paid 1600 / refunds 300 / over 0)",
    out.financial.grossSalesCents === 2400 && out.financial.currentObligationCents === 1600 &&
    out.financial.paidAmountCents === 1600 && out.financial.totalRefundsCents === 300 &&
    out.financial.overCollectedCents === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n== D. WRITER FORMULA INVARIANCE — the legacy formula is NOT changed ==");
{
  const engine = fs.readFileSync(path.join(SRC, "serviceSessions/serviceLifecycleEngine.js"), "utf8");
  const roll = fs.readFileSync(path.join(SRC, "serviceSessions/economicBoundaryEngine.js"), "utf8");
  const FORMULA = "const netSalesCents = Math.max(0, grossSalesCents - refundedCents);";
  assert("E1: serviceLifecycleEngine keeps the exact legacy formula", engine.includes(FORMULA));
  assert("E2: economicBoundaryEngine keeps the exact legacy formula", roll.includes(FORMULA));
  // In each writer there is EXACTLY ONE assignment to netSalesCents, and it is
  // the frozen formula — never `= currentObligationCents`, `= paidAmountCents`,
  // `= toCents(closeout.totals.gross)` or anything else.
  const netSalesAssignments = (src) =>
    src.split("\n").map((l) => l.trim()).filter((l) => /^(const\s+)?netSalesCents\s*=/.test(l));
  for (const [name, src] of [["serviceLifecycleEngine", engine], ["economicBoundaryEngine", roll]]) {
    const asn = netSalesAssignments(src);
    assert(`E3-${name}: exactly one netSalesCents assignment, and it is the frozen formula`,
      asn.length === 1 && asn[0] === FORMULA, JSON.stringify(asn));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n== E. FISCAL-CANDIDATE GUARD — no fiscal path may read the field ==");
{
  const fiscalFiles = srcFiles.filter((f) => /fiscal/i.test(path.relative(SRC, f)));
  assert("F1: no src file whose path mentions 'fiscal' exists yet OR reads net_sales_cents",
    fiscalFiles.every((f) => !TOKEN.test(fs.readFileSync(f, "utf8"))),
    fiscalFiles.map((f) => path.relative(SRC, f)).join(", "));
  // Documented invariant for whoever builds Fiscal Candidate: the taxable base
  // is current_obligation_cents, never net_sales_cents. This test is the place
  // that will break if a fiscal reader binds to the wrong column.
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n== F. MIGRATION 125 CONTRACT — COMMENT-only, faithful rollback ==");
const FWD = "2026-09-09_service_closeout_net_sales_legacy_contract_hardening_v1_migration_125.sql";
const RBK = "2026-09-09_service_closeout_net_sales_legacy_contract_hardening_v1_migration_125.ROLLBACK.sql";
const fwdRaw = fs.readFileSync(path.join(MIG, FWD), "utf8");
const rbkRaw = fs.readFileSync(path.join(MIG, RBK), "utf8");
const stripSql = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const fwd = stripSql(fwdRaw);
const rbk = stripSql(rbkRaw);

assert("G1: forward file exists and is one transaction", /^BEGIN;$/m.test(fwdRaw) && /^COMMIT;$/m.test(fwdRaw) && !/^ROLLBACK;$/m.test(fwdRaw));
assert("G2: rollback file exists and is one transaction", /^BEGIN;$/m.test(rbkRaw) && /^COMMIT;$/m.test(rbkRaw));
assert("G3: DO blocks use named tags ($guard$ / $post$), never bare $$", /DO \$guard\$/.test(fwdRaw) && /DO \$post\$/.test(fwdRaw) && !/DO \$\$/.test(fwd));

assert("G4: forward has EXACTLY one COMMENT ON COLUMN, on net_sales_cents",
  (fwd.match(/COMMENT ON COLUMN/gi) || []).length === 1 &&
  /COMMENT ON COLUMN public\.service_closeouts\.net_sales_cents IS/.test(fwd));
assert("G5: forward does NOTHING structural — no ALTER/ADD/DROP/CREATE FUNCTION/TRIGGER/INDEX/GRANT/REVOKE",
  !/\bALTER\s+TABLE\b/i.test(fwd) && !/\bADD\s+COLUMN\b/i.test(fwd) && !/\bDROP\s+(COLUMN|TABLE|CONSTRAINT|INDEX|FUNCTION|TRIGGER)\b/i.test(fwd) &&
  !/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(fwd) && !/\bCREATE\s+TRIGGER\b/i.test(fwd) &&
  !/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(fwd) && !/\bGRANT\b/i.test(fwd) && !/\bREVOKE\b/i.test(fwd) &&
  !/\bRENAME\b/i.test(fwd));
assert("G6: forward has ZERO DML (no INSERT/UPDATE/DELETE/TRUNCATE against a table)",
  !/\bINSERT\s+INTO\b/i.test(fwd) && !/\bUPDATE\s+public\./i.test(fwd) && !/\bDELETE\s+FROM\b/i.test(fwd) && !/\bTRUNCATE\b/i.test(fwd));
assert("G7: forward does NOT write the ledger inline (registered separately, as ledgers 96-124)",
  !/INSERT INTO public\.ladieci_schema_migrations/i.test(fwd));

// The exact contract clauses the comment MUST carry (audit §16).
for (const clause of [
  "LEGACY / HISTORICAL compatibility field",
  "net_sales_cents = max(0, gross_sales_cents - total_refunds_cents)",
  "ORIGINAL ORDER GROSS",
  "Commercial adjustments (order_obligations revisions) are NOT reflected here",
  "NOT the current obligation (use current_obligation_cents)",
  "NOT the net collected (use paid_amount_cents)",
  "NOT a canonical accounting authority",
  "NOT a taxable base",
  "NOT a fiscal or invoice total",
  "New consumers MUST NOT read this column",
]) {
  assert(`G8: forward comment contract carries the clause -> "${clause.slice(0, 48)}..."`, fwdRaw.includes(clause));
}
assert("G9: forward comment does NOT redefine net_sales_cents as the obligation or the net collected",
  !/net_sales_cents\s*=\s*current_obligation_cents/i.test(fwdRaw) && !/net_sales_cents\s*=\s*paid_amount_cents/i.test(fwdRaw));

assert("G10: rollback restores the pre-M125 state — COMMENT ... IS NULL, and nothing else",
  /COMMENT ON COLUMN public\.service_closeouts\.net_sales_cents IS NULL;/.test(rbk) &&
  (rbk.match(/COMMENT ON COLUMN/gi) || []).length === 1);
assert("G11: rollback does NOTHING structural and ZERO DML",
  !/\bALTER\s+TABLE\b/i.test(rbk) && !/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(rbk) &&
  !/\bDROP\s+(COLUMN|TABLE|CONSTRAINT|INDEX|FUNCTION|TRIGGER)\b/i.test(rbk) &&
  !/\bINSERT\s+INTO\b/i.test(rbk) && !/\bUPDATE\s+public\./i.test(rbk) && !/\bDELETE\s+FROM\b/i.test(rbk) && !/\bTRUNCATE\b/i.test(rbk));
assert("G12: rollback guard refuses unless the current comment is exactly the M125 text",
  /IS DISTINCT FROM \$c\$LEGACY \/ HISTORICAL compatibility field\./.test(rbkRaw));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n== G. MANIFEST — the row exists and declares ledger 125, not-yet-applied ==");
{
  const manifest = fs.readFileSync(path.join(MIG, "MIGRATION_MANIFEST.md"), "utf8");
  const row = manifest.split("\n").find((l) => l.includes(FWD) && /^\s*\|\s*\d+\s*\|/.test(l));
  assert("H1: exactly one manifest row references the forward migration file", !!row &&
    manifest.split("\n").filter((l) => l.includes(FWD)).length === 1);
  assert("H2: the manifest row declares ledger apply_order 125", !!row && /apply_order 125/.test(row));
  assert("H3: the manifest row marks it NOT YET APPLIED (ledger stays 124)", !!row && /NOT YET APPLIED/i.test(row) && /ledger stays 124/i.test(row));
  assert("H4: the manifest row names the field being hardened", !!row && /net_sales_cents/.test(row));
}

console.log(`\n== serviceCloseoutNetSalesLegacyContractHardening.static: ${pass} passed, ${fail} failed ==\n`);
if (fail > 0) process.exitCode = 1;
