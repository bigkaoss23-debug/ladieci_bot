"use strict";
// ===============================================================
// tableSettlementNetting.js — CORRECTIVE SLICE 150 (#5): ONE settlement per Mesa table session.
//
// A Mesa payment is money the TABLE pays: mesa_post_payment_v1 accepts at most the table's
// outstanding and allocates it to comandas by their caps. A later commercial adjustment can
// move a comanda's obligation below what was already allocated to it, and nothing re-allocates
// the excess (payment_allocations are append-only facts). A per-comanda projection then
// reported that excess as over-collected on one comanda and the unallocated remainder of
// another comanda as still owed -- a phantom pair (an UNPAID_BALANCE_AT_CLOSE incident next to
// an over-collection) on a table that, as a whole, is settled, exactly as the writer itself
// already sees it.
//
// This module nets the two INSIDE the table session, the settlement unit the writer already
// uses: a comanda's over-collection first covers what the other comandas of the SAME table
// session still owe. Nothing is re-allocated and no money moves -- allocations, collected
// amounts and per-method totals are untouched; only the owed / over-collected projection is
// netted. Deterministic: owed comandas are covered, and over-collections consumed, in
// command-number order (then order id). Exact per table session:
//   sum(owed')  = max(0, sum(owed) - sum(over))
//   sum(over')  = max(0, sum(over) - sum(owed))
// Real over-collection (the table as a whole collected more than it owes) stays
// over-collection; a refund that removes the excess brings the debt back. Orders without a
// table session are returned untouched.
// ===============================================================

function compareCommands(a, b) {
  const na = Number.isFinite(Number(a.commandNumber)) && a.commandNumber !== null ? Number(a.commandNumber) : Infinity;
  const nb = Number.isFinite(Number(b.commandNumber)) && b.commandNumber !== null ? Number(b.commandNumber) : Infinity;
  if (na !== nb) return na - nb;
  const ia = String(a.id || ""), ib = String(b.id || "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// entries: [{ key, tableSessionId, commandNumber, id, owedCents, overCents }] (integers, >= 0).
// Returns Map key -> { owedCents, overCents, coveredCents, appliedOverCents }.
function netTableSettlement(entries) {
  const out = new Map();
  const groups = new Map();
  for (const entry of entries || []) {
    const owed = Math.max(0, Math.round(Number(entry.owedCents) || 0));
    const over = Math.max(0, Math.round(Number(entry.overCents) || 0));
    out.set(entry.key, { owedCents: owed, overCents: over, coveredCents: 0, appliedOverCents: 0 });
    if (entry.tableSessionId === null || entry.tableSessionId === undefined || entry.tableSessionId === "") continue;
    const group = String(entry.tableSessionId);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  for (const members of groups.values()) {
    const ordered = [...members].sort(compareCommands);
    const pool = ordered.reduce((sum, e) => sum + out.get(e.key).overCents, 0);
    const need = ordered.reduce((sum, e) => sum + out.get(e.key).owedCents, 0);
    let toCover = Math.min(pool, need);
    let toConsume = toCover;
    if (toCover <= 0) continue;
    for (const e of ordered) {
      if (toCover <= 0) break;
      const row = out.get(e.key);
      const covered = Math.min(row.owedCents, toCover);
      row.owedCents -= covered;
      row.coveredCents += covered;
      toCover -= covered;
    }
    for (const e of ordered) {
      if (toConsume <= 0) break;
      const row = out.get(e.key);
      const applied = Math.min(row.overCents, toConsume);
      row.overCents -= applied;
      row.appliedOverCents += applied;
      toConsume -= applied;
    }
  }
  return out;
}

module.exports = { netTableSettlement };
