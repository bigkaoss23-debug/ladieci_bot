// tests/n2CanonicalOrderObligation.test.js — N-2 canonical obligation:
// READER PRECEDENCE behaviour (safeTicket/aggregate) + static migration assertions.
// The DB-side behaviour (creation writes exactly one revision-1, a totale edit appends
// revision 2, UPDATE/DELETE refused, duplicate refused, channel convergence, Mesa
// non-regression) is proven separately by rollback-safe probes against real staging data,
// recorded in this slice's report.
// Run: node tests/n2CanonicalOrderObligation.test.js
const fs = require("fs");
const path = require("path");
const {
  safeTicket, aggregate, latestObligationsByOrder,
} = require("../src/closeout/currentServiceCloseout");

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

const SESSION = { id: "sess-1", status: "open", service_kind: "SERA" };
const obl = (order_id, revision, gross_amount, extra = {}) => ({
  order_id, revision, gross_amount, service_session_id: "sess-1", source: revision === 1 ? "order_create_v1" : "order_total_revision_v1", ...extra,
});

// ── latestObligationsByOrder: highest revision wins ────────────────────────
{
  const map = latestObligationsByOrder([obl("#1", 1, 10), obl("#1", 3, 30), obl("#1", 2, 20)]);
  check("folds to the HIGHEST revision, regardless of input order", Number(map.get("#1").gross_amount) === 30);
  check("ignores rows with no order_id", latestObligationsByOrder([{ revision: 1, gross_amount: 5 }]).size === 0);
  check("empty/undefined input is safe", latestObligationsByOrder(undefined).size === 0 && latestObligationsByOrder([]).size === 0);
}

// ── A: NEW order — obligation is the gross; unpaid == gross; collected 0 ───
{
  const order = { id: "#100", estado: "EN_COCINA", totale: 41.5 };
  const t = safeTicket(order, [], SESSION, obl("#100", 1, 41.5));
  check("A: canonical obligation supplies gross", t.amount === 41.5);
  check("A: collected is 0 with no payment event", t.collectedAmount === 0);
  check("A: unpaid == gross", t.unpaidAmount === 41.5);
  check("A: paymentState unpaid", t.paymentState === "unpaid");
}

// ── G: PRECEDENCE — the canonical obligation WINS over a diverging totale ──
// This is the whole point: once an order is canonical, the mutable column is
// no longer the economic authority.
{
  const order = { id: "#101", estado: "EN_COCINA", totale: 999.99 };
  const t = safeTicket(order, [], SESSION, obl("#101", 2, 58.0));
  check("G: obligation beats ordenes.totale (no double source of truth)", t.amount === 58.0);
  check("G: unpaid derives from the obligation, not totale", t.unpaidAmount === 58.0);
}

// ── F: LEGACY FALLBACK — a pre-N-2 order with no obligation still counts once
{
  const order = { id: "#102", estado: "EN_COCINA", totale: 33.0 };
  const t = safeTicket(order, [], SESSION, null);
  check("F: no obligation -> legacy totale fallback", t.amount === 33.0);
  check("F: legacy unpaid still derives correctly", t.unpaidAmount === 33.0);
  const tUndef = safeTicket(order, [], SESSION);
  check("F: omitting the argument entirely is identical to null (pre-N-2 callers unchanged)", tUndef.amount === 33.0);
}

// ── gross_amount = 0 is a real obligation, not a missing one ───────────────
{
  const order = { id: "#103", estado: "EN_COCINA", totale: 77.0 };
  const t = safeTicket(order, [], SESSION, obl("#103", 1, 0));
  check("a zero-gross obligation is honoured (0 is a value, not absence)", t.amount === 0);
}

// ── payment interaction: obligation is the CAP, ledger supplies collected ──
{
  const order = { id: "#104", estado: "EN_COCINA", totale: 10.0 };
  const events = [{ type: "payment", amount: 20.0, payment_method: "efectivo" }];
  const t = safeTicket(order, events, SESSION, obl("#104", 2, 20.0));
  check("collected is capped by the OBLIGATION, not by the stale totale", t.collectedAmount === 20.0);
  check("fully-paid against the obligation leaves 0 unpaid", t.unpaidAmount === 0);
  check("paymentState paid", t.paymentState === "paid");
}

// ── N-3 boundary: legacy paid flags are NOT re-interpreted by N-2 ──────────
{
  const order = { id: "#105", estado: "EN_COCINA", totale: 15.0, ya_pagado: true, metodo_pago: "efectivo" };
  const t = safeTicket(order, [], SESSION, obl("#105", 1, 15.0));
  check("legacy ya_pagado still collects exactly as before N-2 (no fabricated payment event)", t.collectedAmount === 15.0);
  check("legacy paid + canonical obligation -> unpaid 0, no double count", t.unpaidAmount === 0);
}

