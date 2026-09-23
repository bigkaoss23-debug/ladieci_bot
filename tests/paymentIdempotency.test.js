// tests/paymentIdempotency.test.js — [PAYMENT-IDEMPOTENCY 2026-09-23]
// Separazione FINALIZZAZIONE (idempotente) / CORREZIONE METODO (esplicita + audit).
// Difetto d'origine (torture test 2026-09-23): #007 RITIRO finalizzato bizum, tab
// stale ripete RETIRADO con efectivo → risposta noop:true MA metodo_pago bizum→efectivo,
// nessun log, Caja sposta €16,50 da Bizum a Efectivo.
// Eseguire: node tests/paymentIdempotency.test.js
// Nessuna rete, nessun DB: supabase stubbato via require.cache, PATCH modellato con
// filtri + return=representation (helpers/postgrestPatch). La concorrenza REALE
// (PostgreSQL 17 + PostgREST 16.3, lock di riga) è nella suite pay/payment_real.mjs
// dell'harness fuori repo: Downloads/payment_real_harness_2026-09-23.tgz.
delete process.env.FDV1_RIDER_TELEMETRY;

const assert = require("assert");
const { applyPatch } = require("./helpers/postgrestPatch");

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let STORE = {}, UPDATED = [], LOGS = [], INSERTS = [], failLog = false;
// agentOrdini destruttura sbSelect/sbUpdate al require: per iniettare guasti a
// metà test servono hook letti dallo stub, non una riassegnazione di supa.*.
let afterSelectHook = null, updateOverride = null, onFailedLog = null;
supa.sbSelect = async (table, query = "") => {
  const r = await selectRaw(table, query);
  if (afterSelectHook) afterSelectHook(table, query);
  return r;
};
async function selectRaw(table, query) {
  if (table === "ordenes") {
    const m = query.match(/(?:^|&)id=eq\.([^&]+)/);
    if (m) { const id = decodeURIComponent(m[1]); return STORE[id] ? [{ ...STORE[id] }] : []; }
    return [];
  }
  return [];
}
// RPC payment_method_change_v1: il test fissa la risposta (rpcAnswer) e registra gli
// argomenti. La SEMANTICA transazionale della funzione si verifica su Postgres reale
// (pay/payment_real.mjs), non qui: uno stub JS non può dimostrare un rollback.
let RPC_CALLS = [], rpcAnswer = null;
supa.sbInsert = async (table, row) => {
  if (table.startsWith("rpc/")) {
    RPC_CALLS.push({ fn: table.slice(4), args: { ...row } });
    if (typeof rpcAnswer === "function") return rpcAnswer(row);
    if (rpcAnswer instanceof Error) throw rpcAnswer;
    return rpcAnswer;
  }
  if (table === "orden_estado_logs") {
    if (failLog) { if (onFailedLog) onFailedLog(row); return { code: "42501", message: "simulated audit insert failure" }; }
    const saved = { id: `log-${LOGS.length + 1}`, created_at: new Date().toISOString(), ...row };
    LOGS.push(saved);
    return [saved];
  }
  INSERTS.push({ table, row });
  return [row];
};
supa.sbUpdate = async (table, filter, patch, prefer) => {
  if (table !== "ordenes") return "";
  if (updateOverride) return updateOverride(filter, patch, prefer);
  UPDATED.push({ filter, patch });
  return applyPatch(STORE, filter, patch, prefer);
};
supa.sbUpsert = async () => "";
supa.sbDelete = async () => "";

const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ success: true });
require.cache[mgPath].exports.getManualGiros = async () => [];
const geoPath = require.resolve("../src/utils/geoResolver");
require(geoPath);
require.cache[geoPath].exports.risolviIndirizzo = async () => ({ zona: null, lat: null, lon: null, durataAndataMin: null, googleMin: null, haversineMin: null, source: null, cached: false, fuoriZona: false, error: null });

const { cambiaStato, cambiaMetodoPago, creaOrdine } = require("../src/agents/agentOrdini");
const { computeSummary } = require("../src/utils/servizio");

