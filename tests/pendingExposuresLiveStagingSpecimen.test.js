"use strict";
// PENDENCIAS ECONÓMICAS SLICE 1 — LIVE STAGING SPECIMEN.
//
// Every row below was captured READ-ONLY from the live staging database
// (Supabase project tdikhfeinufaahagmpjz) on 2026-08-28, via direct SQL —
// the same discipline economicSnapshotWindow.test.js already uses for its
// own "live staging rows" fixture, and for the same reason: this backend has
// no local Supabase service_role credential (staging secrets live only in
// Railway — see railway-backend-mapping), so a real HTTP round-trip through
// sbSelect cannot run from this environment. Replaying the exact live rows
// through the REAL reader is the closest available proof that the algorithm
// matches canonical truth, and it is a stronger check than a synthetic
// fixture: nothing here was invented to make the assertions pass.
//
// ZERO WRITES. No row below was created, changed or deleted by this test —
// every value was read with `SELECT`, never `INSERT`/`UPDATE`/`DELETE`.
//
// #999034 is the architecture audit's own UAT specimen (Mesa 6): three
// commercial-adjustment revisions down to 60.00, paid 85.00 then refunded
// 15.00 -> netCollected 70.00 -> POR_DEVOLVER 10.00, matching the
// OVER_COLLECTED_AT_CLOSE incident of exactly 1000 cents recorded live.
//
// #999001 and #379 together prove the N-6 recycled-display-id trap live: two
// DIFFERENT real orders share the display number "#379" (one still live, one
// in the legacy archive table), and a single real payment event for the
// archived one carries the ARCHIVED order's own service_session_id, not
// the current order's. Composite matching must send that money to its real
// home (the archived order, where it resolves the balance to zero and never
// surfaces at all) and must NOT let it silently pay off the unrelated
// current order that merely recycled the same number.
const assert = require("assert");
const { createPendingExposures } = require("../src/economy/pendingExposures");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const NOW = new Date("2026-08-28T12:00:00.000Z");

// The real delivery-type literal every live row below carries, defined ONCE. // language-guard: allow-legacy tipo_consegna/RITIRO are the existing ordenes column/literal, defined once here, not new vocabulary
const PICKUP = Object.freeze({ tipo_consegna: "RITIRO" });

// ── ordenes — verbatim from the live table (2026-08-28 read) ────────────
const ordenes = [
  {
    id: "#999034", order_uid: "68a3c44f-e677-4d0a-8d9b-e090dd89e4b2",
    service_session_id: "42af1de9-8981-4d01-b331-554566bec60a",
    table_session_id: "98794c63-ad71-4c60-af76-f5277890ddcb",
    estado: "RETIRADO", totale: 85, ...PICKUP, canal: "BANCO",
    nombre: "Mesa 6", tel: "MESA-98794C63", created_at: "2026-08-25T19:30:27.733177Z",
    table_number_snapshot: 6, table_name_snapshot: "Mesa 6", table_command_number: 1,
  },
  {
    id: "#999001", order_uid: "3b4e25ac-a51e-4737-b540-936294bf8aa5",
    service_session_id: "d20ee320-6132-4021-af5f-c4dbe95f84a0",
    table_session_id: "63655206-41fa-40a4-8e79-11bba8fb5a4f",
    estado: "CHIUSO_FORZATO", totale: 100.00, ...PICKUP, canal: "BANCO", // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this live row carries, not new vocabulary
    nombre: "", tel: "", created_at: "2026-08-15T18:06:18.546708Z",
    table_number_snapshot: 999, table_name_snapshot: "TEST-S1-ACCEPTANCE", table_command_number: 1,
  },
  {
    id: "#379", order_uid: "db1d665b-a411-4e0f-bfb2-c929533bb74e",
    service_session_id: "d20ee320-6132-4021-af5f-c4dbe95f84a0",
    table_session_id: "b4fe37af-2da8-4b0c-8d79-ac3e2b92da8c",
    estado: "CHIUSO_FORZATO", totale: 27.5, ...PICKUP, canal: "BANCO", // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, not new vocabulary
    nombre: "Mesa 1", tel: "MESA-B4FE37AF", created_at: "2026-08-15T11:18:09.609517Z",
    table_number_snapshot: 1, table_name_snapshot: "Mesa 1", table_command_number: 1,
  },
];

