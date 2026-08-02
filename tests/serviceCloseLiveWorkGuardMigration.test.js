"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "2026-08-02_service_close_live_work_guard.sql"),
  "utf8",
);
const rollback = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "2026-08-02_service_close_live_work_guard.ROLLBACK.sql"),
  "utf8",
);

test("closed transition is guarded at the database boundary", () => {
  assert.match(migration, /BEFORE UPDATE OF status ON public\.service_sessions/);
  assert.match(migration, /NEW\.status = 'closed'/);
  assert.match(migration, /OLD\.status IS DISTINCT FROM 'closed'/);
});

test("open Mesa accounts block even a direct service close", () => {
  assert.match(migration, /FROM public\.table_sessions[\s\S]*service_session_id = OLD\.id[\s\S]*status = 'open'/);
  assert.match(migration, /MESSAGE = 'MESSA_TABLES_NOT_RELEASED'/);
});

test("live and unknown orders block while terminal historical states do not", () => {
  assert.match(migration, /FROM public\.ordenes[\s\S]*service_session_id = OLD\.id/);
  for (const state of ["RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO", "CANCELLED", "ANULADO", "CHIUSO_FORZATO"]) {
    assert.ok(migration.includes(`'${state}'`), `terminal state ${state} missing`);
  }
  assert.match(migration, /o\.estado IS NULL[\s\S]*o\.estado NOT IN/);
  assert.match(migration, /MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED'/);
});

test("function is not callable by public browser roles", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.guard_service_session_closed_v1\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.guard_service_session_closed_v1\(\) TO service_role/);
});

test("rollback removes trigger before function", () => {
  assert.ok(rollback.indexOf("DROP TRIGGER") < rollback.indexOf("DROP FUNCTION"));
  assert.match(rollback, /^BEGIN;/);
  assert.match(rollback, /COMMIT;\s*$/);
});
