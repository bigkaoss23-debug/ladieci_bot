// tests/createIdempotency.test.js
// ===============================================================
// CREATE-IDEMPOTENCY-COVERAGE-01 — copertura mancante (audit 2026-06-05).
// Verifica i percorsi anti-duplicato di creaOrdine:
//   A) replay sequenziale: stesso client_req_id → stesso id, idempotent:true
//   B) collisione concorrente 23505 su client_req_id → recupera il gemello
//   C) collisione PK su id (23505) → retry loop con nuovo tentativo
//   D) senza client_req_id → nessuna deduplica (due ordini distinti)
// Supabase mockato (require.cache). Nessun DB/rete.
// Eseguire: node tests/createIdempotency.test.js
// ===============================================================
"use strict";

const supabasePath = require.resolve("../src/utils/supabase");

// ── Stato del fake-DB, controllabile per scenario ────────────────────────────
let store = [];            // righe ordenes inserite
let crQueue = null;        // se array: risposte client_req_id-lookup in coda (shift)
let insertHook = null;     // (row, ordenesAttempt) => risultato override | undefined
let ordenesInserts = 0;    // contatore tentativi di insert su ordenes
let crLookups = 0;         // contatore lookup per client_req_id

function reset() {
  store = []; crQueue = null; insertHook = null; ordenesInserts = 0; crLookups = 0;
}

require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    sbSelect: async (table, query = "") => {
      if (table === "config") return [];
      if (table === "clientes") return [];
      if (table === "ordenes") {
        const m = query.match(/client_req_id=eq\.([^&]+)/);
        if (m) {
          crLookups++;
          if (Array.isArray(crQueue)) return crQueue.length ? crQueue.shift() : [];
          const cr = decodeURIComponent(m[1]);
          return store.filter(o => o.client_req_id === cr).map(o => ({ id: o.id }));
        }
        // max-id lookup (ts=gte...&select=id oppure select=id)
        if (query.includes("select=id")) return store.map(o => ({ id: o.id }));
        return [];
      }
      return [];
    },
    sbInsert: async (table, row) => {
      if (table !== "ordenes") return [{ ...row }];   // clientes/logs ecc.
      ordenesInserts++;
      if (insertHook) {
        const r = insertHook(row, ordenesInserts);
        if (r !== undefined) return r;
      }
      if (store.some(o => o.id === row.id)) {
        return { code: "23505", details: "duplicate key value violates unique constraint ordenes_pkey" };
      }
      if (row.client_req_id && store.some(o => o.client_req_id === row.client_req_id)) {
        return { code: "23505", details: "duplicate key value violates unique constraint ordenes_client_req_id_key" };
      }
      store.push({ ...row });
      return [{ ...row }];
    },
    sbUpdate: async () => [],
    sbUpsert: async () => [],
    sbDelete: async () => [],
    getConfig: async () => ({}),
  },
};

const { creaOrdine } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const section = (s) => console.log(`\n── ${s} ──`);
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};

// Ordine RITIRO + operatorManual:true → niente geo-resolve, niente closing-guard,
// niente risincronizzaGiro; cliente_id passato → niente upsert cliente.
const baseOrder = (extra = {}) => ({
  tipo_consegna: "RITIRO", operatorManual: true, cliente_id: 1,
  nombre: "T", tel: "", hora: "21:00", estado: "NUEVO",
  items: [{ n: "Margherita", p: 8, q: 1 }], ...extra,
});

(async () => {
  // ── A) replay sequenziale: stesso client_req_id ────────────────────────────
  section("A) replay sequenziale (stesso client_req_id)");
  {
    reset();
    const r1 = await creaOrdine(baseOrder({ client_req_id: "req-abc" }));
    const r2 = await creaOrdine(baseOrder({ client_req_id: "req-abc" }));
    assert("1ª creazione success", r1.success === true, JSON.stringify(r1));
    assert("1ª NON idempotente", !r1.idempotent);
    assert("2ª ritorna stesso id", r2.success === true && r2.id === r1.id, `${r1.id} vs ${r2.id}`);
    assert("2ª marcata idempotent", r2.idempotent === true, JSON.stringify(r2));
    assert("inserito UNA sola volta su ordenes", ordenesInserts === 1, `inserts=${ordenesInserts}`);
    assert("client_req_id persistito sulla riga", store[0]?.client_req_id === "req-abc");
  }

  // ── B) collisione concorrente: 23505 su client_req_id ──────────────────────
  section("B) collisione concorrente (23505 su client_req_id)");
  {
    reset();
    // precheck NON vede il gemello (race), recovery SÌ → id #077
    crQueue = [[], [{ id: "#077" }]];
    insertHook = () => ({ code: "23505", details: "duplicate key ... ordenes_client_req_id_key" });
    const r = await creaOrdine(baseOrder({ client_req_id: "req-xyz" }));
    assert("recupera id del gemello", r.success === true && r.id === "#077", JSON.stringify(r));
    assert("marcato idempotent", r.idempotent === true);
    assert("nessuna riga creata da noi", store.length === 0, `store=${store.length}`);
    assert("due lookup client_req_id (precheck + recovery)", crLookups === 2, `crLookups=${crLookups}`);
  }

  // ── C) collisione PK su id (23505) → retry ─────────────────────────────────
  section("C) collisione PK su id → retry");
  {
    reset();
    // 1° tentativo: collisione PK (id) → continue; 2° tentativo: passa
    insertHook = (row, attempt) => attempt === 1
      ? { code: "23505", details: "duplicate key value violates unique constraint ordenes_pkey" }
      : undefined;
    const r = await creaOrdine(baseOrder());
    assert("creazione riuscita dopo retry", r.success === true && !!r.id, JSON.stringify(r));
    assert("ha ritentato l'insert (2 tentativi)", ordenesInserts === 2, `inserts=${ordenesInserts}`);
    assert("una sola riga finale", store.length === 1, `store=${store.length}`);
    assert("PK collision NON marcata idempotent", !r.idempotent);
  }

  // ── D) senza client_req_id → nessuna deduplica ─────────────────────────────
  section("D) senza client_req_id (nessuna deduplica)");
  {
    reset();
    const r1 = await creaOrdine(baseOrder());
    const r2 = await creaOrdine(baseOrder());
    assert("due creazioni riuscite", r1.success && r2.success);
    assert("id distinti (#001, #002)", r1.id !== r2.id, `${r1.id} vs ${r2.id}`);
    assert("nessun lookup client_req_id eseguito", crLookups === 0, `crLookups=${crLookups}`);
    assert("due righe distinte create", store.length === 2, `store=${store.length}`);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