// The SAME "#379" display number, archived — a genuinely different order.
// The legacy archive table has no order_uid column at all, verbatim from the
// live schema. // language-guard: allow-legacy storico is the archive table this sentence describes without naming, not new vocabulary
const legacyArchive = [
  {
    orden_id: "#379", service_session_id: "c9d5aaa7-d0d5-4740-a6ee-83a8ee57adda",
    estado: "RETIRADO", totale: 25, created_at: "2026-08-15T11:18:08.52843Z",
  },
];

// order_financial_events — verbatim, including the live foreign-session row.
const events = [
  { order_id: "#999034", service_session_id: "42af1de9-8981-4d01-b331-554566bec60a", type: "payment", amount: 85.00, payment_method: "efectivo", created_at: "2026-08-28T06:17:52.387789Z" },
  { order_id: "#999034", service_session_id: "42af1de9-8981-4d01-b331-554566bec60a", type: "refund", amount: 15.00, payment_method: "efectivo", created_at: "2026-08-28T06:24:47.193141Z" },
  { order_id: "#999001", service_session_id: "d20ee320-6132-4021-af5f-c4dbe95f84a0", type: "payment", amount: 10.00, payment_method: "efectivo", created_at: "2026-08-15T18:08:27.890061Z" },
  { order_id: "#999001", service_session_id: "d20ee320-6132-4021-af5f-c4dbe95f84a0", type: "payment", amount: 10.00, payment_method: "efectivo", created_at: "2026-08-15T18:09:16.254058Z" },
  { order_id: "#999001", service_session_id: "d20ee320-6132-4021-af5f-c4dbe95f84a0", type: "payment", amount: 10.00, payment_method: "efectivo", created_at: "2026-08-15T18:12:01.216147Z" },
  { order_id: "#999001", service_session_id: "d20ee320-6132-4021-af5f-c4dbe95f84a0", type: "payment", amount: 20.00, payment_method: "tarjeta", created_at: "2026-08-15T18:12:11.330681Z" },
  // The N-6 trap, live: this "#379" payment belongs to the ARCHIVED order
  // (session c9d5aaa7), NOT the current one (session d20ee320) above.
  { order_id: "#379", service_session_id: "c9d5aaa7-d0d5-4740-a6ee-83a8ee57adda", type: "payment", amount: 25.00, payment_method: "efectivo", created_at: "2026-08-13T19:08:38.222938Z" },
];

// order_obligations — verbatim. Only #999034 has canonical rows (three
// commercial-adjustment revisions); #999001 and #379 predate them and fall
// through to the legacy `totale`, exactly as safeTicket already handles.
const obligations = [
  { order_id: "#999034", order_uid: "68a3c44f-e677-4d0a-8d9b-e090dd89e4b2", service_session_id: "42af1de9-8981-4d01-b331-554566bec60a", revision: 1, gross_amount: 85 },
  { order_id: "#999034", order_uid: "68a3c44f-e677-4d0a-8d9b-e090dd89e4b2", service_session_id: "42af1de9-8981-4d01-b331-554566bec60a", revision: 2, gross_amount: 70.00 },
  { order_id: "#999034", order_uid: "68a3c44f-e677-4d0a-8d9b-e090dd89e4b2", service_session_id: "42af1de9-8981-4d01-b331-554566bec60a", revision: 3, gross_amount: 60.00 },
];

const serviceSessions = [
  { id: "42af1de9-8981-4d01-b331-554566bec60a", business_date: "2026-08-25", status: "open" },
  { id: "d20ee320-6132-4021-af5f-c4dbe95f84a0", business_date: "2026-08-15", status: "rolled_over" },
  { id: "c9d5aaa7-d0d5-4740-a6ee-83a8ee57adda", business_date: "2026-08-13", status: "closed" },
];