const METODOS = ["efectivo", "tarjeta", "bizum"];
let passed = 0, failed = 0;
const reset = () => { STORE = {}; UPDATED = []; LOGS = []; INSERTS = []; failLog = false; afterSelectHook = null; updateOverride = null; onFailedLog = null; RPC_CALLS = []; rpcAnswer = null; };
const ord = (id, o = {}) => (STORE[id] = {
  id, estado: "LISTO", tipo_consegna: "RITIRO", hora: "21:00", ts: 1,
  items: [{ n: "Margherita", q: 2, p: 8.25, cat: "Pizzas" }], totale: 16.5, delivery_fee: 0,
  ya_pagado: false, cobrado: false, metodo_pago: "", manual_giro_id: null,
  descuento_tipo: null, descuento_valor: null, descuento_importe: null,
  retirado_at: null, updated_at: null, hora_entrega: null, ...o,
});
// Impronta dell'intera riga: qualunque byte cambi, cambia l'impronta.
const fp = (id) => JSON.stringify(Object.keys(STORE[id]).sort().map((k) => [k, STORE[id][k]]));
// Impronta dei soli campi che NON devono mai muoversi con una correzione metodo.
const FIN_INVARIANT = ["estado", "totale", "items", "tipo_consegna", "delivery_fee", "ya_pagado",
  "descuento_tipo", "descuento_valor", "descuento_importe", "retirado_at", "hora_entrega", "hora", "ts"];
const fpInv = (id) => JSON.stringify(FIN_INVARIANT.map((k) => [k, STORE[id][k]]));
async function t(name, fn) {
  reset();
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + " — " + (e && e.message)); failed++; }
}