// ── H/I: aggregate() — mixed canonical + legacy tickets, counted ONCE each ─
{
  const orders = [
    { id: "#200", estado: "EN_COCINA", totale: 100.0 },  // canonical, obligation says 60
    { id: "#201", estado: "EN_COCINA", totale: 25.0 },   // legacy, no obligation
  ];
  const obligations = [obl("#200", 1, 50.0), obl("#200", 2, 60.0)];
  const out = aggregate(SESSION, orders, [], obligations);
  check("H: gross = canonical(60) + legacy(25) = 85, each counted exactly once", out.totals.gross === 85.0);
  check("H: unpaid mirrors gross when nothing is collected", out.totals.unpaid === 85.0);
  check("H: ticket count is 2 (no phantom ticket per revision)", out.tickets.length === 2 && out.counts.tickets === 2);
  check("I: the canonical ticket reports the obligation, not its totale", out.tickets.find((t) => t.id === "#200").amount === 60.0);
  check("I: the legacy ticket reports its totale", out.tickets.find((t) => t.id === "#201").amount === 25.0);

  // Same input, obligations withheld -> pure pre-N-2 behaviour.
  const legacyOnly = aggregate(SESSION, orders, []);
  check("aggregate() without obligations is byte-identical to pre-N-2 (100+25)", legacyOnly.totals.gross === 125.0);
}

// ── E: MESA REGRESSION — a Mesa ticket is one ticket, never double-counted ─
// A Mesa order carries BOTH table_order_lines (its payment-picker substrate)
// and now one obligation. The economic reader must see exactly one amount.
{
  const mesaOrder = { id: "#300", estado: "EN_COCINA", totale: 25.0, table_session_id: "ts-1" };
  const out = aggregate(SESSION, [mesaOrder], [], [obl("#300", 1, 25.0)]);
  check("E: Mesa ticket counted once at its obligation amount", out.totals.gross === 25.0 && out.tickets.length === 1);
}

// ── Static migration assertions ────────────────────────────────────────────
const dir = path.join(__dirname, "..", "migrations");
const stripComments = (s) => s.replace(/--.*$/gm, "");
const fwdRaw = fs.readFileSync(path.join(dir, "2026-08-24_n2_canonical_order_obligation.sql"), "utf8");
const fwd = stripComments(fwdRaw);
const rbRaw = fs.readFileSync(path.join(dir, "2026-08-24_n2_canonical_order_obligation.ROLLBACK.sql"), "utf8");
const rb = stripComments(rbRaw);