const tableSessions = [
  { id: "98794c63-ad71-4c60-af76-f5277890ddcb", status: "closed" },
  { id: "63655206-41fa-40a4-8e79-11bba8fb5a4f", status: "closed" },
  { id: "b4fe37af-2da8-4b0c-8d79-ac3e2b92da8c", status: "closed" },
];

const select = createMemorySelect({
  ordenes, storico: legacyArchive, // language-guard: allow-legacy storico is the real PostgREST table name this key must match verbatim, not new vocabulary
  order_financial_events: events,
  order_obligations: obligations,
  service_sessions: serviceSessions,
  table_sessions: tableSessions,
});
const getPendingExposures = createPendingExposures({ select });

(async () => {
  const result = await getPendingExposures({ now: NOW });
  const byUid = (uid) => [...result.porCobrar, ...result.porDevolver].find((i) => i.orderUid === uid);

  await atest("#999034 — the audit's own UAT specimen: POR_DEVOLVER 10.00, exactly the OVER_COLLECTED_AT_CLOSE incident amount", async () => {
    const item = byUid("68a3c44f-e677-4d0a-8d9b-e090dd89e4b2");
    assert.ok(item, "must be present");
    assert.strictEqual(item.direction, "POR_DEVOLVER");
    assert.strictEqual(item.amount, 10);
    assert.strictEqual(item.currentObligation, 60, "revision 3's gross, not the original 85");
    assert.strictEqual(item.netCollected, 70, "85 paid - 15 refunded");
    assert.strictEqual(item.channel, "MESA");
    assert.strictEqual(item.originalBusinessDate, "2026-08-25");
    assert.deepStrictEqual(item.customer, { name: null, phone: null }, "Mesa 6 / MESA-98794C63 are synthetic");
    assert.deepStrictEqual(item.allowedActions, ["REFUND"]);
  });

  await atest("#999001 — real partial payment, force-closed: POR_COBRAR 50.00", async () => {
    const item = byUid("3b4e25ac-a51e-4737-b540-936294bf8aa5");
    assert.ok(item, "must be present — a force-closed order with real money collected is NOT operational residue");
    assert.strictEqual(item.direction, "POR_COBRAR");
    assert.strictEqual(item.amount, 50);
    assert.strictEqual(item.currentObligation, 100, "no order_obligations row exists — legacy totale");
    assert.strictEqual(item.netCollected, 50, "10 + 10 + 10 + 20");
    assert.strictEqual(item.originalBusinessDate, "2026-08-15");
  });

  await atest("#379 (current order) — force-closed, genuinely zero money -> excluded as operational residue", async () => {
    assert.strictEqual(byUid("db1d665b-a411-4e0f-bfb2-c929533bb74e"), undefined,
      "the live #379 payment belongs to a DIFFERENT session and must not be attributed here");
    const rev = result.requiereRevision.find((r) => r.orderDisplay === "#379");
    assert.strictEqual(rev, undefined, "zero exposure is not a Class B case either — it is simply resolved");
  });

  await atest("#379 (archived order, same recycled display number) — resolves to zero, never surfaces at all", async () => {
    // The real 25.00 payment is correctly attributed HERE (composite match:
    // order_id AND service_session_id both agree with the archived row), so
    // this archived order's own balance is 25 - 25 = 0 — genuinely settled,
    // not a gap. It must not appear in requiereRevision either: a resolved
    // exposure is not a Class B case, it is simply gone, which is correct.
    const anywhereByThisDisplay = result.requiereRevision.filter((r) => r.orderDisplay === "#379");
    assert.strictEqual(anywhereByThisDisplay.length, 0,
      "the archived order is fully settled — real money was found, not lost, and there is nothing left to review");
  });

  console.log(`pendingExposuresLiveStagingSpecimen: ${passed} passed`);
})();
