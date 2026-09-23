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
supa.sbInsert = async (table, row) => {
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
const reset = () => { STORE = {}; UPDATED = []; LOGS = []; INSERTS = []; failLog = false; afterSelectHook = null; updateOverride = null; onFailedLog = null; };
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

  // ── B. CORREZIONE ESPLICITA ─────────────────────────────────────────────────
  const retirado = (id, m, o = {}) => ord(id, { estado: "RETIRADO", cobrado: true, metodo_pago: m, retirado_at: "2026-09-23T19:00:00.000Z", ...o });

  for (const [from, to] of [["efectivo", "tarjeta"], ["tarjeta", "bizum"], ["bizum", "efectivo"]]) {
    await t(`correzione esplicita ${from} → ${to}: muta SOLO il metodo, audit presente`, async () => {
      retirado("#A", from);
      const inv = fpInv("#A");
      const r = await cambiaMetodoPago("#A", { metodo_pago: to, metodo_pago_esperado: from, actor_type: "operator", origin: "dashboard" });
      assert.ok(r.success && !r.noop, JSON.stringify(r));
      assert.strictEqual(STORE["#A"].metodo_pago, to);
      assert.strictEqual(STORE["#A"].cobrado, true);
      assert.strictEqual(fpInv("#A"), inv, "campi finanziari/di stato cambiati");
      assert.strictEqual(UPDATED.length, 1);
      assert.deepStrictEqual(Object.keys(UPDATED[0].patch).sort(), ["metodo_pago", "updated_at"]);
      assert.strictEqual(LOGS.length, 1);
      const L = LOGS[0];
      assert.strictEqual(L.orden_id, "#A");
      assert.strictEqual(L.event_type, "payment_method_changed");
      assert.strictEqual(L.estado_from, "RETIRADO");
      assert.strictEqual(L.estado_to, "RETIRADO");
      assert.strictEqual(L.actor_type, "operator");
      assert.strictEqual(L.origin, "dashboard");
      assert.strictEqual(L.metadata.metodo_pago_from, from);
      assert.strictEqual(L.metadata.metodo_pago_to, to);
      assert.strictEqual(L.metadata.reason, "payment_method_correction");
      assert.strictEqual(L.metadata.tipo_consegna, "RITIRO");
      assert.ok(!("created_at" in UPDATED[0].patch), "il timestamp dell'audit lo mette il server");
    });
  }

  await t("correzione su legacy 'manual'/cobrado=false: metodo reale + cobrado allineato", async () => {
    retirado("#A", "manual", { cobrado: false });
    const r = await cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "manual" });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(STORE["#A"].metodo_pago, "tarjeta");
    assert.strictEqual(STORE["#A"].cobrado, true);
    assert.strictEqual(LOGS[0].metadata.metodo_pago_from, "manual");
    assert.strictEqual(LOGS[0].metadata.cobrado_before, false);
  });

  for (const bad of ["manual", "", null, undefined, "paypal", "EFECTIVO!"]) {
    await t(`correzione con metodo non valido (${JSON.stringify(bad)}) → rifiutata`, async () => {
      retirado("#A", "efectivo");
      const before = fp("#A");
      const r = await cambiaMetodoPago("#A", { metodo_pago: bad });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.error, "payment_method_required");
      assert.strictEqual(fp("#A"), before);
      assert.strictEqual(LOGS.length, 0);
    });
  }

  for (const estado of ["LISTO", "EN_COCINA", "POR_CONFIRMAR"]) {
    await t(`correzione su ordine ${estado} → rifiutata (si sceglie alla finalizzazione)`, async () => {
      ord("#A", { estado, ya_pagado: true, metodo_pago: "efectivo" });
      const before = fp("#A");
      const r = await cambiaMetodoPago("#A", { metodo_pago: "bizum" });
      assert.strictEqual(r.error, "payment_change_requires_retirado");
      assert.strictEqual(fp("#A"), before);
      assert.strictEqual(LOGS.length, 0);
    });
  }

  await t("correzione su ordine inesistente → not_found", async () => {
    const r = await cambiaMetodoPago("#X", { metodo_pago: "bizum" });
    assert.strictEqual(r.error, "not_found");
  });

  await t("doppio click sulla correzione: seconda = noop, 1 solo audit", async () => {
    retirado("#A", "efectivo");
    const r1 = await cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" });
    const before = fp("#A");
    const r2 = await cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" });
    assert.ok(r1.success && !r1.noop);
    assert.ok(r2.success && r2.noop === true, JSON.stringify(r2));
    assert.strictEqual(fp("#A"), before);
    assert.strictEqual(LOGS.length, 1);
  });

  await t("doppio click CONCORRENTE sulla correzione: 1 scrittura, 1 noop, 1 audit", async () => {
    retirado("#A", "efectivo");
    const [r1, r2] = await Promise.all([
      cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" }),
      cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" }),
    ]);
    assert.strictEqual([r1, r2].filter((r) => r.success && !r.noop).length, 1, JSON.stringify([r1, r2]));
    assert.strictEqual([r1, r2].filter((r) => r.success && r.noop).length, 1);
    assert.strictEqual(STORE["#A"].metodo_pago, "tarjeta");
    assert.strictEqual(LOGS.length, 1);
  });

  await t("due correzioni concorrenti diverse: una vince, l'altra conflitto, 1 audit coerente", async () => {
    retirado("#A", "efectivo");
    const [r1, r2] = await Promise.all([
      cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" }),
      cambiaMetodoPago("#A", { metodo_pago: "bizum", metodo_pago_esperado: "efectivo" }),
    ]);
    const win = [r1, r2].filter((r) => r.success && !r.noop);
    const lose = [r1, r2].filter((r) => !r.success);
    assert.strictEqual(win.length, 1, JSON.stringify([r1, r2]));
    assert.strictEqual(lose.length, 1);
    assert.strictEqual(lose[0].error, "payment_method_conflict");
    assert.strictEqual(STORE["#A"].metodo_pago, win[0].metodo_pago);
    assert.strictEqual(LOGS.length, 1);
    assert.strictEqual(LOGS[0].metadata.metodo_pago_to, win[0].metodo_pago);
  });

  await t("correzione da tab stale (esperado superato) → conflitto, nessuna scrittura", async () => {
    retirado("#A", "bizum"); // un altro device ha già corretto efectivo → bizum
    const before = fp("#A");
    const r = await cambiaMetodoPago("#A", { metodo_pago: "tarjeta", metodo_pago_esperado: "efectivo" });
    assert.strictEqual(r.error, "payment_method_conflict");
    assert.strictEqual(r.metodo_pago_actual, "bizum");
    assert.strictEqual(fp("#A"), before);
    assert.strictEqual(LOGS.length, 0);
  });

  await t("audit non scritto → correzione ANNULLATA (metodo precedente ripristinato)", async () => {
    retirado("#A", "efectivo");
    failLog = true;
    const r = await cambiaMetodoPago("#A", { metodo_pago: "bizum", metodo_pago_esperado: "efectivo" });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, "payment_audit_failed");
    assert.strictEqual(r.reverted, true);
    assert.strictEqual(STORE["#A"].metodo_pago, "efectivo");
    assert.strictEqual(LOGS.length, 0);
  });

  await t("audit non scritto E metodo cambiato nel frattempo → reverted:false (mai dichiarato annullato)", async () => {
    retirado("#A", "efectivo");
    failLog = true;
    // un altro device corregge a tarjeta tra la nostra scrittura e il revert
    onFailedLog = () => { STORE["#A"].metodo_pago = "tarjeta"; };
    const r = await cambiaMetodoPago("#A", { metodo_pago: "bizum", metodo_pago_esperado: "efectivo" });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, "payment_audit_failed");
    assert.strictEqual(r.reverted, false);
    assert.strictEqual(STORE["#A"].metodo_pago, "tarjeta", "il revert non deve schiacciare la scrittura altrui");
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
