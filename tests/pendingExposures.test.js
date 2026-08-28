"use strict";
// PENDENCIAS ECONÓMICAS — SLICE 1: the canonical read-only Pendencias reader.
//
// See src/economy/pendingExposures.js for the full contract and
// PENDENCIAS_ECONOMICAS_ARCHITECTURE_AUDIT_2026-08-28.md for the architecture
// decision this implements (verdict: PENDENCIAS_ECONOMICAS_ARCHITECTURE_READY).
//
// Every derivation below goes through safeTicket — this file proves the
// READER's own logic (eligibility, identity, grouping, filters, sorting),
// never re-litigates safeTicket's own arithmetic (covered exhaustively by
// currentServiceCloseout's own test suite and economicSnapshot's).
const assert = require("assert");
const {
  createPendingExposures, PendingExposuresError,
  isCancelLike, channelOf, isOperationallyOver, normalizeCustomer, buildDisplay,
  allowedActionsFor, matchesQuery, withinRange,
} = require("../src/economy/pendingExposures");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const NOW = new Date("2026-08-28T12:00:00.000Z");

// The two real delivery-type literals, defined ONCE and spread into every
// fixture row below by an English name — so the actual column/value text
// appears exactly twice in this file (here) instead of once per order.
const PICKUP = Object.freeze({ tipo_consegna: "RITIRO" }); // language-guard: allow-legacy tipo_consegna/RITIRO are the existing ordenes column/literal, defined once here, not new vocabulary
const DELIVERY = Object.freeze({ tipo_consegna: "DOMICILIO" }); // language-guard: allow-legacy tipo_consegna is the same existing ordenes column, defined once here, not new vocabulary

// ═══════════════════════════════════════════════════════════════════════
// PART 1 — PURE HELPERS (no I/O)
// ═══════════════════════════════════════════════════════════════════════

test("isCancelLike — the genuinely-void set plus force-closed, nothing else", () => {
  assert.strictEqual(isCancelLike("CANCELADO"), true);
  assert.strictEqual(isCancelLike("ANULADO"), true);
  assert.strictEqual(isCancelLike("CHIUSO_FORZATO"), true); // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal under test, not new vocabulary
  assert.strictEqual(isCancelLike("RETIRADO"), false);
  assert.strictEqual(isCancelLike("LISTO"), false);
  assert.strictEqual(isCancelLike(null), false);
});

test("channelOf — Mesa from table_session_id, never from `canal`", () => {
  assert.strictEqual(channelOf({ table_session_id: "ts-1", canal: "MANUAL" }), "MESA");
  assert.strictEqual(channelOf(PICKUP), "RETIRO");
  assert.strictEqual(channelOf(DELIVERY), "DOMICILIO");
  assert.strictEqual(channelOf({ tipo_consegna: "SOMETHING_FUTURE" }), "OTRO", "fail-closed, never guesses"); // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, not new vocabulary
});

test("isOperationallyOver — Mesa asks the table session, non-Mesa asks estado", () => {
  assert.strictEqual(isOperationallyOver({
    order: { table_session_id: "ts-1" }, tableSession: { status: "closed" },
  }), true);
  assert.strictEqual(isOperationallyOver({
    order: { table_session_id: "ts-1" }, tableSession: { status: "open" },
  }), false);
  assert.strictEqual(isOperationallyOver({
    order: { table_session_id: "ts-1" }, tableSession: null,
  }), false, "missing table session fails closed");
  assert.strictEqual(isOperationallyOver({ order: { estado: "RETIRADO" } }), true);
  assert.strictEqual(isOperationallyOver({ order: { estado: "LISTO" } }), false);
  assert.strictEqual(isOperationallyOver({ order: { estado: "made_up_state" } }), false, "unknown state fails closed");
});

test("normalizeCustomer — Mesa is always null, non-Mesa blanks normalize to null", () => {
  assert.deepStrictEqual(
    normalizeCustomer({ table_session_id: "ts-1", nombre: "Mesa 6", tel: "MESA-98794C63" }),
    { name: null, phone: null },
  );
  assert.deepStrictEqual(
    normalizeCustomer({ nombre: "  ", tel: "" }),
    { name: null, phone: null },
  );
  assert.deepStrictEqual(
    normalizeCustomer({ nombre: "Maria Lopez", tel: "+34600111222" }),
    { name: "Maria Lopez", phone: "+34600111222" },
  );
});

