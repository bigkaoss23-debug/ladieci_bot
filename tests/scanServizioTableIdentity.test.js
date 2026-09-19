"use strict";
// ===============================================================
// PREVIOUS_SERVICE_OPEN_TABLE_RECOVERY — 2026-09-18
//
// ROOT CAUSE (see PREVIOUS_SERVICE_OPEN_TABLE_RECOVERY_FIX_2026-09-18.md):
// the pre-close scan under test already reads every open table_sessions row
// (canonical identity: id / table_id) to build the "table" blocker in
// `attivi`, but used to drop that identity before returning it — the
// frontend could see a table was blocking Finalizar but had no id to route
// to. This proves the identity now survives, additively (every field the
// K4 suite already asserts on is unchanged).
// ===============================================================

const test = require("node:test");
const assert = require("node:assert/strict");

// language-guard: allow-legacy scanServizio is the module's existing export name under test; aliased so the rest of this file uses Spanish, not new vocabulary
const scanPreClose = require("../src/utils/servizio").scanServizio;

const CURRENT = { id: "svc-current", opened_at: "2026-09-17T09:55:00.000Z" };
// ACTIVE RIDER TRIP guard — this file is about table identity; keep the scan hermetic (no live trip read).
const NO_TRIP = async () => ({ ok: true, active: false });

function scanSelect({ tableSessions = [] } = {}) {
  return async (table, query = "") => {
    if (table === "table_sessions" && /status=eq\.open/.test(query)) return tableSessions;
    return []; // ordenes / conv / wa_msgs — not under test here
  };
}

test("PREVIOUS_SERVICE_OPEN_TABLE_RECOVERY · an open table's attivi row carries its own tableSessionId/tableId", async () => {
  const tableSessions = [
    { id: "ts-mesa-3", table_id: "table-3", table_ref: "Mesa 3" },
  ];
  const out = await scanPreClose({ select: scanSelect({ tableSessions }), resolveCurrentService: async () => CURRENT, activeRiderTrip: NO_TRIP });
  const tableRows = out.attivi.filter((a) => a.kind === "table");
  assert.equal(tableRows.length, 1);
  assert.equal(tableRows[0].tableSessionId, "ts-mesa-3");
  assert.equal(tableRows[0].tableId, "table-3");
  assert.equal(tableRows[0].nombre, "Mesa 3");
  assert.equal(tableRows[0].stato, "CUENTA_ABIERTA");
});

test("PREVIOUS_SERVICE_OPEN_TABLE_RECOVERY · a row with no table_id still carries its session id (tableId falls back to null, never guessed)", async () => {
  const tableSessions = [{ id: "ts-legacy", table_ref: "Mesa 7" }];
  const out = await scanPreClose({ select: scanSelect({ tableSessions }), resolveCurrentService: async () => CURRENT, activeRiderTrip: NO_TRIP });
  const [row] = out.attivi.filter((a) => a.kind === "table");
  assert.equal(row.tableSessionId, "ts-legacy");
  assert.equal(row.tableId, null);
});

test("PREVIOUS_SERVICE_OPEN_TABLE_RECOVERY · two distinct open tables stay two distinct rows, each with its own identity", async () => {
  const tableSessions = [
    { id: "ts-mesa-3", table_id: "table-3", table_ref: "Mesa 3" },
    { id: "ts-mesa-5", table_id: "table-5", table_ref: "Mesa 5" },
  ];
  const out = await scanPreClose({ select: scanSelect({ tableSessions }), resolveCurrentService: async () => CURRENT, activeRiderTrip: NO_TRIP });
  const tableRows = out.attivi.filter((a) => a.kind === "table");
  assert.equal(tableRows.length, 2);
  assert.equal(out.blocking.tables, 2);
  const ids = tableRows.map((r) => r.tableSessionId).sort();
  assert.deepEqual(ids, ["ts-mesa-3", "ts-mesa-5"]);
  // MULTI_TABLE_RECOVERY negative control — the two rows must never collapse
  // or share an identity, or resolving one would silently "resolve" both.
  assert.notEqual(tableRows[0].tableSessionId, tableRows[1].tableSessionId);
});

test("PREVIOUS_SERVICE_OPEN_TABLE_RECOVERY · no open tables -> no table rows, blocking.tables stays 0 (unchanged baseline)", async () => {
  const out = await scanPreClose({ select: scanSelect({ tableSessions: [] }), resolveCurrentService: async () => CURRENT, activeRiderTrip: NO_TRIP });
  assert.equal(out.attivi.filter((a) => a.kind === "table").length, 0);
  assert.equal(out.blocking.tables, 0);
});
