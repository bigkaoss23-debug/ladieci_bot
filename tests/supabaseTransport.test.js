// Test per src/utils/supabaseTransport.js — H1A Security Foundation Block.
// Eseguire: node tests/supabaseTransport.test.js
// OFFLINE: global.fetch è stubbato → nessuna rete, nessun DB. Nessun secret reale.

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};

const ORIGINAL_URL = process.env.SUPABASE_URL;
const ORIGINAL_KEY = process.env.SUPABASE_KEY;
const ORIGINAL_FETCH = global.fetch;

function setEnv(url, key) {
  if (url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = url;
  if (key === undefined) delete process.env.SUPABASE_KEY; else process.env.SUPABASE_KEY = key;
}

function freshTransport() {
  delete require.cache[require.resolve('../src/utils/supabaseTransport')];
  return require('../src/utils/supabaseTransport');
}

(async () => {
  // ── 1) config assente → fail-closed ────────────────────────────────────
  setEnv(undefined, undefined);
  let mod = freshTransport();
  {
    const err = await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test' }));
    assert('1. config assente (URL+KEY) → fail-closed SUPABASE_CONFIGURATION_ERROR',
      err && err.code === mod.ERROR_CODES.CONFIG);
  }

  // ── 2) URL assente → fail-closed ───────────────────────────────────────
  setEnv(undefined, 'mock-service-role');
  mod = freshTransport();
  {
    const err = await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test' }));
    assert('2. URL assente → fail-closed SUPABASE_CONFIGURATION_ERROR',
      err && err.code === mod.ERROR_CODES.CONFIG);
  }

  // ── 3) credenziale assente → fail-closed ───────────────────────────────
  setEnv('http://mock.local', undefined);
  mod = freshTransport();
  {
    const err = await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test' }));
    assert('3. credenziale assente → fail-closed SUPABASE_CONFIGURATION_ERROR',
      err && err.code === mod.ERROR_CODES.CONFIG);
  }

  // From here on, config is present for every test.
  setEnv('http://mock.local', 'mock-service-role-key-not-real');
  mod = freshTransport();

  // ── 4) timeout → abort reale ───────────────────────────────────────────
  {
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
      // never resolves on its own — only the abort signal settles this promise
    });
    const started = Date.now();
    const err = await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test', timeoutMs: 30 }));
    const elapsed = Date.now() - started;
    assert('4. timeout → SUPABASE_TIMEOUT', err && err.code === mod.ERROR_CODES.TIMEOUT);
    assert('4b. timeout abort è reale (non attende oltre ~200ms)', elapsed < 200, `elapsed=${elapsed}ms`);
  }

  // ── 5) cleanup timer (nessun handle pendente dopo una richiesta OK) ────
  {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"a":1}' });
    const before = process._getActiveHandles ? process._getActiveHandles().length : null;
    await mod.supabaseRequest({ resource: 'ordenes', operation: 'test', timeoutMs: 5000 });
    if (before !== null) {
      const after = process._getActiveHandles().length;
      assert('5. cleanup timer — nessun handle timer residuo', after <= before,
        `before=${before} after=${after}`);
    } else {
      assert('5. cleanup timer — skip (process._getActiveHandles non disponibile)', true);
    }
  }

  // ── 6) errore rete ──────────────────────────────────────────────────────
  {
    global.fetch = async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); };
    const err = await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test' }));
    assert('6. errore rete → SUPABASE_NETWORK_ERROR', err && err.code === mod.ERROR_CODES.NETWORK);
    assert('6b. errore rete non espone il messaggio originale', err.message === 'supabase request failed');
  }

  // ── 7) risposta non-2xx ─────────────────────────────────────────────────
  {
    global.fetch = async () => ({ ok: false, status: 409, text: async () => '{"code":"23505"}' });
    const r = await mod.supabaseRequest({ resource: 'ordenes', operation: 'test' });
    assert('7. risposta non-2xx non lancia — ok:false, status preservato', r.ok === false && r.status === 409);
  }

  // ── 8) JSON invalido ─────────────────────────────────────────────────────
  {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => 'not json{{{' });
    const r = await mod.supabaseRequest({ resource: 'ordenes', operation: 'test' });
    assert('8. JSON invalido → bodyIsJson=false, text preservato', r.bodyIsJson === false && r.text === 'not json{{{');
  }

  // ── 9) risposta vuota ammessa quando prevista ───────────────────────────
  // resource 'conv' (non 'ordenes'): DELETE è un metodo registrato per conv
  // (servizio.js close), non per ordenes — vedi supabaseResourcePolicy.js (H1B).
  {
    global.fetch = async () => ({ ok: true, status: 204, text: async () => '' });
    const r = await mod.supabaseRequest({ resource: 'conv', method: 'DELETE', operation: 'test' });
    assert('9. risposta vuota → ok:true, bodyIsJson=false, body=undefined',
      r.ok === true && r.bodyIsJson === false && r.body === undefined);
  }

  // ── 10) nessun secret nell'errore ───────────────────────────────────────
  {
    global.fetch = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); };
    const err = await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test' }));
    const msg = String(err && err.message || '');
    assert('10. nessun secret/URL/dettaglio interno nel messaggio d\'errore',
      !msg.includes('mock-service-role-key-not-real') && !msg.includes('http://mock.local') && !msg.includes('ECONNREFUSED'));
  }

  // ── 11) nessun body sensibile nel log ───────────────────────────────────
  {
    const originalWarn = console.warn;
    const originalLog = console.log;
    const logged = [];
    console.warn = (...args) => logged.push(args.join(' '));
    console.log = (...args) => logged.push(args.join(' '));
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"telefono":"+34600111222","nombre":"Juan"}' });
    await mod.supabaseRequest({
      resource: 'clientes',
      method: 'POST',
      body: { telefono: '+34600111222', nombre: 'Juan' },
      operation: 'test',
    });
    console.warn = originalWarn;
    console.log = originalLog;
    const allLogs = logged.join('\n');
    assert('11. nessun body/PII nel log (telefono/nombre assenti)',
      !allLogs.includes('+34600111222') && !allLogs.includes('Juan'));
  }

  // ── 12) metodo e header corretti ────────────────────────────────────────
  {
    let capturedUrl, capturedOpts;
    global.fetch = async (url, opts) => { capturedUrl = url; capturedOpts = opts; return { ok: true, status: 200, text: async () => '{}' }; };
    await mod.supabaseRequest({ resource: 'ordenes', method: 'patch', query: 'id=eq.5', body: { estado: 'LISTO' }, prefer: 'return=representation', operation: 'test' });
    assert('12a. metodo normalizzato a maiuscolo', capturedOpts.method === 'PATCH');
    assert('12b. URL costruito da resource+query, mai passato dal chiamante', capturedUrl === 'http://mock.local/rest/v1/ordenes?id=eq.5');
    assert('12c. header apikey/Authorization presenti, mai sovrascrivibili dal chiamante',
      capturedOpts.headers.apikey === 'mock-service-role-key-not-real' &&
      capturedOpts.headers.Authorization === 'Bearer mock-service-role-key-not-real');
    assert('12d. Prefer forwardato', capturedOpts.headers.Prefer === 'return=representation');
    assert('12e. Content-Type impostato solo perché c\'è un body', capturedOpts.headers['Content-Type'] === 'application/json');
  }

  // ── 13) nessun retry automatico ─────────────────────────────────────────
  {
    let calls = 0;
    global.fetch = async () => { calls++; throw new TypeError('network down'); };
    await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test' }));
    assert('13. nessun retry automatico su errore di rete (1 sola chiamata fetch)', calls === 1, `calls=${calls}`);
  }

  // ── 14) limite timeout massimo ──────────────────────────────────────────
  // H1B tightens H1A's behavior: an explicitly requested timeoutMs beyond the
  // resource's own ceiling is now REJECTED (SUPABASE_TIMEOUT_NOT_ALLOWED), not
  // silently clamped — no real call site today ever passes an explicit
  // timeoutMs, so this cannot regress production behavior (verified in the H1B
  // audit). A value within the ceiling still succeeds normally.
  {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
    const err = await captureErr(() => mod.supabaseRequest({ resource: 'ordenes', operation: 'test', timeoutMs: 999999 }));
    assert('14a. timeoutMs oltre il massimo della risorsa → SUPABASE_TIMEOUT_NOT_ALLOWED (rifiutato, non clampato)',
      err && err.code === mod.ERROR_CODES.TIMEOUT_NOT_ALLOWED);
    let capturedSignal;
    global.fetch = async (url, opts) => { capturedSignal = opts.signal; return { ok: true, status: 200, text: async () => '{}' }; };
    await mod.supabaseRequest({ resource: 'ordenes', operation: 'test', timeoutMs: 15000 });
    assert('14b. timeoutMs entro il massimo della risorsa → richiesta completata normalmente', capturedSignal instanceof AbortSignal);
  }

  // ── 15) operation name opzionale con default sicuro ─────────────────────
  {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
    const r = await mod.supabaseRequest({ resource: 'ordenes' }); // nessun `operation` passato
    assert('15. operation omessa non causa errori — richiesta completata comunque', r.ok === true);
  }

  // ── extra) resource mancante → fail-closed (non è nella lista numerata ma è un requisito esplicito) ──
  {
    const err = await captureErr(() => mod.supabaseRequest({ operation: 'test' }));
    // H1B reclassifies this from SUPABASE_CONFIGURATION_ERROR (a server/env issue)
    // to SUPABASE_REQUEST_INVALID (a malformed caller request) — still fail-closed,
    // more accurate code. No real call site ever omits resource (verified in the
    // H1B audit), so this is unreachable in production either way.
    assert('extra. resource assente → fail-closed SUPABASE_REQUEST_INVALID', err && err.code === mod.ERROR_CODES.REQUEST_INVALID);
  }

  setEnv(ORIGINAL_URL, ORIGINAL_KEY);
  global.fetch = ORIGINAL_FETCH;

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + (e && e.stack || e));
  setEnv(ORIGINAL_URL, ORIGINAL_KEY);
  global.fetch = ORIGINAL_FETCH;
  process.exit(1);
});

async function captureErr(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