test("buildDisplay — orderNumber is metadata, never coerced into identity", () => {
  const d = buildDisplay({ id: "#999034", table_number_snapshot: 6, table_name_snapshot: "Mesa 6", table_command_number: 1 });
  assert.deepStrictEqual(d, { orderNumber: "#999034", tableNumber: 6, tableName: "Mesa 6", commandNumber: 1 });
});

test("allowedActionsFor — honest by construction: no collector exists yet, Mesa refund does", () => {
  assert.deepStrictEqual(allowedActionsFor("POR_COBRAR", "MESA"), []);
  assert.deepStrictEqual(allowedActionsFor("POR_COBRAR", "RETIRO"), []);
  assert.deepStrictEqual(allowedActionsFor("POR_DEVOLVER", "MESA"), ["REFUND"]);
  assert.deepStrictEqual(allowedActionsFor("POR_DEVOLVER", "RETIRO"), []);
  assert.deepStrictEqual(allowedActionsFor("POR_DEVOLVER", "DOMICILIO"), []);
});

test("withinRange / matchesQuery — half-open range, case-insensitive substring", () => {
  assert.strictEqual(withinRange("2026-08-20T10:00:00Z", null, null), true);
  assert.strictEqual(withinRange("2026-08-20T10:00:00Z", "2026-08-20T10:00:00Z", "2026-08-21T00:00:00Z"), true, "from is inclusive");
  assert.strictEqual(withinRange("2026-08-21T00:00:00Z", "2026-08-20T10:00:00Z", "2026-08-21T00:00:00Z"), false, "to is exclusive");
  assert.strictEqual(withinRange(null, "2026-08-20T10:00:00Z", null), false, "no date, no match");
  assert.strictEqual(matchesQuery({ customer: { name: "Maria Lopez" } }, "lopez"), true);
  assert.strictEqual(matchesQuery({ customer: { name: "Maria Lopez" } }, "ROSSI"), false);
  assert.strictEqual(matchesQuery({ customer: {} }, ""), true, "blank query matches everything");
});

// ═══════════════════════════════════════════════════════════════════════
// PART 2 — THE FULL READER, against a synthetic multi-scenario dataset
// ═══════════════════════════════════════════════════════════════════════

const SS1 = "ss-1";
const WORKSPACE = "ws-authenticated"; // the workspace every request in this file is scoped to
const OTHER_WORKSPACE = "ws-foreign"; // a DIFFERENT workspace, for the isolation tests only
const sessions = [{ id: SS1, business_date: "2026-08-20", status: "closed" }];

const tableSessions = [
  { id: "ts-a", workspace_id: WORKSPACE, status: "closed" },
  { id: "ts-b", workspace_id: WORKSPACE, status: "closed" },
  { id: "ts-c", workspace_id: WORKSPACE, status: "closed" },
  { id: "ts-f", workspace_id: WORKSPACE, status: "open" }, // F — still actively settling
  // W — a Mesa order (below) points at THIS table session, which belongs to
  // a DIFFERENT workspace. The reader must never read it.
  { id: "ts-w", workspace_id: OTHER_WORKSPACE, status: "closed" },
];

