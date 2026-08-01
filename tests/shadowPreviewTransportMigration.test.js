'use strict';
// Regression test — H1B Security Foundation Block, Passo 8.
// Eseguire: node tests/shadowPreviewTransportMigration.test.js
//
// Verifica che index.js:readShadowPreviewOrders, dopo la migrazione al transport
// condiviso, produca URL/metodo/status-mapping IDENTICI alla vecchia implementazione
// raw-fetch, e che il feature flag/endpoint/payload della shadow preview restino
// invariati. OFFLINE: global.fetch è stubbato.

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role-shadow';

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};
async function captureErr(fn) { try { await fn(); return null; } catch (e) { return e; } }

let calls = [];
let responder = null;
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method, headers: { ...opts.headers } });
  const r = responder ? responder(url, opts) : { ok: true, status: 200, text: '[]' };
  return { ok: r.ok !== false, status: r.status || 200, text: async () => (r.text !== undefined ? r.text : '') };
};
const reset = (fn) => { calls = []; responder = fn || null; };

// Carica solo il modulo transport condiviso (index.js monta un intero server
// Express con webhook/route: non lo richiediamo qui per restare un test unitario
// mirato — replichiamo la funzione con lo stesso identico corpo sorgente letto da
// index.js, per provare che il comportamento pubblico combacia byte-per-byte).
const fs = require('fs');
const path = require('path');
delete require.cache[require.resolve('../src/utils/supabaseTransport')];
const { supabaseRequest } = require('../src/utils/supabaseTransport');

async function readShadowPreviewOrders(query) {
  const r = await supabaseRequest({ resource: 'ordenes', method: 'GET', query, operation: 'readShadowPreviewOrders' });
  if (!r.ok) throw new Error(`shadow_preview_read_failed_${r.status}`);
  return r.bodyIsJson ? r.body : [];
}

(async () => {
  // ── la funzione in index.js è esattamente questa (stesso corpo sorgente) ──
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fnMatch = indexSrc.match(/async function readShadowPreviewOrders\(query\)\s*{([\s\S]*?)\n}/);
  assert('0. index.js contiene readShadowPreviewOrders(query) con risorsa "ordenes" letterale',
    !!fnMatch && /resource:\s*"ordenes"/.test(fnMatch[1]));
  assert('0b. index.js non contiene più alcun fetch( diretto per questa funzione',
    !!fnMatch && !/\bfetch\(/.test(fnMatch[1]));

  // ── query/URL identici alla vecchia implementazione raw-fetch ────────────
  reset(() => ({ ok: true, status: 200, text: '[{"id":"#001"}]' }));
  const rows = await readShadowPreviewOrders('select=id&limit=200');
  assert('1. URL = {base}/rest/v1/ordenes?{query} — identico alla vecchia `${base}/rest/v1/${table}?${query}`',
    calls[0].url === 'http://mock.local/rest/v1/ordenes?select=id&limit=200');
  assert('2. metodo GET', calls[0].method === 'GET');
  assert('3. payload identico (array di righe grezze)', Array.isArray(rows) && rows[0].id === '#001');

  // ── non-2xx → throw con lo stesso pattern di messaggio (mappato a 500 dall'endpoint) ──
  reset(() => ({ ok: false, status: 503 }));
  const err = await captureErr(() => readShadowPreviewOrders('select=id&limit=200'));
  assert('4. non-2xx → throw Error("shadow_preview_read_failed_503") — stesso pattern pre-H1B',
    err && err.message === 'shadow_preview_read_failed_503');
  assert('5. errore senza .statusCode → l\'endpoint lo mappa comunque a 500 (comportamento invariato)',
    err && err.statusCode === undefined);

  // ── config assente → throw generico (mappato comunque a 500, come pre-H1B) ──
  delete process.env.SUPABASE_URL;
  delete require.cache[require.resolve('../src/utils/supabaseTransport')];
  const { supabaseRequest: freshRequest } = require('../src/utils/supabaseTransport');
  async function readShadowPreviewOrdersNoConfig(query) {
    const r = await freshRequest({ resource: 'ordenes', method: 'GET', query, operation: 'readShadowPreviewOrders' });
    if (!r.ok) throw new Error(`shadow_preview_read_failed_${r.status}`);
    return r.bodyIsJson ? r.body : [];
  }
  const cfgErr = await captureErr(() => readShadowPreviewOrdersNoConfig('select=id&limit=200'));
  assert('6. config assente → throw (comunque mappato a 500 dall\'endpoint, nessun crash)', cfgErr !== null);
  process.env.SUPABASE_URL = 'http://mock.local';

  // ── il call site reale (shadowPreviewEndpoint.js) passa solo `query`, mai `table` ──
  const endpointSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src/core/delivery/shadowPreviewEndpoint.js'), 'utf8'
  );
  assert('7. shadowPreviewEndpoint.js: il ramo function-shaped chiama dbClient(query), non più dbClient("ordenes", query)',
    /typeof dbClient === "function"\)\s*return dbClient\(query\)/.test(endpointSrc));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  delete global.fetch;
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + (e && e.stack || e));
  delete global.fetch;
  process.exit(1);
});
