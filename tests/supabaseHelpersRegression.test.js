// Regression test — H1A Security Foundation Block.
// Eseguire: node tests/supabaseHelpersRegression.test.js
//
// Verifica che src/utils/supabase.js e src/auth/audit.js, dopo il passaggio interno
// al nuovo transport (src/utils/supabaseTransport.js), producano URL/query/metodo/
// body/header IDENTICI a quelli pre-H1A, e che la forma del valore di ritorno
// pubblico (non solo il tipo) resti la stessa per ogni funzione esportata.
// OFFLINE: global.fetch è stubbato → nessuna rete, nessun DB.

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role-regression';

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};

let calls = [];
let responder = null;
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method, headers: { ...opts.headers }, body: opts.body });
  const r = responder ? responder(url, opts) : { ok: true, status: 200, text: '{}' };
  return {
    ok: r.ok !== false,
    status: r.status || 200,
    text: async () => (r.text !== undefined ? r.text : ''),
  };
};
const reset = (fn) => { calls = []; responder = fn || null; };

delete require.cache[require.resolve('../src/utils/supabase')];
delete require.cache[require.resolve('../src/auth/audit')];
const supa = require('../src/utils/supabase');
const audit = require('../src/auth/audit');

(async () => {
  // ── sbSelect: URL/query identici al comportamento pre-H1A ──────────────
  reset(() => ({ text: '[{"id":1}]' }));
  const rows = await supa.sbSelect('ordenes', 'estado=eq.NUEVO&limit=10');
  assert('sbSelect: URL = {base}/rest/v1/{table}?select=*&{query} (identico)',
    calls[0].url === 'http://mock.local/rest/v1/ordenes?select=*&estado=eq.NUEVO&limit=10');
  assert('sbSelect: metodo GET', calls[0].method === 'GET');
  assert('sbSelect: ritorna array parsato (JSON valido) — forma pubblica identica',
    Array.isArray(rows) && rows.length === 1 && rows[0].id === 1);
  assert('sbSelect: header apikey/Authorization = service-role key',
    calls[0].headers.apikey === 'mock-service-role-regression' &&
    calls[0].headers.Authorization === 'Bearer mock-service-role-regression');

  // ── sbSelect: risposta non-JSON → ritorna testo grezzo (tolleranza storica) ──
  reset(() => ({ text: 'plain text not json' }));
  const raw = await supa.sbSelect('config');
  assert('sbSelect: risposta non-JSON → testo grezzo (comportamento pre-H1A preservato)',
    raw === 'plain text not json');

  // ── sbUpsert: query on_conflict + Prefer merge-duplicates ───────────────
  reset(() => ({ text: '[{"id":5}]' }));
  await supa.sbUpsert('clientes', { tel: '600111222' }, 'tel');
  assert('sbUpsert: metodo POST', calls[0].method === 'POST');
  assert('sbUpsert: query on_conflict identica', calls[0].url === 'http://mock.local/rest/v1/clientes?on_conflict=tel');
  assert('sbUpsert: Prefer = return=representation,resolution=merge-duplicates',
    calls[0].headers.Prefer === 'return=representation,resolution=merge-duplicates');
  assert('sbUpsert: body JSON identico ai dati passati', JSON.parse(calls[0].body).tel === '600111222');

  // ── sbUpdate: PATCH con query e body ─────────────────────────────────────
  reset(() => ({ text: '[{"id":9}]' }));
  await supa.sbUpdate('ordenes', 'id=eq.9', { estado: 'LISTO' });
  assert('sbUpdate: metodo PATCH', calls[0].method === 'PATCH');
  assert('sbUpdate: URL = {base}/rest/v1/ordenes?id=eq.9', calls[0].url === 'http://mock.local/rest/v1/ordenes?id=eq.9');
  assert('sbUpdate: body identico', JSON.parse(calls[0].body).estado === 'LISTO');

  // ── sbDelete: DELETE con query, nessun body ──────────────────────────────
  reset(() => ({ text: '' }));
  await supa.sbDelete('conv', 'wa_id=eq.34600111222');
  assert('sbDelete: metodo DELETE', calls[0].method === 'DELETE');
  assert('sbDelete: nessun body inviato', calls[0].body === undefined);

  // ── sbInsert: POST con Prefer default ────────────────────────────────────
  reset(() => ({ text: '[{"id":1}]' }));
  await supa.sbInsert('suggerimenti', { testo: 'x' });
  assert('sbInsert: Prefer default = return=representation', calls[0].headers.Prefer === 'return=representation');

  // ── getConfig: costruisce {chiave: valore} da sbSelect("config") ────────
  reset(() => ({ text: '[{"chiave":"AUTO_RISPOSTA","valore":"TRUE"},{"chiave":"AI_FORZA","valore":"FALSE"}]' }));
  const cfg = await supa.getConfig();
  assert('getConfig: forma pubblica identica {chiave:valore}',
    cfg.AUTO_RISPOSTA === 'TRUE' && cfg.AI_FORZA === 'FALSE');

  // ── sbRpc: {httpStatus, ok, body} — nomi di campo storici (non {status}) ──
  reset(() => ({ ok: true, status: 200, text: '{"ok":true,"code":"DONE"}' }));
  const rpcOk = await supa.sbRpc('start_rider_trip', { orderId: '#001' });
  assert('sbRpc: URL = {base}/rest/v1/rpc/{fn}', calls[0].url === 'http://mock.local/rest/v1/rpc/start_rider_trip');
  assert('sbRpc: forma di ritorno storica {httpStatus, ok, body} (non {status})',
    rpcOk.httpStatus === 200 && rpcOk.ok === true && rpcOk.body.code === 'DONE');

  reset(() => ({ ok: false, status: 500, text: 'not json' }));
  const rpcFail = await supa.sbRpc('close_rider_trip', {});
  assert('sbRpc: JSON invalido → body:null (comportamento pre-H1A preservato, diverso da sbFetch)',
    rpcFail.httpStatus === 500 && rpcFail.ok === false && rpcFail.body === null);

  // ── audit.sbRest: {ok,status,body}, mai un throw ─────────────────────────
  reset(() => ({ ok: true, status: 201, text: '' }));
  const auditOk = await audit.sbRest('POST', 'auth_audit', { body: { event: 'login_ok' }, prefer: 'return=minimal' });
  assert('audit.sbRest: body:null su risposta vuota (comportamento storico, non testo grezzo)',
    auditOk.ok === true && auditOk.status === 201 && auditOk.body === null);

  reset(() => { throw new TypeError('network unreachable'); });
  const auditNetFail = await audit.sbRest('GET', 'auth_actors', {});
  assert('audit.sbRest: errore di rete → {ok:false,status:0,body:null} (mai un throw, comportamento storico)',
    auditNetFail.ok === false && auditNetFail.status === 0 && auditNetFail.body === null);

  // ── audit.sbRest: zero output console (contratto preesistente, non regredito) ──
  {
    const cm = ['log', 'warn', 'error', 'info', 'debug', 'trace']; const orig = {}; let cc = 0;
    for (const m of cm) { orig[m] = console[m]; console[m] = () => { cc++; }; }
    reset(() => ({ ok: true, status: 200, text: '[]' }));
    await audit.sbRest('GET', 'auth_actors', {});
    reset(() => { throw new Error('net down'); });
    await audit.sbRest('GET', 'auth_actors', {});
    for (const m of cm) console[m] = orig[m];
    assert('audit.sbRest: zero output console preservato (successo + errore)', cc === 0, `calls=${cc}`);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  delete global.fetch;
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + (e && e.stack || e));
  delete global.fetch;
  process.exit(1);
});