// One shared roster, one order per lettered scenario from the task brief
// (A–P), plus three extras this module's own design needs proven: an
// order_obligations precedence case, a legacy-archive-table row, and a true
// orphan ledger event. Every id/order_uid is unique across the roster.
const orders = [
  // A — closed Mesa, obligation 30, collected 20 -> POR_COBRAR 10. Also
  // doubles as scenario M (Mesa's synthetic customer must read as null).
  { id: "#T-A", order_uid: "uid-a", service_session_id: SS1, table_session_id: "ts-a",
    estado: "RETIRADO", totale: 30, ...PICKUP,
    nombre: "Mesa 7", tel: "MESA-000000A7", created_at: "2026-08-20T18:00:00Z",
    table_number_snapshot: 7, table_name_snapshot: "Mesa 7", table_command_number: 1 },
  // B — closed Mesa, obligation 20, collected 30 -> POR_DEVOLVER 10. Also
  // doubles as O/P (an incident exists for B; none exists for this one
  // being read as valid on its own is P).
  { id: "#T-B", order_uid: "uid-b", service_session_id: SS1, table_session_id: "ts-b",
    estado: "RETIRADO", totale: 20, ...PICKUP,
    nombre: "Mesa 8", tel: "MESA-000000B8", created_at: "2026-08-21T19:00:00Z",
    table_number_snapshot: 8, table_name_snapshot: "Mesa 8", table_command_number: 1 },
  // C — balanced Mesa: 30 obligation, 30 collected -> not a pendency at all.
  { id: "#T-C", order_uid: "uid-c", service_session_id: SS1, table_session_id: "ts-c",
    estado: "RETIRADO", totale: 30, ...PICKUP,
    nombre: "Mesa 9", tel: "MESA-000000C9", created_at: "2026-08-22T12:00:00Z" },
  // F — Mesa STILL OPEN with an unpaid balance: must never appear (the
  // normal Payment Hub's job, not Pendientes').
  { id: "#T-F", order_uid: "uid-f", service_session_id: SS1, table_session_id: "ts-f",
    estado: "RETIRADO", totale: 30, ...PICKUP,
    nombre: "Mesa 10", tel: "MESA-000000FA", created_at: "2026-08-23T12:00:00Z" },
  // G/H/I — non-Mesa, still mid-workflow, real unpaid balances, all
  // excluded: the operational phase has not ended yet.
  { id: "#T-G", order_uid: "uid-g", service_session_id: SS1, table_session_id: null,
    estado: "LISTO", totale: 20, ...DELIVERY, nombre: "", tel: "",
    created_at: "2026-08-23T13:00:00Z" },
  { id: "#T-H", order_uid: "uid-h", service_session_id: SS1, table_session_id: null,
    estado: "EN_ENTREGA", totale: 15, ...DELIVERY, nombre: "", tel: "",
    created_at: "2026-08-23T14:00:00Z" },
  { id: "#T-I", order_uid: "uid-i", service_session_id: SS1, table_session_id: null,
    estado: "POR_CONFIRMAR", totale: 12, ...PICKUP, nombre: "", tel: "",
    created_at: "2026-08-23T15:00:00Z" },
  // J — non-Mesa, terminal (RETIRADO), genuinely never collected -> a real
  // historical POR_COBRAR.
  { id: "#T-J", order_uid: "uid-j", service_session_id: SS1, table_session_id: null,
    estado: "RETIRADO", totale: 18, ...PICKUP,
    nombre: "Cliente Mostrador", tel: "600111222", created_at: "2026-08-24T10:00:00Z" },
  // K1/K2 — same real customer, two DIFFERENT order_uid, both terminal
  // (ENTREGADO — the delivery-completed literal), both with their own
  // balance: must appear as TWO separate targets, never merged.
  { id: "#T-K1", order_uid: "uid-k1", service_session_id: SS1, table_session_id: null,
    estado: "ENTREGADO", totale: 10, ...DELIVERY,
    nombre: "Marco Rossi", tel: "699888777", created_at: "2026-08-25T09:00:00Z" },
  { id: "#T-K2", order_uid: "uid-k2", service_session_id: SS1, table_session_id: null,
    estado: "ENTREGADO", totale: 16, ...DELIVERY,
    nombre: "Marco Rossi", tel: "699888777", created_at: "2026-08-25T09:30:00Z" },
  // L — terminal, real balance, but NO order_uid: must fail closed into
  // requiereRevision, never into a normal, actionable group.
  { id: "#T-L", order_uid: null, service_session_id: SS1, table_session_id: null,
    estado: "RETIRADO", totale: 25, ...PICKUP, nombre: "", tel: "",
    created_at: "2026-08-25T11:00:00Z" },
  // N — non-Mesa, terminal (COMPLETADO), a REAL customer: name/phone must
  // survive verbatim, never nulled the way Mesa's synthetic ones are.
  { id: "#T-N", order_uid: "uid-n", service_session_id: SS1, table_session_id: null,
    estado: "COMPLETADO", totale: 22, ...DELIVERY,
    nombre: "Maria Lopez", tel: "+34600111222", created_at: "2026-08-26T08:00:00Z" },
  // OBL — order_obligations must win over a stale ordenes.totale (N-2
  // precedence, inherited from safeTicket, exercised end-to-end here).
  { id: "#T-OBL", order_uid: "uid-obl", service_session_id: SS1, table_session_id: null,
    estado: "RETIRADO", totale: 40, ...PICKUP, nombre: "", tel: "",
    created_at: "2026-08-26T09:00:00Z" },
  // W — WORKSPACE ISOLATION. This Mesa order's own table_session_id ("ts-w")
  // belongs to a DIFFERENT workspace. A real unpaid balance exists, so
  // without isolation this would leak into POR_COBRAR; with isolation the
  // table_sessions lookup returns nothing for THIS workspace and it must
  // fail closed into requiereRevision instead.
  { id: "#T-W", order_uid: "uid-w", service_session_id: SS1, table_session_id: "ts-w",
    estado: "RETIRADO", totale: 40, ...PICKUP,
    nombre: "Mesa 99", tel: "MESA-000000TW", created_at: "2026-08-24T09:00:00Z" },
  // OBL-W — WORKSPACE ISOLATION for order_obligations (see the fixture's own
  // comment below). Legacy totale is 50; only the FOREIGN-workspace
  // obligation row claims 20.
  { id: "#T-OBL-W", order_uid: "uid-obl-w", service_session_id: SS1, table_session_id: null,
    estado: "RETIRADO", totale: 50, ...PICKUP, nombre: "", tel: "",
    created_at: "2026-08-24T10:00:00Z" },
  // Tie-break pair — identical originalDate, different orderUid, to prove
  // the sort is deterministic rather than accidental array order.
  { id: "#T-TIE-B", order_uid: "uid-tie-b", service_session_id: SS1, table_session_id: null,
    estado: "RETIRADO", totale: 5, ...PICKUP, nombre: "", tel: "",
    created_at: "2026-08-27T00:00:00Z" },
  { id: "#T-TIE-A", order_uid: "uid-tie-a", service_session_id: SS1, table_session_id: null,
    estado: "RETIRADO", totale: 3, ...PICKUP, nombre: "", tel: "",
    created_at: "2026-08-27T00:00:00Z" },
];

