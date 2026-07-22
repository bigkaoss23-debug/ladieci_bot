"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),test=require("node:test");
const sql=fs.readFileSync(path.join(__dirname,"../migrations/2026-07-22_service_session_identity.sql"),"utf8");
const rb=fs.readFileSync(path.join(__dirname,"../migrations/2026-07-22_service_session_identity.ROLLBACK.sql"),"utf8");
const orderSource=fs.readFileSync(path.join(__dirname,"../src/agents/agentOrdini.js"),"utf8");

test("migration creates canonical session, explicit lifecycle pointer and three states",()=>{
  assert.match(sql,/CREATE TABLE public\.service_sessions/); assert.match(sql,/business_date date NOT NULL/);
  assert.match(sql,/status IN \('open','closing','closed'\)/); assert.match(sql,/CREATE TABLE public\.service_session_state/);
  assert.match(sql,/current_session_id uuid/); assert.match(sql,/recent_closed_session_id uuid/);
});
test("one active session is physically and transactionally enforced",()=>{
  assert.match(sql,/UNIQUE INDEX service_sessions_single_active_uq[\s\S]*status IN \('open','closing'\)/);
  assert.ok((sql.match(/pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/g)||[]).length>=3);
  assert.match(sql,/MULTIPLE_ACTIVE_SERVICE_SESSIONS/);
});
test("orders reject forged identity, auto-assign open identity and make it immutable",()=>{
  assert.match(sql,/SERVICE_SESSION_FORGERY/); assert.match(sql,/NEW\.service_session_id := v_session\.id/);
  assert.match(sql,/NO_OPEN_SERVICE_SESSION/); assert.match(sql,/SERVICE_SESSION_IMMUTABLE/);
  assert.doesNotMatch(orderSource,/service_session_id\s*:\s*params\./);
});
test("session identity propagates to archive, summary and immutable financial evidence",()=>{
  for(const table of ["ordenes","storico","serata_summary","order_financial_events"]) assert.match(sql,new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN service_session_id`));
  assert.match(sql,/financial_event_assign_service_session/); assert.match(sql,/ORDER_WITHOUT_SERVICE_SESSION/);
  assert.match(sql,/DROP CONSTRAINT ofe_order_id_fk/);
  assert.match(sql,/storico_session_order_uq/); assert.match(sql,/serata_summary_session_uq/);
  assert.match(sql,/DROP CONSTRAINT storico_orden_id_fecha_key/);
});
test("same-day reopen creates UUID and midnight cannot change business date",()=>{
  assert.match(sql,/id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  assert.match(sql,/clock_timestamp\(\) AT TIME ZONE 'Europe\/Madrid'/);
  assert.doesNotMatch(sql,/lunch|dinner|pranzo|cena|hour|fascia/i);
});
test("current closeout follows explicit pointers and never newest/date heuristics",()=>{
  const fn=sql.slice(sql.indexOf("FUNCTION public.get_current_service_closeout_session"));
  assert.match(fn,/current_session_id/); assert.match(fn,/recent_closed_session_id/);
  assert.doesNotMatch(fn,/ORDER BY|business_date\s*=|LIMIT 1/);
});
test("migration is transactional, privilege-locked, no backfill, rollback local",()=>{
  assert.match(sql,/^BEGIN;/); assert.match(sql,/COMMIT;\s*$/); assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/REVOKE ALL[\s\S]*PUBLIC, anon, authenticated/); assert.doesNotMatch(sql,/UPDATE public\.(ordenes|storico|serata_summary|order_financial_events) SET service_session_id/i);
  assert.match(rb,/DROP TABLE IF EXISTS public\.service_sessions/); assert.match(rb,/^BEGIN;/); assert.match(rb,/COMMIT;\s*$/);
});
