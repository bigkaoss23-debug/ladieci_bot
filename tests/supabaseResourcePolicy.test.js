'use strict';
// Test per src/utils/supabaseResourcePolicy.js + il suo enforcement in
// src/utils/supabaseTransport.js — H1B Security Foundation Block.
// Eseguire: node tests/supabaseResourcePolicy.test.js
// OFFLINE: global.fetch è stubbato → nessuna rete, nessun DB.

const fs = require('fs');
const path = require('path');

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role-policy';

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};
async function captureErr(fn) { try { await fn(); return null; } catch (e) { return e; } }

delete require.cache[require.resolve('../src/utils/supabaseResourcePolicy')];
delete require.cache[require.resolve('../src/utils/supabaseTransport')];
const policy = require('../src/utils/supabaseResourcePolicy');
const transport = require('../src/utils/supabaseTransport');

// S3: resource-aware (not just a blanket '{}') so that a real DAO call chain
// depending on a non-empty intermediate result (e.g. mesaDao.listFloorRows's
// table_sessions -> ordenes/table_order_lines/payment_transactions fan-out,
// gated on at least one session id being present) actually traverses its full
// path instead of short-circuiting on an empty array. Every other existing
// check above only asserts on ok/status/error code, never on body shape, so
// this is a safe, backward-compatible upgrade of the single shared stub.
global.fetch = async (url, init) => {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  const nonEmptyArrayFor = /\/(table_sessions|payment_transactions)\?/.test(u);
  // GET-style reads (mesaDao.js's select()) require a JSON array in the body
  // or it throws MESA_DATA_READ_FAILED before reaching any further call in a
  // chain; POST-style writes (rpc()) never inspect body shape at all, so an
  // empty array is a safe universal default for both.
  const text = nonEmptyArrayFor ? JSON.stringify([{ id: 'mock-' + Math.random().toString(36).slice(2) }]) : '[]';
  return { ok: true, status: 200, text: async () => text };
};