const events = [
  { order_id: "#T-A", service_session_id: SS1, type: "payment", amount: 20, payment_method: "efectivo", created_at: "2026-08-20T18:05:00Z" },
  { order_id: "#T-B", service_session_id: SS1, type: "payment", amount: 30, payment_method: "efectivo", created_at: "2026-08-21T19:05:00Z" },
  { order_id: "#T-C", service_session_id: SS1, type: "payment", amount: 30, payment_method: "tarjeta", created_at: "2026-08-22T12:05:00Z" },
  { order_id: "#T-F", service_session_id: SS1, type: "payment", amount: 20, payment_method: "efectivo", created_at: "2026-08-23T12:05:00Z" },
  { order_id: "#T-K2", service_session_id: SS1, type: "payment", amount: 10, payment_method: "tarjeta", created_at: "2026-08-25T09:35:00Z" },
  { order_id: "#T-N", service_session_id: SS1, type: "payment", amount: 10, payment_method: "bizum", created_at: "2026-08-26T08:10:00Z" },
  { order_id: "#T-OBL", service_session_id: SS1, type: "payment", amount: 20, payment_method: "efectivo", created_at: "2026-08-26T09:10:00Z" },
  { order_id: "#T-OBL-W", service_session_id: SS1, type: "payment", amount: 20, payment_method: "efectivo", created_at: "2026-08-24T10:10:00Z" },
  // A wrong-amount incident for B, to prove the incident is never consulted.
];

const obligations = [
  { order_id: "#T-OBL", order_uid: "uid-obl", workspace_id: WORKSPACE, service_session_id: SS1, revision: 1, gross_amount: 40 },
  { order_id: "#T-OBL", order_uid: "uid-obl", workspace_id: WORKSPACE, service_session_id: SS1, revision: 2, gross_amount: 25 },
  // WORKSPACE ISOLATION — a foreign-workspace obligation for a DIFFERENT
  // order. If this ever leaked in, currentObligation would drop from the
  // legacy totale (50) to 20, netCollected would already equal it, and a
  // real 30 EUR exposure would silently vanish rather than merely read
  // wrong — the more dangerous failure mode, and the one this proves against.
  { order_id: "#T-OBL-W", order_uid: "uid-obl-w", workspace_id: OTHER_WORKSPACE, service_session_id: SS1, revision: 1, gross_amount: 20 },
];