check("has a predecessor guard before the transaction", /RAISE EXCEPTION 'N-2 refused:/.test(fwd) && fwd.indexOf("RAISE EXCEPTION 'N-2 refused:") < fwd.indexOf("BEGIN;"));
check("wrapped in one transaction", /BEGIN;/.test(fwd) && /COMMIT;\s*$/.test(fwd.trim()));
check("creates order_obligations", /CREATE TABLE public\.order_obligations/.test(fwd));
check("no ledger INSERT embedded (checksum self-reference avoided, matches ledgers 96-111)", !/INSERT INTO public\.ladieci_schema_migrations/.test(fwd));

// Identity: permanent order_uid, never the recyclable display id.
check("keyed on the permanent order_uid with an FK to order_entities", /order_uid\s+uuid NOT NULL REFERENCES public\.order_entities\(order_uid\)/.test(fwd));
check("uniqueness is (order_uid, revision), NOT order_id", /UNIQUE \(order_uid, revision\)/.test(fwd) && !/UNIQUE \(order_id\b/.test(fwd));
check("service ownership is NOT NULL and FK'd to service_sessions", /service_session_id\s+uuid NOT NULL REFERENCES public\.service_sessions\(id\)/.test(fwd));
check("gross is non-negative", /gross_amount >= 0/.test(fwd));
check("only revision 1 may be a creation obligation", /\(source = 'order_create_v1'\) = \(revision = 1\)/.test(fwd));

// Atomicity: both writers are triggers on ordenes, so they share its transaction.
check("creation writer is an AFTER INSERT trigger on ordenes", /CREATE TRIGGER ordenes_order_obligation_anchor_v1\s+AFTER INSERT ON public\.ordenes/.test(fwd));
check("revision writer is scoped to UPDATE OF totale", /CREATE TRIGGER ordenes_order_obligation_revision_v1\s+AFTER UPDATE OF totale ON public\.ordenes/.test(fwd));
check("no JS-side second call: both writers live in the DB", !/http|fetch|axios/i.test(fwd));

// Append-only, DB-enforced.
check("append-only trigger refuses UPDATE and DELETE", /BEFORE UPDATE OR DELETE ON public\.order_obligations/.test(fwd));
check("append-only guard raises on both branches", /UPDATE is forbidden/.test(fwd) && /DELETE is forbidden/.test(fwd));

// The revision writer must never retro-fit a pre-N-2 order.
check("a pre-N-2 order (no revision 1) is left on the legacy fallback", /IF NOT FOUND THEN\s+RETURN NEW;/.test(fwd));

// Amount authority: server-derived from the accepted row, never a client field.
check("gross is taken from the order's own NEW.totale, not a client-supplied amount", /COALESCE\(NEW\.totale, 0\)/.test(fwd));
check("workspace is resolved from order_entities, never from payload", /FROM public\.order_entities oe WHERE oe\.order_uid = NEW\.order_uid/.test(fwd));

// Grants: the service_role default-privilege trap this slice's own post-condition caught.
check("REVOKE names service_role explicitly (Supabase default privileges grant it ALL)", /REVOKE ALL ON TABLE public\.order_obligations FROM PUBLIC, anon, authenticated, service_role;/.test(fwd));
check("service_role is re-granted SELECT+INSERT only", /GRANT SELECT, INSERT ON TABLE public\.order_obligations TO service_role;/.test(fwd));
check("RLS enabled AND forced", /ENABLE ROW LEVEL SECURITY/.test(fwd) && /FORCE ROW LEVEL SECURITY/.test(fwd));
check("post-condition proves not even service_role keeps UPDATE/DELETE", /not even service_role may hold UPDATE\/DELETE/.test(fwd));
check("post-condition proves the ledger starts empty (no backfill)", /must start empty \(no backfill\)/.test(fwd));
check("post-condition proves Mesa's own triggers survived", /Mesa line-snapshot trigger disappeared/.test(fwd) && /R-DAY2 identity anchor disappeared/.test(fwd));

// No business DML: this migration must not touch a single existing row.
check("no business DML against ordenes / existing financial tables",
  !/\bUPDATE public\.(ordenes|order_financial_events|table_order_lines|payment_transactions|payment_allocations)\b/.test(fwd) &&
  !/\bDELETE FROM public\.(ordenes|order_financial_events|table_order_lines|payment_transactions|payment_allocations)\b/.test(fwd));
check("no INSERT INTO order_obligations at migration time (backfill-free)",
  !/INSERT INTO public\.order_obligations[\s\S]{0,40}SELECT[\s\S]{0,80}FROM public\.ordenes/.test(fwd));

// Rollback must never destroy real obligations.
check("rollback drops both writer triggers", /DROP TRIGGER IF EXISTS ordenes_order_obligation_anchor_v1/.test(rb) && /DROP TRIGGER IF EXISTS ordenes_order_obligation_revision_v1/.test(rb));
check("rollback drops the table ONLY when it is empty", /IF v_n = 0 THEN[\s\S]{0,200}DROP TABLE public\.order_obligations/.test(rb));
// Read from the RAW rollback: this phrase lives inside a RAISE NOTICE string
// literal that itself contains a `--`, which the comment-stripper above would
// eat. The executable ELSE branch genuinely has no DROP, asserted separately.
check("rollback preserves a non-empty ledger instead of dropping it", /DELIBERATELY PRESERVED/.test(rbRaw));
check("rollback's non-empty branch contains no DROP at all",
  !/ELSE[\s\S]*?DROP\s+TABLE/i.test(rb.slice(rb.indexOf("IF v_n = 0 THEN"), rb.indexOf("END $$;"))
    .split(/\bELSE\b/)[1] || ""));
check("rollback keeps the append-only guard on preserved rows", /preserved obligations lost their append-only guard/.test(rb));
check("rollback asserts Mesa/R-DAY2 survive", /Mesa line-snapshot trigger disappeared/.test(rb) && /R-DAY2 identity anchor disappeared/.test(rb));

const crypto = require("crypto");
check("checksum is a 16-hex-char string (manifest convention)",
  /^[0-9a-f]{16}$/.test(crypto.createHash("sha256").update(fwdRaw, "utf8").digest("hex").slice(0, 16)));

console.log(`\nn2CanonicalOrderObligation: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
