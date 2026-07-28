"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");

const sql = fs.readFileSync(path.join(
  __dirname, "../migrations/2026-07-28_service_order_number.sql"
), "utf8");
const rollback = fs.readFileSync(path.join(
  __dirname, "../migrations/2026-07-28_service_order_number.ROLLBACK.sql"
), "utf8");

test("adds session-scoped positive immutable order numbering", () => {
  assert.match(sql, /ADD COLUMN next_order_number integer NOT NULL DEFAULT 1/);
  assert.match(sql, /ADD COLUMN service_order_number integer/);
  assert.match(sql, /UNIQUE INDEX ordenes_service_order_number_uq[\s\S]*service_session_id, service_order_number/);
  assert.match(sql, /SERVICE_ORDER_NUMBER_FORGERY/);
  assert.match(sql, /SERVICE_ORDER_NUMBER_IMMUTABLE/);
});

test("allocation locks session and increments in the insert transaction", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION public.service_session_assign_order"),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.service_session_immutable_order"));
  assert.match(fn, /service_session_state[\s\S]*FOR UPDATE/);
  assert.match(fn, /service_sessions[\s\S]*FOR UPDATE/);
  assert.match(fn, /NEW\.service_order_number := v_session\.next_order_number/);
  assert.match(fn, /next_order_number = next_order_number \+ 1/);
  assert.doesNotMatch(fn, /max\s*\(/i);
});

test("trigger and ensure fail closed on stale operational date", () => {
  assert.ok((sql.match(/STALE_SERVICE_SESSION/g) || []).length >= 2);
  assert.ok((sql.match(/Europe\/Madrid/g) || []).length >= 2);
  assert.ok((sql.match(/TIME '04:00'/g) || []).length >= 2);
  const ensure = sql.slice(sql.indexOf("FUNCTION public.ensure_service_session"));
  assert.match(ensure, /business_date IS DISTINCT FROM v_business_date/);
  assert.match(ensure, /expectedBusinessDate/);
});

test("migration is staging guarded, transactional, privilege locked and has rollback", () => {
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /staging sentinel absent/);
  assert.match(sql, /REVOKE ALL[\s\S]*PUBLIC, anon, authenticated/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(rollback, /^BEGIN;/);
  assert.match(rollback, /DROP COLUMN IF EXISTS service_order_number/);
  assert.match(rollback, /DROP COLUMN IF EXISTS next_order_number/);
  assert.match(rollback, /COMMIT;\s*$/);
});