// The legacy nightly archive table: no order_uid column at all, by schema.
const legacyArchive = [
  { orden_id: "#T-ARCHIVE", service_session_id: SS1, estado: "RETIRADO", totale: 14, created_at: "2026-08-15T10:00:00Z" },
];

// A true orphan: matches NO order in either live table.
const orphanEvent = { order_id: "#T-ORPHAN", service_session_id: "ss-vanished", type: "payment", amount: 7.5, created_at: "2026-08-14T09:00:00Z" };

const calls = [];
const select = createMemorySelect(
  {
    ordenes: orders,
    storico: legacyArchive, // language-guard: allow-legacy storico is the real PostgREST table name this key must match verbatim, not new vocabulary
    order_financial_events: [...events, orphanEvent],
    order_obligations: obligations,
    service_sessions: sessions,
    table_sessions: tableSessions,
  },
  { onCall: (c) => calls.push(c) },
);
const rawGetPendingExposures = createPendingExposures({ select });
// Every call in this file is scoped to the SAME authenticated workspace,
// exactly as the HTTP layer would supply it from the verified auth context —
// never from caller-supplied params.
const getPendingExposures = (params = {}) => rawGetPendingExposures({ workspaceId: WORKSPACE, now: NOW, ...params });

let result; // populated once, reused by every read-only assertion below

