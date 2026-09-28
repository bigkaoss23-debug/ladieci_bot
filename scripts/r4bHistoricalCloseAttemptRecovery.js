#!/usr/bin/env node
'use strict';
// R4B -- HISTORICAL-ONLY recovery of closeout attempts left 'active' on a service that is already 'closed'.
//
// Since migration 149 that state cannot be COMMITTED any more (the terminal close and the attempt completion commit together, and two deferred
// constraint triggers refuse either half alone), so normal operation never needs this script. It exists only for rows written BEFORE 149 (or
// during the window between applying 149 and deploying the backend that uses it), whose Finalizar client never came back.
//
// It never closes anything. For each listed service it calls the V3 engine BY ID; for a closed service the engine can only take CASE D (prove
// the realized close from that service's OWN snapshot / closeout / reconciliation, in order, then complete that exact attempt) or refuse
// (V3_CLOSE_RESUME_EVIDENCE_INCOMPLETE and friends, no write). It never reads the current-service pointer and never touches another service.
//
// Usage (the normal backend environment: SUPABASE_URL / SUPABASE_KEY):
//   node scripts/r4bHistoricalCloseAttemptRecovery.js list                           read-only: the closed services with an active attempt
//   node scripts/r4bHistoricalCloseAttemptRecovery.js recover --service <uuid> ...   CASE D for exactly those services (each must be listed)
// Exit code: 0 = done (list) / every requested service completed; 1 = a service was refused or is not in the list; 2 = usage error.

const { sbSelect } = require('../src/utils/supabase');
const { closeServiceSessionV3 } = require('../src/serviceSessions/serviceCloseAuthority');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listStranded({ select = sbSelect } = {}) {
  const active = await select('service_closeout_attempts', 'status=eq.active&select=closeout_correlation_id,service_session_id,started_at');
  const ids = [...new Set((Array.isArray(active) ? active : []).map((a) => a.service_session_id))];
  if (ids.length === 0) return [];
  const sessions = await select('service_sessions', `id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,status,closed_at,lifecycle_semantics`);
  const closed = new Map((Array.isArray(sessions) ? sessions : []).filter((s) => s.status === 'closed').map((s) => [s.id, s]));
  return active.filter((a) => closed.has(a.service_session_id))
    .map((a) => ({ serviceSessionId: a.service_session_id, closeoutCorrelationId: a.closeout_correlation_id, attemptStartedAt: a.started_at,
      closedAt: closed.get(a.service_session_id).closed_at, lifecycleSemantics: closed.get(a.service_session_id).lifecycle_semantics }));
}

async function recover(serviceIds, { select = sbSelect, close = closeServiceSessionV3, actor = 'ops_r4b_historical_recovery' } = {}) {
  const stranded = await listStranded({ select });
  const out = [];
  for (const id of serviceIds) {
    const row = stranded.find((s) => s.serviceSessionId === id);
    if (!row) { out.push({ serviceSessionId: id, ok: false, code: 'NOT_A_CLOSED_SERVICE_WITH_ACTIVE_ATTEMPT' }); continue; }
    const r = await close({ serviceSessionId: id, source: 'ops_r4b_historical_recovery', actor });
    out.push({ serviceSessionId: id, ok: r.success === true, code: r.code, missing: r.missing, closeoutCorrelationId: r.closeoutCorrelationId });
  }
  return out;
}

module.exports = { listStranded, recover };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'list') { console.log(JSON.stringify(await listStranded(), null, 1)); process.exit(0); }
    if (cmd === 'recover') {
      const ids = []; for (let i = 0; i < rest.length; i++) if (rest[i] === '--service') ids.push(String(rest[++i] || '').toLowerCase());
      if (ids.length === 0 || !ids.every((x) => UUID_RE.test(x))) { console.error('recover needs one or more --service <uuid>'); process.exit(2); }
      const r = await recover(ids); console.log(JSON.stringify(r, null, 1)); process.exit(r.every((x) => x.ok) ? 0 : 1);
    }
    console.error('usage: r4bHistoricalCloseAttemptRecovery.js list | recover --service <uuid> [--service <uuid> ...]'); process.exit(2);
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