(async () => {
  console.log("PAYMENT IDEMPOTENCY — finalizzazione idempotente / correzione esplicita");

  // ── A. FINALIZZAZIONE ────────────────────────────────────────────────────────
  for (const m of METODOS) {
    await t(`finalizzazione non pagato ${m}: cobrado=true, metodo=${m}, 1 log`, async () => {
      ord("#A");
      const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: m, actor_type: "operator", origin: "dashboard" });
      assert.ok(r.success && !r.noop, JSON.stringify(r));
      assert.strictEqual(STORE["#A"].estado, "RETIRADO");
      assert.strictEqual(STORE["#A"].cobrado, true);
      assert.strictEqual(STORE["#A"].metodo_pago, m);
      assert.strictEqual(LOGS.length, 1);
      assert.strictEqual(LOGS[0].event_type, "picked_up");
    });
  }

  await t("finalizzazione non pagato SENZA metodo → rifiutata, nessuna scrittura", async () => {
    ord("#A");
    const before = fp("#A");
    const r = await cambiaStato("#A", "RETIRADO", { actor_type: "operator", origin: "dashboard" });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, "payment_method_required");
    assert.strictEqual(fp("#A"), before);
    assert.strictEqual(UPDATED.length, 0);
    assert.strictEqual(LOGS.length, 0);
  });

  await t('finalizzazione con "manual" → rifiutata', async () => {
    ord("#A");
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "manual" });
    assert.strictEqual(r.error, "payment_method_required");
    assert.strictEqual(STORE["#A"].metodo_pago, "");
  });

  // Duplicato identico (double click / retry): no-op, impronta byte-identica.
  for (const m of METODOS) {
    await t(`RETIRADO duplicato ${m}+${m}: noop puro, impronta identica`, async () => {
      ord("#A");
      await cambiaStato("#A", "RETIRADO", { metodo_pago: m });
      const before = fp("#A"), nUpd = UPDATED.length, nLog = LOGS.length;
      const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: m });
      assert.ok(r.success && r.noop === true, JSON.stringify(r));
      assert.strictEqual(fp("#A"), before, "la riga è cambiata");
      assert.strictEqual(UPDATED.length, nUpd, "UPDATE su un noop");
      assert.strictEqual(LOGS.length, nLog, "log su un noop");
    });
  }

  // Stale con metodo diverso: la matrice completa 3×2.
  for (const first of METODOS) for (const stale of METODOS.filter((x) => x !== first)) {
    await t(`stale: finalizzato ${first}, ripetuto ${stale} → noop, resta ${first}`, async () => {
      ord("#A");
      await cambiaStato("#A", "RETIRADO", { metodo_pago: first });
      const before = fp("#A"), nUpd = UPDATED.length, nLog = LOGS.length;
      for (const path of ["updateEstado", "marcarEntregado"]) {
        const r = await cambiaStato("#A", "RETIRADO", path === "marcarEntregado"
          ? { hora_entrega: Date.now(), metodo_pago: stale, actor_type: "rider", origin: "driver_app" }
          : { metodo_pago: stale, actor_type: "operator", origin: "dashboard" });
        assert.ok(r.success && r.noop === true, path + " " + JSON.stringify(r));
      }
      assert.strictEqual(STORE["#A"].metodo_pago, first);
      assert.strictEqual(fp("#A"), before);
      assert.strictEqual(UPDATED.length, nUpd);
      assert.strictEqual(LOGS.length, nLog);
    });
  }

  await t("stale con descuento su ordine RETIRADO: noop, totale invariato", async () => {
    ord("#A");
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "bizum" });
    const before = fp("#A");
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", descuento_tipo: "eur", descuento_valor: 5 });
    assert.ok(r.noop === true);
    assert.strictEqual(fp("#A"), before);
    assert.strictEqual(STORE["#A"].totale, 16.5);
  });

  // Già pagato (ya_pagado): nessun secondo pagamento, metodo intatto.
  for (const m of METODOS) {
    await t(`già pagato ${m}: finalizzazione con metodo diverso non lo sovrascrive`, async () => {
      ord("#A", { ya_pagado: true, metodo_pago: m });
      const other = METODOS.find((x) => x !== m);
      const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: other });
      assert.ok(r.success && !r.noop, JSON.stringify(r));
      assert.strictEqual(STORE["#A"].metodo_pago, m);
      assert.strictEqual(STORE["#A"].cobrado, true);
      assert.strictEqual(LOGS.length, 1);
      const before = fp("#A");
      const r2 = await cambiaStato("#A", "RETIRADO", {});
      assert.ok(r2.noop === true);
      assert.strictEqual(fp("#A"), before);
    });
  }

  await t("già pagato senza metodo in ingresso: finalizza, metodo intatto", async () => {
    ord("#A", { ya_pagado: true, metodo_pago: "bizum" });
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "" });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(STORE["#A"].metodo_pago, "bizum");
  });

  // Corsa: due finalizzazioni che leggono entrambe LISTO prima di scrivere.
  for (const [a, b] of [["bizum", "bizum"], ["bizum", "efectivo"], ["tarjeta", "bizum"]]) {
    await t(`corsa finalizzazioni ${a} ‖ ${b}: una scrive, l'altra noop, 1 log`, async () => {
      ord("#A");
      const [r1, r2] = await Promise.all([
        cambiaStato("#A", "RETIRADO", { metodo_pago: a }),
        cambiaStato("#A", "RETIRADO", { metodo_pago: b }),
      ]);
      const winners = [r1, r2].filter((r) => r.success && !r.noop);
      const noops = [r1, r2].filter((r) => r.success && r.noop === true);
      assert.strictEqual(winners.length, 1, JSON.stringify([r1, r2]));
      assert.strictEqual(noops.length, 1, JSON.stringify([r1, r2]));
      assert.strictEqual(STORE["#A"].metodo_pago, winners[0] === r1 ? a : b);
      assert.strictEqual(LOGS.length, 1);
      // la PATCH del perdente è stata emessa ma NON ha colpito righe
      assert.ok(UPDATED.every((u) => /estado=eq\.LISTO/.test(u.filter)));
    });
  }

  await t("finalizzazione persa contro Volver a cocina: errore, nessuna scrittura", async () => {
    ord("#A");
    // Tra lettura e scrittura l'ordine torna in cucina (altro device).
    let first = true;
    afterSelectHook = (tbl) => { if (first && tbl === "ordenes") { first = false; STORE["#A"].estado = "EN_COCINA"; } };
    {
      const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo" });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.error, "state_changed_concurrently");
      assert.strictEqual(STORE["#A"].estado, "EN_COCINA");
      assert.strictEqual(STORE["#A"].metodo_pago, "");
      assert.strictEqual(LOGS.length, 0);
    }
  });

  await t("PostgREST non conferma la PATCH (errore) → db_error, nessun log", async () => {
    ord("#A");
    updateOverride = async () => ({ code: "57014", message: "canceling statement" });
    {
      const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo" });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.error, "db_error");
      assert.strictEqual(LOGS.length, 0);
    }
  });

  // Campi pagamento fuori da RETIRADO: ignorati (prima: qualunque stringa, senza audit).
  await t("updateEstado LISTO con metodo_pago/cobrado/ya_pagado: ignorati", async () => {
    ord("#A", { estado: "EN_COCINA" });
    const r = await cambiaStato("#A", "LISTO", { metodo_pago: "manual", cobrado: true, ya_pagado: true });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(STORE["#A"].estado, "LISTO");
    assert.strictEqual(STORE["#A"].metodo_pago, "");
    assert.strictEqual(STORE["#A"].cobrado, false);
    assert.strictEqual(STORE["#A"].ya_pagado, false);
    assert.ok(UPDATED.every((u) => !("metodo_pago" in u.patch) && !("cobrado" in u.patch) && !("ya_pagado" in u.patch)));
  });

  // ── B. CORREZIONE ESPLICITA = UNA chiamata alla funzione DB atomica ─────────
  const retirado = (id, m, o = {}) => ord(id, { estado: "RETIRADO", cobrado: true, metodo_pago: m, retirado_at: "2026-09-23T19:00:00.000Z", ...o });

  await t("correzione: una sola RPC payment_method_change_v1 con argomenti normalizzati, nessuna PATCH/INSERT diretta", async () => {
    retirado("#A", "efectivo");
    rpcAnswer = { ok: true, noop: false, metodo_pago: "tarjeta", metodo_pago_anterior: "efectivo", audit_id: "u1", audit_at: "2026-09-23T20:00:00Z" };
    const r = await cambiaMetodoPago("#A", { metodo_pago: " Tarjeta ", metodo_pago_esperado: "EFECTIVO", actor_type: "operator", actor_id: "op1", origin: "dashboard" });
    assert.deepStrictEqual(r, { success: true, id: "#A", metodo_pago: "tarjeta", metodo_pago_anterior: "efectivo", audit_id: "u1" });
    assert.strictEqual(RPC_CALLS.length, 1);
    assert.deepStrictEqual(RPC_CALLS[0], { fn: "payment_method_change_v1", args: {
      p_order_id: "#A", p_new_method: "tarjeta", p_expected_method: "efectivo",
      p_actor_type: "operator", p_actor_id: "op1", p_origin: "dashboard", p_reason: "payment_method_correction" } });
    assert.strictEqual(UPDATED.length, 0, "nessuna PATCH ordenes dal JS");
    assert.strictEqual(LOGS.length, 0, "nessun INSERT audit dal JS");
    assert.strictEqual(STORE["#A"].metodo_pago, "efectivo", "il JS non tocca la riga");
  });

  await t("metodo atteso assente → passato come null (la funzione risponde expected_method_required)", async () => {
    rpcAnswer = { ok: false, error: "expected_method_required" };
    const r = await cambiaMetodoPago("#A", { metodo_pago: "bizum" });
    assert.strictEqual(RPC_CALLS[0].args.p_expected_method, null);
    assert.deepStrictEqual(r, { success: false, error: "expected_method_required" });
  });

  await t("atteso vuoto (legacy senza metodo) → stringa vuota, non null", async () => {
    rpcAnswer = { ok: true, noop: false, metodo_pago: "bizum", metodo_pago_anterior: null, audit_id: "u2" };
    await cambiaMetodoPago("#A", { metodo_pago: "bizum", metodo_pago_esperado: "" });
    assert.strictEqual(RPC_CALLS[0].args.p_expected_method, "");
  });

  await t("noop della funzione → success+noop, nessun audit_id", async () => {
    rpcAnswer = { ok: true, noop: true, metodo_pago: "tarjeta" };
    const r = await cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" });
    assert.deepStrictEqual(r, { success: true, id: "#A", metodo_pago: "tarjeta", noop: true });
  });

  for (const [err, extra] of [["payment_method_conflict", { metodo_pago_actual: "bizum", metodo_pago_esperado: "efectivo" }],
    ["payment_change_requires_retirado", { estado_actual: "LISTO" }], ["not_found", {}]]) {
    await t(`esito tipato ${err} passato al FE senza trasformazioni`, async () => {
      rpcAnswer = { ok: false, error: err, ...extra };
      const r = await cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" });
      assert.deepStrictEqual(r, { success: false, error: err, ...extra });
    });
  }

  for (const bad of ["manual", "", null, undefined, "paypal", "EFECTIVO!"]) {
    await t(`metodo non valido (${JSON.stringify(bad)}) → rifiutato senza chiamare il DB`, async () => {
      const r = await cambiaMetodoPago("#A", { metodo_pago: bad, metodo_pago_esperado: "efectivo" });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.error, "payment_method_required");
      assert.strictEqual(RPC_CALLS.length, 0);
    });
  }

  // Trasporto: stessi esiti di giroRpc (misurati sul PostgREST reale), nomi di dominio pagamento.
  for (const [name, answer, expErr, unknown] of [
    ["funzione assente (PGRST202)", { code: "PGRST202", message: "Could not find the function" }, "payment_atomic_unavailable", undefined],
    ["errore definito pre-COMMIT (42501)", { code: "42501", message: "permission denied for table orden_estado_logs" }, "db_error", false],
    ["corpo non JSON (gateway 502 HTML)", "<html>502</html>", "payment_outcome_unknown", true],
    ["socket reset", Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }), "payment_outcome_unknown", true],
    ["connessione mai stabilita", Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "db_error", false],
  ]) {
    await t(`trasporto: ${name} → ${expErr}`, async () => {
      rpcAnswer = answer;
      const r = await cambiaMetodoPago("#A", { metodo_pago: "bizum", metodo_pago_esperado: "efectivo" });
      assert.strictEqual(r.success, false, JSON.stringify(r));
      assert.strictEqual(r.error, expErr, JSON.stringify(r));
      if (unknown !== undefined) assert.strictEqual(r.outcome_unknown === true, unknown, JSON.stringify(r));
      assert.strictEqual(UPDATED.length + LOGS.length, 0, "nessuna scrittura compensativa");
    });
  }

  await t("nessun revert applicativo esiste più nel codice della correzione", async () => {
    const src = require("fs").readFileSync(require.resolve("../src/agents/agentOrdini.js"), "utf8");
    const body = src.slice(src.indexOf("async function cambiaMetodoPago"), src.indexOf("async function aggiungiItems"));
    assert.ok(!/sbUpdate|sbInsert\(|revert|logOrderStateTransition/.test(body), "la correzione deve essere solo la RPC");
  });

  // ── Creazione: Ya pagado ────────────────────────────────────────────────────
  const baseNew = { operatorManual: true, nombre: "ZZTEST", tipo_consegna: "RITIRO", hora: "21:00", items: [{ n: "Margherita", q: 1, p: 9 }] };
  const lastOrdenInsert = () => INSERTS.filter((i) => i.table === "ordenes").at(-1);
  for (const m of METODOS) {
    await t(`creazione Ya pagado ${m}: ya_pagado=true, metodo=${m}`, async () => {
      const r = await creaOrdine({ ...baseNew, ya_pagado: true, metodo_pago: " " + m.toUpperCase() + " " });
      assert.ok(r.success, JSON.stringify(r));
      const row = lastOrdenInsert().row;
      assert.strictEqual(row.ya_pagado, true);
      assert.strictEqual(row.metodo_pago, m);
    });
  }
  for (const bad of ["", "manual", undefined, "paypal"]) {
    await t(`creazione Ya pagado con metodo ${JSON.stringify(bad)} → rifiutata PRIMA di scrivere`, async () => {
      const r = await creaOrdine({ ...baseNew, ya_pagado: true, metodo_pago: bad });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.error, "payment_method_required");
      assert.strictEqual(INSERTS.length, 0, "scritture prima del rifiuto");
      assert.strictEqual(UPDATED.length, 0);
    });
  }
  await t("creazione NON pagata con metodo nel payload: metodo scartato", async () => {
    const r = await creaOrdine({ ...baseNew, ya_pagado: false, metodo_pago: "efectivo" });
    assert.ok(r.success);
    assert.strictEqual(lastOrdenInsert().row.metodo_pago, "");
    assert.strictEqual(lastOrdenInsert().row.ya_pagado, false);
  });

  // ── RICONCILIAZIONE CAJA (computeSummary = chiusura serata / serata_summary) ──
  await t("riconciliazione Caja: fixture A–F, correzione A efectivo→bizum, poi stale", async () => {
    // A/B/C pagati alla finalizzazione, D/E/F Ya pagado alla creazione.
    const fx = [
      ["#A", "efectivo", false, 16.5, "RITIRO", [{ n: "Margherita", q: 2, p: 8.25, cat: "Pizzas" }]],
      ["#B", "tarjeta", false, 21.0, "DOMICILIO", [{ n: "Diavola", q: 2, p: 9.25, cat: "Pizzas" }]],
      ["#C", "bizum", false, 12.0, "RITIRO", [{ n: "Tiramisu", q: 2, p: 6, cat: "Postres" }]],
      ["#D", "efectivo", true, 10.0, "RITIRO", [{ n: "Margherita", q: 1, p: 8, cat: "Pizzas" }, { n: "Agua", q: 1, p: 2, cat: "Bebidas" }]],
      ["#E", "tarjeta", true, 13.75, "DOMICILIO", [{ n: "Quattro", q: 1, p: 11.25, cat: "Pizzas" }]],
      ["#F", "bizum", true, 9.5, "RITIRO", [{ n: "Coca", q: 1, p: 2.5, cat: "Bebidas" }, { n: "Nutella", q: 1, p: 7, cat: "Postres" }]],
    ];
    for (const [id, m, ya, tot, tipo, items] of fx) {
      ord(id, { tipo_consegna: tipo, totale: tot, items, ya_pagado: ya, metodo_pago: ya ? m : "", tel: id });
      const r = await cambiaStato(id, "RETIRADO", ya ? {} : { metodo_pago: m });
      assert.ok(r.success && !r.noop, id + " " + JSON.stringify(r));
    }
    const S = async () => computeSummary(Object.values(STORE), "2026-09-23", "mer", "test");
    const s0 = await S();
    assert.strictEqual(s0.cassa_totale, 82.75);
    assert.strictEqual(s0.cassa_efectivo, 26.5);
    assert.strictEqual(s0.cassa_tarjeta, 34.75);
    assert.strictEqual(s0.cassa_bizum, 21.5);
    assert.strictEqual(s0.cassa_non_specificato, 0);
    assert.ok(Object.values(STORE).every((o) => o.cobrado === true && o.estado === "RETIRADO"), "unpaid residuo");
    const collected = Object.values(STORE).filter((o) => o.cobrado).reduce((s, o) => s + o.totale, 0);
    assert.strictEqual(Math.round(collected * 100) / 100, 82.75);

    // modello in memoria della funzione (UPDATE + audit insieme); la versione vera gira su PG reale
    rpcAnswer = (a) => {
      const o = STORE[a.p_order_id]; const from = o.metodo_pago;
      o.metodo_pago = a.p_new_method; o.cobrado = true;
      LOGS.push({ event_type: "payment_method_changed", orden_id: a.p_order_id, metadata: { metodo_pago_from: from, metodo_pago_to: a.p_new_method } });
      return { ok: true, noop: false, metodo_pago: a.p_new_method, metodo_pago_anterior: from, audit_id: "u" };
    };
    const r = await cambiaMetodoPago("#A", { metodo_pago: "bizum", metodo_pago_esperado: "efectivo" });
    assert.ok(r.success, JSON.stringify(r));
    const s1 = await S();
    assert.strictEqual(s1.cassa_totale, s0.cassa_totale, "gross cambiato");
    assert.strictEqual(s1.cassa_efectivo, Math.round((s0.cassa_efectivo - 16.5) * 100) / 100);
    assert.strictEqual(s1.cassa_bizum, Math.round((s0.cassa_bizum + 16.5) * 100) / 100);
    assert.strictEqual(s1.cassa_tarjeta, s0.cassa_tarjeta);
    for (const k of ["n_ordini", "n_pizze", "n_bevande", "n_dessert", "n_delivery", "n_ritiro", "delivery_fee_totale"]) {
      assert.strictEqual(s1[k], s0[k], k);
    }
    assert.deepStrictEqual(s1.per_zona, s0.per_zona);
    assert.deepStrictEqual(s1.per_fascia, s0.per_fascia);
    assert.strictEqual(STORE["#A"].cobrado, true);
    assert.strictEqual(LOGS.filter((l) => l.event_type === "payment_method_changed").length, 1);

    // Stale RETIRADO con un terzo metodo su A (e con il vecchio su tutti): nulla cambia.
    const snap = JSON.stringify(STORE), nLog = LOGS.length;
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "tarjeta" });
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo" });
    for (const [id] of fx) await cambiaStato(id, "RETIRADO", { metodo_pago: "efectivo" });
    const s2 = await S();
    delete s1.ts_chiusura; delete s2.ts_chiusura;
    assert.deepStrictEqual(s2, s1, "Caja cambiata da una RETIRADO stale");
    assert.strictEqual(JSON.stringify(STORE), snap);
    assert.strictEqual(LOGS.length, nLog);
  });

  console.log(`\n  passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