(async () => {
  // ── 1) risorsa registrata ────────────────────────────────────────────────
  assert('1. risorsa registrata → policy trovata', policy.getResourcePolicy('ordenes') !== null);

  // ── 2) risorsa sconosciuta ───────────────────────────────────────────────
  assert('2. risorsa sconosciuta → policy null', policy.getResourcePolicy('utenti_segreti') === null);
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'utenti_segreti', operation: 'test' }));
    assert('2b. risorsa sconosciuta nel transport → SUPABASE_RESOURCE_NOT_ALLOWED',
      err && err.code === transport.ERROR_CODES.RESOURCE_NOT_ALLOWED);
  }

  // ── 3) metodo consentito ─────────────────────────────────────────────────
  assert('3. metodo consentito (ordenes GET)', policy.isMethodAllowed('ordenes', 'GET'));
  {
    const r = await transport.supabaseRequest({ resource: 'ordenes', method: 'GET', operation: 'test' });
    assert('3b. metodo consentito → richiesta eseguita', r.ok === true);
  }

  // ── 4) DELETE ordini usato dalla chiusura servizio ───────────────────────
  assert('4. metodo consentito (ordenes DELETE, chiusura servizio dopo archivio)', policy.isMethodAllowed('ordenes', 'DELETE'));
  {
    const r = await transport.supabaseRequest({ resource: 'ordenes', method: 'DELETE', operation: 'test' });
    assert('4b. DELETE ordenes registrato → richiesta eseguita', r.ok === true);
  }
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'clientes', method: 'DELETE', operation: 'test' }));
    assert('4c. DELETE resta vietato per una risorsa senza call site reale',
      err && err.code === transport.ERROR_CODES.METHOD_NOT_ALLOWED);
  }

  // ── 4d–4f) call site indiretti registrati ────────────────────────────────
  assert('4d. order-intake può leggere il puntatore del servizio corrente',
    policy.isMethodAllowed('service_session_state', 'GET'));
  assert('4e. order-intake può leggere la sessione servizio corrente',
    policy.isMethodAllowed('service_sessions', 'GET'));
  assert('4f. il logger può inserire le transizioni di stato sanificate',
    policy.isMethodAllowed('orden_estado_logs', 'POST'));

  // ── 5) RPC registrata ────────────────────────────────────────────────────
  assert('5. RPC registrata (rpc/start_rider_trip)', policy.getResourcePolicy('rpc/start_rider_trip') !== null);
  {
    const r = await transport.supabaseRequest({ resource: 'rpc/start_rider_trip', method: 'POST', operation: 'test' });
    assert('5b. RPC registrata → richiesta eseguita', r.ok === true);
  }

  // ── 6) RPC sconosciuta ───────────────────────────────────────────────────
  assert('6. RPC sconosciuta → policy null', policy.getResourcePolicy('rpc/drop_all_tables') === null);
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'rpc/drop_all_tables', method: 'POST', operation: 'test' }));
    assert('6b. RPC sconosciuta nel transport → SUPABASE_RESOURCE_NOT_ALLOWED',
      err && err.code === transport.ERROR_CODES.RESOURCE_NOT_ALLOWED);
  }

  // ── 7) URL assoluto vietato ──────────────────────────────────────────────
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'https://evil.example.com/rest/v1/ordenes', operation: 'test' }));
    assert('7. URL assoluto come resource → SUPABASE_REQUEST_INVALID', err && err.code === transport.ERROR_CODES.REQUEST_INVALID);
  }

  // ── 8) traversal vietato ─────────────────────────────────────────────────
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: '../../etc/passwd', operation: 'test' }));
    assert('8. path traversal in resource → SUPABASE_REQUEST_INVALID', err && err.code === transport.ERROR_CODES.REQUEST_INVALID);
  }

  // ── 9) CR/LF vietati ─────────────────────────────────────────────────────
  {
    const err1 = await captureErr(() => transport.supabaseRequest({ resource: 'ordenes\r\nX-Injected: 1', operation: 'test' }));
    assert('9a. CR/LF in resource → SUPABASE_REQUEST_INVALID', err1 && err1.code === transport.ERROR_CODES.REQUEST_INVALID);
    const err2 = await captureErr(() => transport.supabaseRequest({ resource: 'ordenes', query: 'id=eq.5\r\nX-Injected: 1', operation: 'test' }));
    assert('9b. CR/LF in query → SUPABASE_REQUEST_INVALID', err2 && err2.code === transport.ERROR_CODES.REQUEST_INVALID);
  }

  // ── 10) fragment vietato ─────────────────────────────────────────────────
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'ordenes#fragment', operation: 'test' }));
    assert('10. fragment "#" in resource → SUPABASE_REQUEST_INVALID', err && err.code === transport.ERROR_CODES.REQUEST_INVALID);
  }

  // ── 11) timeout default della risorsa ────────────────────────────────────
  {
    const p = policy.getResourcePolicy('ordenes');
    assert('11. timeout default della risorsa = 8000ms (nessun override oggi)', p.defaultTimeoutMs === 8000);
  }

  // ── 12) timeout massimo ──────────────────────────────────────────────────
  {
    const p = policy.getResourcePolicy('ordenes');
    assert('12. timeout massimo della risorsa = 20000ms', p.maxTimeoutMs === 20000);
    assert('12b. isTimeoutAllowed accetta un valore entro il massimo', policy.isTimeoutAllowed('ordenes', 15000));
  }

  // ── 13) timeout eccessivo ────────────────────────────────────────────────
  {
    assert('13. isTimeoutAllowed rifiuta un valore oltre il massimo', !policy.isTimeoutAllowed('ordenes', 999999));
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'ordenes', operation: 'test', timeoutMs: 999999 }));
    assert('13b. timeout eccessivo nel transport → SUPABASE_TIMEOUT_NOT_ALLOWED',
      err && err.code === transport.ERROR_CODES.TIMEOUT_NOT_ALLOWED);
  }

  // ── 14) query non-stringa ────────────────────────────────────────────────
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'ordenes', query: { id: 5 }, operation: 'test' }));
    assert('14. query non-stringa → SUPABASE_REQUEST_INVALID', err && err.code === transport.ERROR_CODES.REQUEST_INVALID);
  }

  // ── 15) operation name sicuro ────────────────────────────────────────────
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'ordenes', operation: 'test\r\nX-Injected: 1' }));
    assert('15. operation name con CR/LF → SUPABASE_REQUEST_INVALID', err && err.code === transport.ERROR_CODES.REQUEST_INVALID);
    const r = await transport.supabaseRequest({ resource: 'ordenes', operation: 'sbFetch:ordenes' });
    assert('15b. operation name valido (charset consueto sbFetch:table) → accettato', r.ok === true);
  }

  // ── 16) errori senza secret ──────────────────────────────────────────────
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'utenti_segreti', operation: 'test' }));
    const msg = String(err && err.message || '');
    assert('16. errore resource-not-allowed non contiene la stringa della risorsa non registrata',
      !msg.includes('utenti_segreti'));
    assert('16b. errore non contiene URL/credenziale', !msg.includes('mock.local') && !msg.includes('mock-service-role-policy'));
  }

  // ── 17) tutti i call site backend correnti usano risorse registrate ─────
  {
    const ROOT = path.join(__dirname, '..');
    function listJsFiles(dir, out = []) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) listJsFiles(full, out);
        else if (e.name.endsWith('.js')) out.push(full);
      }
      return out;
    }
    const files = [...listJsFiles(path.join(ROOT, 'src')), path.join(ROOT, 'index.js')];
    const unregistered = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const patterns = [
        /sb(?:Select|Upsert|Update|Delete|Insert)\(\s*["']([a-zA-Z_]+)["']/g,
        /safeSelect\(\s*["']([a-zA-Z_]+)["']/g,
        /sbRpc\(\s*["']([a-zA-Z_0-9]+)["']/g,
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(text))) {
          const table = m[1];
          const resource = re.source.includes('sbRpc') ? `rpc/${table}` : table;
          if (!policy.getResourcePolicy(resource)) unregistered.push(`${path.relative(ROOT, f)}: ${resource}`);
        }
      }
      // sbRest('METHOD', 'literal_table', ...) direct-table call sites (auth/account domain)
      const directRe = /sbRest\(\s*["'][A-Z]+["']\s*,\s*["']([a-zA-Z_]+)["']/g;
      let dm;
      while ((dm = directRe.exec(text))) {
        if (!policy.getResourcePolicy(dm[1])) unregistered.push(`${path.relative(ROOT, f)}: ${dm[1]}`);
      }
    }
    assert('17. ogni call site letterale trovato nel sorgente usa una risorsa registrata',
      unregistered.length === 0, unregistered.join(', '));
  }

  // ── 18) nessuna risorsa registry inutilizzata senza commento ────────────
  {
    const missingProvenance = policy.REGISTRY.filter((e) => !e.provenance || typeof e.provenance !== 'string' || e.provenance.length === 0);
    assert('18. ogni entry del registro ha un campo provenance non vuoto (nessuna voce senza giustificazione)',
      missingProvenance.length === 0, missingProvenance.map((e) => e.resource).join(', '));
  }

  // ── 19) nessun nome tabella derivato da request ──────────────────────────
  // Verificato strutturalmente: il transport non accetta alcun parametro diverso
  // da quelli in ALLOWED_PARAM_KEYS — un chiamante non può iniettare `resource`
  // da una fonte esterna passando altri campi; e la validazione di forma
  // (CHECK 4 del ratchet, Passo 10) verifica che nessuna route HTTP passi
  // req.query/body/params come resource.
  {
    const err = await captureErr(() => transport.supabaseRequest({
      resource: 'ordenes', operation: 'test', headers: { 'X-Fake': '1' },
    }));
    assert('19. un parametro extra non riconosciuto (es. headers) → SUPABASE_REQUEST_INVALID, mai silenziosamente ignorato',
      err && err.code === transport.ERROR_CODES.REQUEST_INVALID);
  }

  // ── 20) nessun raw PostgREST fuori dal transport ─────────────────────────
  // Coperto esaustivamente da tests/supabaseRawFetchRatchet.static.test.js
  // (rafforzato in H1B, Passo 10) — qui verifichiamo solo che l'allowlist di
  // quel ratchet sia vuota dopo la migrazione di readShadowPreviewOrders.
  {
    const ratchetSrc = fs.readFileSync(path.join(__dirname, 'supabaseRawFetchRatchet.static.test.js'), 'utf8');
    const m = ratchetSrc.match(/RAW_FETCH_ALLOWLIST\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
    const listBody = m ? m[1] : '';
    const nonCommentEntries = listBody
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('//'))
      .filter((l) => l !== '');
    assert('20. allowlist del ratchet raw-fetch è vuota dopo H1B', nonCommentEntries.length === 0, nonCommentEntries.join(' | '));
  }

  // ── 21) SLICE 4C.2A — the 5 closeout-lifecycle RPCs performIncidentSafeRollover
  //       actually calls are registered, POST-only ─────────────────────────
  {
    const REQUIRED_ROLLOVER_RPCS = [
      'rpc/acquire_closeout_attempt',
      'rpc/capture_closeout_snapshot',
      'rpc/create_service_incident',
      'rpc/supersede_closeout_attempt',
      'rpc/complete_closeout_attempt',
    ];
    for (const resource of REQUIRED_ROLLOVER_RPCS) {
      assert(`21. ${resource} is registered`, policy.getResourcePolicy(resource) !== null);
      assert(`21. ${resource} allows POST`, policy.isMethodAllowed(resource, 'POST'));
      assert(`21. ${resource} denies GET`, !policy.isMethodAllowed(resource, 'GET'));
      assert(`21. ${resource} denies DELETE`, !policy.isMethodAllowed(resource, 'DELETE'));
    }
    for (const resource of REQUIRED_ROLLOVER_RPCS) {
      const r = await transport.supabaseRequest({ resource, method: 'POST', operation: 'test' });
      assert(`21b. ${resource} POST reaches the transport`, r.ok === true);
      const err = await captureErr(() => transport.supabaseRequest({ resource, method: 'GET', operation: 'test' }));
      assert(`21c. ${resource} GET is rejected by the transport`, err && err.code === transport.ERROR_CODES.METHOD_NOT_ALLOWED);
    }
  }

  // ── 22) service_closeout_snapshots — GET only (getByCorrelationId/listBySession) ──
  {
    assert('22. service_closeout_snapshots is registered', policy.getResourcePolicy('service_closeout_snapshots') !== null);
    assert('22. service_closeout_snapshots allows GET', policy.isMethodAllowed('service_closeout_snapshots', 'GET'));
    assert('22. service_closeout_snapshots denies POST', !policy.isMethodAllowed('service_closeout_snapshots', 'POST'));
    assert('22. service_closeout_snapshots denies PATCH', !policy.isMethodAllowed('service_closeout_snapshots', 'PATCH'));
    assert('22. service_closeout_snapshots denies DELETE', !policy.isMethodAllowed('service_closeout_snapshots', 'DELETE'));
    const r = await transport.supabaseRequest({ resource: 'service_closeout_snapshots', method: 'GET', operation: 'test' });
    assert('22b. GET reaches the transport', r.ok === true);
  }

  // ── 23) least privilege — resources with NO accepted runtime caller today
  //       remain deliberately denied, even though the DB objects exist ──────
  {
    const STILL_DENIED = [
      'rpc/create_archived_order_financial_resolution',
      'archived_order_financial_resolutions',
      'service_incident_resolutions',
    ];
    for (const resource of STILL_DENIED) {
      assert(`23. ${resource} remains unregistered (no accepted runtime caller)`, policy.getResourcePolicy(resource) === null);
      const err = await captureErr(() => transport.supabaseRequest({ resource, method: 'POST', operation: 'test' }));
      assert(`23b. ${resource} POST is rejected by the transport`, err && err.code === transport.ERROR_CODES.RESOURCE_NOT_ALLOWED);
    }
  }

  // ── 25) SLICE 4C.2C — resolve_service_incident is NOW registered (a real,
  //       internal-only caller exists: incidentSafeRollover.js's confirmed-
  //       success resolution step), POST-only, and mesa_release_empty_session_
  //       auto_v1 (the trusted-system table release) is registered the same
  //       way. Neither has any HTTP action — see
  //       tests/serviceCloseoutIncidentsFoundation.static.test.js §10d3-10d5
  //       for the exhaustive cross-file proof of that; here we only prove the
  //       transport-level shape is correct and minimal. ────────────────────
  {
    const NEW_INTERNAL_RPCS = ['rpc/resolve_service_incident', 'rpc/mesa_release_empty_session_auto_v1'];
    for (const resource of NEW_INTERNAL_RPCS) {
      assert(`25. ${resource} is registered`, policy.getResourcePolicy(resource) !== null);
      assert(`25. ${resource} allows POST`, policy.isMethodAllowed(resource, 'POST'));
      assert(`25. ${resource} denies GET`, !policy.isMethodAllowed(resource, 'GET'));
      assert(`25. ${resource} denies DELETE`, !policy.isMethodAllowed(resource, 'DELETE'));
      const r = await transport.supabaseRequest({ resource, method: 'POST', operation: 'test' });
      assert(`25b. ${resource} POST reaches the transport`, r.ok === true);
    }
    // The original human-facing release RPC must be completely untouched —
    // 4C.2C adds a sibling, it does not modify or replace this one.
    assert('25c. mesa_release_empty_session_v1 (the human/Mesa-UI path) is unchanged and still registered', policy.getResourcePolicy('rpc/mesa_release_empty_session_v1') !== null);
  }

  // ── 24) an unknown/invented Service Closeout RPC never passes the allowlist ──
  {
    assert('24. a made-up closeout RPC name is not registered', policy.getResourcePolicy('rpc/delete_closeout_attempt') === null);
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'rpc/delete_closeout_attempt', method: 'POST', operation: 'test' }));
    assert('24b. a made-up closeout RPC is rejected by the transport', err && err.code === transport.ERROR_CODES.RESOURCE_NOT_ALLOWED);
  }

  // ── 27) SERVICE LIFECYCLE V3 / SLICE 3.2.1 — service_closeouts is now a
  //       registered GET-only table (serviceCloseouts.js getBySessionId(),
  //       called for real by serviceLifecycleEngine.js's retry-lineage check)
  //       and service_closeout_attempts (already registered) still allows
  //       GET only — closeoutAttempts.js getByCorrelationId() adds a new
  //       caller, not a new method. ─────────────────────────────────────────
  {
    assert('27. service_closeouts is registered', policy.getResourcePolicy('service_closeouts') !== null);
    assert('27. service_closeouts allows GET', policy.isMethodAllowed('service_closeouts', 'GET'));
    assert('27. service_closeouts denies POST (append-only via the create_service_closeout RPC, never a direct table write)', !policy.isMethodAllowed('service_closeouts', 'POST'));
    assert('27. service_closeouts denies PATCH', !policy.isMethodAllowed('service_closeouts', 'PATCH'));
    assert('27. service_closeouts denies DELETE', !policy.isMethodAllowed('service_closeouts', 'DELETE'));
    const r = await transport.supabaseRequest({ resource: 'service_closeouts', method: 'GET', operation: 'test' });
    assert('27b. GET reaches the transport', r.ok === true);
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'service_closeouts', method: 'POST', operation: 'test' }));
    assert('27c. POST is rejected by the transport', err && err.code === transport.ERROR_CODES.METHOD_NOT_ALLOWED);
  }
  {
    assert('28. service_closeout_attempts still denies POST/PATCH/DELETE directly (writes stay RPC-only: acquire/supersede/complete_closeout_attempt)',
      !policy.isMethodAllowed('service_closeout_attempts', 'POST')
      && !policy.isMethodAllowed('service_closeout_attempts', 'PATCH')
      && !policy.isMethodAllowed('service_closeout_attempts', 'DELETE'));
  }

  // ── 26) SERVICE LIFECYCLE V3 / SLICE 3.2 — the 2 new close-engine RPCs
  //       (serviceCloseoutCreation.js / serviceLifecycleV3Transition.js,
  //       called by src/serviceSessions/serviceLifecycleEngine.js) are
  //       registered, POST-only, own block, separate from the SERVICE
  //       CLOSEOUT V2 entries above — see
  //       tests/serviceLifecycleV3CloseEngineResourcePolicyIntegration.test.js
  //       for the real-wrapper (non-DI) end-to-end proof. ──────────────────
  {
    const NEW_V3_2_RPCS = ['rpc/create_service_closeout', 'rpc/close_service_session_v3'];
    for (const resource of NEW_V3_2_RPCS) {
      assert(`26. ${resource} is registered`, policy.getResourcePolicy(resource) !== null);
      assert(`26. ${resource} allows POST`, policy.isMethodAllowed(resource, 'POST'));
      assert(`26. ${resource} denies GET`, !policy.isMethodAllowed(resource, 'GET'));
      assert(`26. ${resource} denies DELETE`, !policy.isMethodAllowed(resource, 'DELETE'));
      const r = await transport.supabaseRequest({ resource, method: 'POST', operation: 'test' });
      assert(`26b. ${resource} POST reaches the transport`, r.ok === true);
    }
  }

  // ── 28) SERVICE LIFECYCLE V3 / SLICE 3.4 — the next-service-opening RPC
  //       (serviceLifecycleV3Transition.js ensureNext(), called by
  //       serviceLifecycleEngine.js). Same posture as check 26: POST-only,
  //       service_role internal, no HTTP action anywhere calls it. ─────────
  {
    const resource = 'rpc/ensure_next_service_session_v3';
    assert(`28. ${resource} is registered`, policy.getResourcePolicy(resource) !== null);
    assert(`28. ${resource} allows POST`, policy.isMethodAllowed(resource, 'POST'));
    assert(`28. ${resource} denies GET`, !policy.isMethodAllowed(resource, 'GET'));
    assert(`28. ${resource} denies DELETE`, !policy.isMethodAllowed(resource, 'DELETE'));
    const r = await transport.supabaseRequest({ resource, method: 'POST', operation: 'test' });
    assert(`28b. ${resource} POST reaches the transport`, r.ok === true);
  }

  // ── 29) MESA_SEND_TO_KITCHEN_P0_FIX (2026-08-14) -- mesa_set_session_
  //       covers_v1 (tables/mesaDao.js setCovers()). Missed at implementation
  //       time and only caught by live UI UAT: without this entry the DAO
  //       call is rejected by this very registry (SUPABASE_RESOURCE_NOT_
  //       ALLOWED) before ever reaching Supabase -- exactly the class of bug
  //       this suite exists to catch. Same posture as its mesaDao.js siblings
  //       (mesa_open_session_v1 etc): POST-only, service_role internal. ────
  {
    const resource = 'rpc/mesa_set_session_covers_v1';
    assert(`29. ${resource} is registered`, policy.getResourcePolicy(resource) !== null);
    assert(`29. ${resource} allows POST`, policy.isMethodAllowed(resource, 'POST'));
    assert(`29. ${resource} denies GET`, !policy.isMethodAllowed(resource, 'GET'));
    assert(`29. ${resource} denies DELETE`, !policy.isMethodAllowed(resource, 'DELETE'));
    const r = await transport.supabaseRequest({ resource, method: 'POST', operation: 'test' });
    assert(`29b. ${resource} POST reaches the transport`, r.ok === true);
  }

  // ── 30) S3 — RUNTIME-INSTRUMENTED RESOURCE PARITY ────────────────────────
  // MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S3. GOAL: make
  // registry drift impossible to miss. DOMAIN RULE: every {resource, method}
  // reachable from any DAO is registered.
  //
  // Check 17 (above) is a source-text regex scan for specific literal call
  // patterns (sbSelect(...), sbRpc(...), safeSelect(...), sbRest('METHOD',
  // 'literal', ...)) -- it is BLIND to any DAO that defines its own local
  // select()/rpc() wrapper, which is exactly what src/tables/mesaDao.js does.
  // Empirically: 0 of check 17's patterns match anywhere in mesaDao.js, so it
  // scans zero resources from the Mesa DAO today, even though mesaDao.js is a
  // real, live, heavily-used caller (every S1/S2 live validation in this
  // remediation went through it). This check closes that gap by actually
  // DRIVING every src/tables/*.js DAO entrypoint through the real transport
  // (via supabaseTransport's test-mode recorder, set up above at module
  // load time is NOT required -- it fires for ANY caller, any local wrapper
  // name, because every DAO ultimately funnels through supabaseRequest) and
  // asserting the OBSERVED {resource, method} set is a subset of the
  // registered policy -- proof by actually reaching the entrypoint, not by
  // guessing from source text.
  //
  // HARD GATE this check exists to satisfy: delete rpc/mesa_set_session_
  // covers_v1's registry entry (and its own hand-written check 29 -- the
  // "hand-maintained RPC array" pattern this slice removes the NEED for,
  // though existing per-resource checks like 29 are left in place as
  // additional, non-exclusive coverage) in a scratch branch: this check must
  // fail. Verified empirically before writing this fix: with both removed,
  // the FULL pre-existing suite (112 assertions) passed -- proving the blind
  // spot was real, not hypothetical.
  {
    const observed = [];
    transport.setTestModeRecorder((hit) => observed.push(hit));

    const ROOT = path.join(__dirname, '..');
    const TABLES_DIR = path.join(ROOT, 'src', 'tables');
    const daoFiles = fs.readdirSync(TABLES_DIR).filter((f) => f.endsWith('.js'));
    assert('30a. at least one src/tables/*.js module exists to instrument', daoFiles.length > 0);

    let invokedFunctionCount = 0;
    const invokedNames = new Set();
    const invocationErrors = [];
    for (const file of daoFiles) {
      delete require.cache[require.resolve(path.join(TABLES_DIR, file))];
      const mod = require(path.join(TABLES_DIR, file));
      if (!mod || typeof mod !== 'object') continue;
      for (const [exportName, fn] of Object.entries(mod)) {
        if (typeof fn !== 'function') continue;
        invokedFunctionCount++;
        invokedNames.add(`${file}:${exportName}`);
        try {
          // Every real mesaDao.js entrypoint either takes a single args
          // object (destructured as args.fieldName -- undefined fields are
          // harmless) or leading positional string(s) that only ever reach
          // encodeURIComponent(...) before the first resource call (also
          // harmless on undefined/object input) -- so one generic call shape
          // is sufficient to drive every export to its first real resource
          // call without needing per-function bespoke mocks. A factory-style
          // export (e.g. a hypothetical createXService(cfg)) that returns a
          // plain object synchronously rather than touching the network is
          // equally harmless here: it just contributes zero observations.
          const result = fn({});
          if (result && typeof result.then === 'function') await result.catch(() => {});
        } catch (_) {
          // Only a resource-policy rejection matters to this check (and that
          // is captured by the recorder above, which fires BEFORE the throw)
          // -- any other error (a downstream MESA_* business error from the
          // mocked, semantically-empty response) is expected and irrelevant
          // to reachability; record it only for the STOP-condition diagnostic
          // below, never as a check-30 failure by itself.
          invocationErrors.push(`${file}:${exportName}`);
        }
      }
    }
    transport.setTestModeRecorder(null);

    assert('30b. the harness actually reached every src/tables/*.js exported function (none skipped/unreachable)',
      invokedFunctionCount > 0);
    // STOP condition (V2.1.2, S3): "if the harness cannot reach every
    // src/tables/ entrypoint". Deliberately NOT a hardcoded count (that would
    // just be a new hand-maintained shim of exactly the kind this slice
    // removes) -- instead, every currently-exported mesaDao.js function must
    // have been attempted (present in invocationErrors is fine -- a
    // downstream business-error from the mocked, semantically-empty response
    // is still a real attempt; total silence for a given export is not).
    assert('30c. every mesaDao.js exported entrypoint was actually invoked by the harness (fails if a future export is added and this harness silently stops reaching it, or if one goes missing)',
      (() => {
        const mesaDao = require(path.join(TABLES_DIR, 'mesaDao.js'));
        const expected = Object.keys(mesaDao).filter((k) => typeof mesaDao[k] === 'function');
        const missing = expected.filter((name) => !invokedNames.has(`mesaDao.js:${name}`));
        return expected.length > 0 && missing.length === 0;
      })());

    const distinctPairs = [...new Map(observed.map((o) => [`${o.resource}::${o.method}`, o])).values()];
    assert('30d. the runtime harness observed at least one {resource, method} pair from mesaDao.js (proves the recorder actually fired, not a silent no-op)',
      distinctPairs.length > 0);

    const unregistered = distinctPairs.filter((o) => !policy.getResourcePolicy(o.resource) || !policy.isMethodAllowed(o.resource, o.method));
    assert('30e. every {resource, method} pair OBSERVED via the real runtime transport (not guessed from source text) is registered and allowed',
      unregistered.length === 0,
      unregistered.map((o) => `${o.resource} ${o.method}`).join(', '));

    // HARD GATE, executed directly: temporarily blind the live policy lookup
    // to rpc/mesa_set_session_covers_v1 (REGISTRY itself is Object.freeze()'d
    // -- read-only by design, so this monkey-patches the two exported lookup
    // functions instead, which are plain writable module.exports properties),
    // re-run the exact same observed-pairs-vs-policy check, and require it to
    // now FAIL. Restored in a finally block no matter what, so no other check
    // in this file or any file run after it is ever affected.
    {
      const GATED_RESOURCE = 'rpc/mesa_set_session_covers_v1';
      assert('30f. hard-gate precondition: rpc/mesa_set_session_covers_v1 is present in the live registry before the gate test',
        policy.getResourcePolicy(GATED_RESOURCE) !== null);
      const originalGetResourcePolicy = policy.getResourcePolicy;
      const originalIsMethodAllowed = policy.isMethodAllowed;
      policy.getResourcePolicy = (resource) => (resource === GATED_RESOURCE ? null : originalGetResourcePolicy(resource));
      policy.isMethodAllowed = (resource, method) => (resource === GATED_RESOURCE ? false : originalIsMethodAllowed(resource, method));
      try {
        const stillUnregistered = distinctPairs.filter((o) => !policy.getResourcePolicy(o.resource) || !policy.isMethodAllowed(o.resource, o.method));
        assert('30g. HARD GATE: with rpc/mesa_set_session_covers_v1 unregistered, this check now fails closed (catches exactly the regression check 17 cannot see)',
          stillUnregistered.some((o) => o.resource === GATED_RESOURCE));
      } finally {
        policy.getResourcePolicy = originalGetResourcePolicy;
        policy.isMethodAllowed = originalIsMethodAllowed;
      }
      assert('30h. registry restored to its original state after the hard-gate test', policy.getResourcePolicy(GATED_RESOURCE) !== null);
    }
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  delete global.fetch;
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + (e && e.stack || e));
  delete global.fetch;
  process.exit(1);
});
