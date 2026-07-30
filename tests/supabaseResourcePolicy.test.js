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

global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });

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

  // ── 4) metodo vietato ────────────────────────────────────────────────────
  assert('4. metodo vietato (ordenes DELETE, mai usato da un call site reale)', !policy.isMethodAllowed('ordenes', 'DELETE'));
  {
    const err = await captureErr(() => transport.supabaseRequest({ resource: 'ordenes', method: 'DELETE', operation: 'test' }));
    assert('4b. metodo vietato nel transport → SUPABASE_METHOD_NOT_ALLOWED',
      err && err.code === transport.ERROR_CODES.METHOD_NOT_ALLOWED);
  }

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

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  delete global.fetch;
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + (e && e.stack || e));
  delete global.fetch;
  process.exit(1);
});