(async () => {
  result = await getPendingExposures();
  await atest("setup — the reader runs end to end against the full roster", async () => {
    assert.strictEqual(result.ok, true);
  });

  const byUid = (uid) => [...result.porCobrar, ...result.porDevolver].find((i) => i.orderUid === uid);

  await atest("A · closed Mesa, obligation 30, collected 20 -> POR_COBRAR 10", async () => {
    const item = byUid("uid-a");
    assert.ok(item, "must be present");
    assert.strictEqual(item.direction, "POR_COBRAR");
    assert.strictEqual(item.amount, 10);
    assert.strictEqual(item.currentObligation, 30);
    assert.strictEqual(item.netCollected, 20);
    assert.strictEqual(item.channel, "MESA");
    assert.strictEqual(item.identityConfidence, "STABLE");
    assert.deepStrictEqual(item.allowedActions, [], "no collector exists yet");
  });

  await atest("B · closed Mesa, obligation 20, collected 30 -> POR_DEVOLVER 10", async () => {
    const item = byUid("uid-b");
    assert.ok(item);
    assert.strictEqual(item.direction, "POR_DEVOLVER");
    assert.strictEqual(item.amount, 10);
    assert.deepStrictEqual(item.allowedActions, ["REFUND"], "Mesa refund path genuinely exists");
  });

  await atest("C · balanced 30/30 -> not a pendency at all", async () => {
    assert.strictEqual(byUid("uid-c"), undefined);
  });

  await atest("F · Mesa still OPEN with an unpaid balance -> excluded (normal UI's job)", async () => {
    assert.strictEqual(byUid("uid-f"), undefined);
  });

  await atest("G/H/I · LISTO / EN_ENTREGA / POR_CONFIRMAR -> none are pendencies", async () => {
    assert.strictEqual(byUid("uid-g"), undefined);
    assert.strictEqual(byUid("uid-h"), undefined);
    assert.strictEqual(byUid("uid-i"), undefined);
  });

  await atest("J · terminal non-Mesa order, never collected -> a real POR_COBRAR", async () => {
    const item = byUid("uid-j");
    assert.ok(item);
    assert.strictEqual(item.direction, "POR_COBRAR");
    assert.strictEqual(item.amount, 18);
    assert.strictEqual(item.channel, "RETIRO");
  });

  await atest("K · same real customer, two order_uid -> two independent targets", async () => {
    const k1 = byUid("uid-k1");
    const k2 = byUid("uid-k2");
    assert.ok(k1 && k2, "both must be present");
    assert.notStrictEqual(k1.orderUid, k2.orderUid);
    assert.strictEqual(k1.amount, 10);
    assert.strictEqual(k2.amount, 6, "16 obligation - 10 collected");
    assert.strictEqual(k1.customer.phone, "699888777");
    assert.strictEqual(k2.customer.phone, "699888777");
  });

  await atest("L · missing order_uid -> REQUIERE_REVISION, never an actionable group", async () => {
    assert.strictEqual(byUid(null), undefined, "not addressable by uid at all");
    const rev = result.requiereRevision.find((r) => r.orderDisplay === "#T-L");
    assert.ok(rev, "must surface, not disappear");
    assert.strictEqual(rev.reasonCode, "MISSING_STABLE_IDENTITY");
    assert.strictEqual(rev.amount, 25);
    assert.strictEqual(rev.direction, "POR_COBRAR");
  });

  await atest("M · Mesa's synthetic nombre/tel never read as a real customer", async () => {
    const item = byUid("uid-a");
    assert.deepStrictEqual(item.customer, { name: null, phone: null });
  });

  await atest("N · non-Mesa real customer survives verbatim", async () => {
    const item = byUid("uid-n");
    assert.ok(item);
    assert.strictEqual(item.customer.name, "Maria Lopez");
    assert.strictEqual(item.customer.phone, "+34600111222");
    assert.strictEqual(item.amount, 12, "22 obligation - 10 collected");
  });

  await atest("O · an incident existing for this target never changes the derived amount", async () => {
    // No service_incidents row was even loaded into the fixture tables — the
    // amount for B is (and must stay) the pure ledger balance.
    const item = byUid("uid-b");
    assert.strictEqual(item.amount, 10);
    assert.ok(!calls.some((c) => c.table === "service_incidents"),
      "the reader must never query service_incidents at all");
  });

  await atest("P · a valid POR_DEVOLVER with no incident at all is still derivable", async () => {
    assert.ok(byUid("uid-b"), "already proven present above; restated for the letter");
  });

  await atest("OBL · order_obligations wins over a stale ordenes.totale (N-2)", async () => {
    const item = byUid("uid-obl");
    assert.ok(item);
    assert.strictEqual(item.currentObligation, 25, "revision 2's gross, not totale=40");
    assert.strictEqual(item.amount, 5, "25 - 20 collected");
  });

  await atest("Legacy archive table — no order_uid column -> REQUIERE_REVISION, never actionable", async () => {
    const rev = result.requiereRevision.find((r) => r.orderDisplay === "#T-ARCHIVE");
    assert.ok(rev, "real historical money must not silently disappear");
    assert.strictEqual(rev.reasonCode, "LEGACY_ARCHIVE_NO_STABLE_IDENTITY");
    assert.strictEqual(rev.amount, 14);
    assert.strictEqual(rev.direction, "POR_COBRAR");
  });

  await atest("True orphan ledger event — matches no order anywhere -> REQUIERE_REVISION", async () => {
    const rev = result.requiereRevision.find((r) => r.orderDisplay === "#T-ORPHAN");
    assert.ok(rev, "real ledger money must not silently disappear");
    assert.strictEqual(rev.reasonCode, "ORPHANED_LEDGER_EVENT");
    assert.strictEqual(rev.amount, 7.5);
    assert.strictEqual(rev.direction, null, "no known obligation — never guess a direction");
  });

  // ── Q — FILTERS ──────────────────────────────────────────────────────
  await atest("Q1 · direction filter isolates one group", async () => {
    const cobrarOnly = await getPendingExposures({ direction: "POR_COBRAR", now: NOW });
    assert.ok(cobrarOnly.porCobrar.length > 0);
    assert.strictEqual(cobrarOnly.porDevolver.length, 0);
    const devolverOnly = await getPendingExposures({ direction: "POR_DEVOLVER", now: NOW });
    assert.ok(devolverOnly.porDevolver.length > 0);
    assert.strictEqual(devolverOnly.porCobrar.length, 0);
  });

  await atest("Q2 · date range is half-open on originalDate", async () => {
    const scoped = await getPendingExposures({ from: "2026-08-24T00:00:00Z", to: "2026-08-25T00:00:00Z", now: NOW });
    assert.ok(scoped.porCobrar.some((i) => i.orderUid === "uid-j"), "J's originalDate falls inside");
    assert.ok(!scoped.porCobrar.some((i) => i.orderUid === "uid-a"), "A's originalDate falls before the range");
  });

  await atest("Q3 · free-text search matches customer, table and display metadata", async () => {
    const byName = await getPendingExposures({ q: "lopez", now: NOW });
    assert.ok(byName.porCobrar.some((i) => i.orderUid === "uid-n"));
    const byTable = await getPendingExposures({ q: "mesa 7", now: NOW });
    assert.ok(byTable.porCobrar.some((i) => i.orderUid === "uid-a"));
    const noMatch = await getPendingExposures({ q: "no-such-customer-anywhere", now: NOW });
    assert.strictEqual(noMatch.porCobrar.length + noMatch.porDevolver.length, 0);
  });

  await atest("Q4 · an invalid direction/range refuses rather than silently widening", async () => {
    await assert.rejects(() => getPendingExposures({ direction: "SIDEWAYS", now: NOW }),
      (e) => e instanceof PendingExposuresError && e.code === "ECONOMY_PENDENCIES_DIRECTION_INVALID");
    await assert.rejects(() => getPendingExposures({ from: "2026-08-25T00:00:00Z", to: "2026-08-20T00:00:00Z", now: NOW }),
      (e) => e.code === "ECONOMY_PENDENCIES_RANGE_NOT_ORDERED");
  });

  // ── R — DETERMINISTIC SORT ───────────────────────────────────────────
  await atest("R1 · oldest unresolved exposure first, across the whole group", async () => {
    const dates = result.porCobrar.map((i) => new Date(i.originalDate).getTime());
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] <= dates[i], "must be non-decreasing");
  });

  await atest("R2 · identical originalDate ties break on orderUid, deterministically", async () => {
    const a = result.porCobrar.findIndex((i) => i.orderUid === "uid-tie-a");
    const b = result.porCobrar.findIndex((i) => i.orderUid === "uid-tie-b");
    assert.ok(a >= 0 && b >= 0);
    assert.ok(a < b, "uid-tie-a sorts before uid-tie-b lexicographically");
    // And it is stable across repeated calls against the same data.
    const again = await getPendingExposures({ now: NOW });
    assert.strictEqual(
      again.porCobrar.findIndex((i) => i.orderUid === "uid-tie-a") < again.porCobrar.findIndex((i) => i.orderUid === "uid-tie-b"),
      true,
    );
  });

  // ── WORKSPACE ISOLATION ───────────────────────────────────────────────
  await atest("W1 · a Mesa order whose table_session belongs to ANOTHER workspace never leaks in", async () => {
    assert.strictEqual(byUid("uid-w"), undefined,
      "must not appear in porCobrar/porDevolver even though a real 40 EUR balance exists");
    const rev = result.requiereRevision.find((r) => r.orderDisplay === "#T-W");
    assert.ok(rev, "the exposure must still surface — reviewably, not silently");
    assert.strictEqual(rev.reasonCode, "MISSING_TABLE_SESSION");
    assert.strictEqual(rev.amount, 40);
  });

  await atest("W2 · an order_obligations row from ANOTHER workspace is never read, even when it would hide real money", async () => {
    const item = byUid("uid-obl-w");
    assert.ok(item, "the real 30 EUR exposure must still be found");
    assert.strictEqual(item.currentObligation, 50, "the legacy totale — the foreign-workspace revision (20) must be invisible");
    assert.strictEqual(item.amount, 30, "50 - 20 collected; NOT 0, which is what a leak would have produced");
  });

  await atest("W3 · a request with no workspaceId is refused outright, exactly like cashCountService's own guard", async () => {
    await assert.rejects(() => rawGetPendingExposures({ now: NOW }),
      (e) => e instanceof PendingExposuresError && e.code === "ECONOMY_UNAUTHENTICATED" && e.status === 401);
    await assert.rejects(() => rawGetPendingExposures({ workspaceId: "", now: NOW }),
      (e) => e.code === "ECONOMY_UNAUTHENTICATED");
    await assert.rejects(() => rawGetPendingExposures({ workspaceId: 42, now: NOW }),
      (e) => e.code === "ECONOMY_UNAUTHENTICATED", "a non-string workspaceId must refuse, never coerce");
  });

  await atest("W4 · every table_sessions / order_obligations query this run made was scoped to the caller's own workspace", async () => {
    const scopedCalls = calls.filter((c) => c.table === "table_sessions" || c.table === "order_obligations");
    assert.ok(scopedCalls.length > 0, "sanity: these tables were queried at all");
    for (const c of scopedCalls) {
      assert.ok(c.query.includes(`workspace_id=eq.${WORKSPACE}`),
        `${c.table} query must be workspace-scoped, got: ${c.query}`);
    }
  });

  // ── S — AUTH READ GATE (HTTP layer) ──────────────────────────────────
  await atest("S · /pendencies is registered behind the SAME read-role gate as /snapshot", async () => {
    const { registerEconomyRoutes, READ_ROLES } = require("../src/economy/economyHttpHandlers");
    const registered = [];
    const fakeRouter = {
      get: (path, ...mw) => registered.push({ method: "get", path, mw }),
      post: (path, ...mw) => registered.push({ method: "post", path, mw }),
    };
    registerEconomyRoutes(fakeRouter, { pendencies: async () => ({ ok: true, porCobrar: [], porDevolver: [], requiereRevision: [] }) });
    const route = registered.find((r) => r.path === "/pendencies");
    assert.ok(route, "/pendencies must be registered");
    assert.strictEqual(route.mw.length, 3, "auth, role gate, handler");
    // Exercise the role gate directly: a role outside READ_ROLES must 403.
    const roleGate = route.mw[1];
    let forbidden = null;
    roleGate({ economyContext: { role: "waiter" } }, { status: (s) => ({ json: (b) => { forbidden = { status: s, body: b }; } }) }, () => { throw new Error("must not call next()"); });
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.code, "ECONOMY_READ_FORBIDDEN");
    // And a role inside READ_ROLES must pass through to next().
    let calledNext = false;
    roleGate({ economyContext: { role: [...READ_ROLES][0] } }, { status: () => ({ json: () => {} }) }, () => { calledNext = true; });
    assert.strictEqual(calledNext, true);
  });

  // ── T — ZERO WRITE BEHAVIOR ───────────────────────────────────────────
  await atest("T · every call this whole run made was a plain read, on an expected table", async () => {
    const allowed = new Set(["ordenes", "storico", "order_financial_events", "order_obligations", "service_sessions", "table_sessions"]); // language-guard: allow-legacy storico is the real table name this allowlist checks against, not new vocabulary
    assert.ok(calls.length > 0, "sanity: the reader did call select");
    for (const c of calls) assert.ok(allowed.has(c.table), `unexpected table touched: ${c.table}`);
  });

  // ── PRE-DEPLOY REVIEW §2 — QUERY SHAPE, PINNED ────────────────────────
  await atest("scale · a SINGLE call makes exactly ONE unbounded order_financial_events read (the orphan scan); the rest are id-scoped and index-supported", async () => {
    // Isolated select/calls, so batching from the many getPendingExposures()
    // invocations earlier in this file cannot inflate the count below.
    const freshCalls = [];
    const freshSelect = createMemorySelect(
      { ordenes: orders, storico: legacyArchive, order_financial_events: [...events, orphanEvent], order_obligations: obligations, service_sessions: sessions, table_sessions: tableSessions }, // language-guard: allow-legacy storico is the real PostgREST table name this key must match verbatim, not new vocabulary
      { onCall: (c) => freshCalls.push(c) },
    );
    await createPendingExposures({ select: freshSelect })({ workspaceId: WORKSPACE, now: NOW });
    const eventCalls = freshCalls.filter((c) => c.table === "order_financial_events");
    const unbounded = eventCalls.filter((c) => !c.query.includes("order_id=in."));
    const bounded = eventCalls.filter((c) => c.query.includes("order_id=in."));
    assert.strictEqual(unbounded.length, 1,
      "exactly one order_financial_events read may be unfiltered by order_id — the orphan scan, and no other");
    assert.ok(bounded.length > 0, "the primary population must be fetched id-scoped, using the live order_financial_events_order_created_idx");
    // The orphan scan must not request a sort either — see its own header
    // for why: no consumer of it needs chronological order, and requesting
    // one would force Postgres to materialize and sort the whole table for
    // no reason this reader can use.
    assert.ok(!unbounded[0].query.includes("order="), "the orphan scan must not request a sort");
  });

  console.log(`pendingExposures: ${passed} passed`);
})();
