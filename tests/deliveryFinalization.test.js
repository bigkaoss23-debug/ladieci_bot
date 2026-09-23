// tests/deliveryFinalization.test.js — [DELIVERY-REFACTOR 2026-09-22]
// Copre il layer che l'audit aveva trovato SENZA test: la finalizzazione a RETIRADO
// (pagamento, cobrado, ya_pagado, actor/origin, event_type) sul REALE cambiaStato.
// Eseguire: node tests/deliveryFinalization.test.js
// Nessuna rete, nessun DB: supabase stubbato via require.cache.
delete process.env.FDV1_RIDER_TELEMETRY;

const assert = require("assert");

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let STORE = {}, UPDATED = [], LOGS = [], UPSERTS = [], OTHER_INSERTS = [];
supa.sbSelect = async (table, query = "") => {
  if (table === "ordenes") {
    const m = query.match(/(?:^|&)id=eq\.([^&]+)/);
    if (m) { const id = decodeURIComponent(m[1]); return STORE[id] ? [{ ...STORE[id] }] : []; }
    return [];
  }
  return [];
};
supa.sbInsert = async (table, row) => {
  if (table === "orden_estado_logs") LOGS.push({ ...row });
  else OTHER_INSERTS.push({ table, row });
  return [row];
};
const { applyPatch } = require("./helpers/postgrestPatch");
supa.sbUpdate = async (table, filter, patch, prefer) => {
  // [PAYMENT-IDEMPOTENCY] la finalizzazione è un UPDATE condizionato: filtri + return=representation.
  if (table === "ordenes" && prefer) { UPDATED.push({ filter, patch }); return applyPatch(STORE, filter, patch, prefer); }
  if (table === "ordenes") {
    UPDATED.push({ filter, patch });
    const m = filter.match(/id=eq\.([^&]+)/);
    const id = m && decodeURIComponent(m[1]);
    if (id && STORE[id]) Object.assign(STORE[id], patch);
  }
  return "";
};
supa.sbUpsert = async (table, row) => { UPSERTS.push({ table, row }); return ""; };
supa.sbDelete = async () => "";

// manualGiros: niente giro nei casi base (l'hook di detach ha i suoi test).
const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ success: true });

const { cambiaStato } = require("../src/agents/agentOrdini");
const fin = require("../src/core/delivery/finalization");

let passed = 0, failed = 0;
const reset = () => { STORE = {}; UPDATED = []; LOGS = []; UPSERTS = []; OTHER_INSERTS = []; };
const ord = (id, o = {}) => (STORE[id] = {
  id, estado: "LISTO", tipo_consegna: "DOMICILIO", hora: "21:00",
  ya_pagado: false, cobrado: false, metodo_pago: "", manual_giro_id: null, ...o,
});
async function t(name, fn) {
  reset();
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + " — " + (e && e.message)); failed++; }
}
const lastPatch = () => UPDATED.length ? UPDATED[UPDATED.length - 1].patch : null;
const lastLog = () => LOGS.length ? LOGS[LOGS.length - 1] : null;

(async () => {
  console.log("DELIVERY FINALIZATION — regola canonica RETIRADO");

  // ── CASO A: non pagato, metodo reale ────────────────────────────────────────
  for (const metodo of ["efectivo", "tarjeta", "bizum"]) {
    await t(`DOMICILIO non pagato + ${metodo} → RETIRADO, cobrado=true, metodo reale`, async () => {
      ord("#A");
      const r = await cambiaStato("#A", "RETIRADO", {
        hora_entrega: Date.now(), metodo_pago: metodo,
        actor_type: "rider", origin: "driver_app",
      });
      assert.ok(r.success, JSON.stringify(r));
      assert.strictEqual(STORE["#A"].estado, "RETIRADO");
      assert.strictEqual(STORE["#A"].metodo_pago, metodo);
      assert.strictEqual(STORE["#A"].cobrado, true);
      assert.ok(STORE["#A"].retirado_at, "retirado_at mancante");
    });
  }

  await t("metodo con spazi/maiuscole normalizzato (' Efectivo ' → 'efectivo')", async () => {
    ord("#A");
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: " Efectivo ", actor_type: "operator", origin: "entregas" });
    assert.ok(r.success);
    assert.strictEqual(STORE["#A"].metodo_pago, "efectivo");
  });

  // ── CASO A: fail closed ─────────────────────────────────────────────────────
  await t("metodo ASSENTE → reject, stato INVARIATO, nessuna scrittura, nessun log", async () => {
    ord("#A");
    const r = await cambiaStato("#A", "RETIRADO", { hora_entrega: Date.now(), actor_type: "operator", origin: "entregas" });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, "payment_method_required");
    assert.deepStrictEqual(r.metodos_validos, ["efectivo", "tarjeta", "bizum"]);
    assert.strictEqual(STORE["#A"].estado, "LISTO", "lo stato NON deve cambiare");
    assert.strictEqual(UPDATED.length, 0, "nessuna UPDATE su ordenes");
    assert.strictEqual(LOGS.length, 0, "nessun log di transizione");
  });

  await t('metodo "manual" → reject (fallback operatore legacy)', async () => {
    ord("#A");
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "manual", actor_type: "operator", origin: "entregas" });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, "payment_method_required");
    assert.strictEqual(r.metodo_pago_recibido, "manual");
    assert.strictEqual(STORE["#A"].estado, "LISTO");
    assert.strictEqual(UPDATED.length, 0);
  });

  await t('metodo "" → reject (buco lasciato dal default `|| ""`)', async () => {
    ord("#A");
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "", actor_type: "rider", origin: "driver_app" });
    assert.strictEqual(r.success, false);
    assert.strictEqual(UPDATED.length, 0);
  });

  await t("metodo inventato ('paypal') → reject", async () => {
    ord("#A");
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "paypal", actor_type: "operator", origin: "entregas" });
    assert.strictEqual(r.success, false);
    assert.strictEqual(UPDATED.length, 0);
  });

  await t("cobrado=true nel payload NON basta a bypassare il gate", async () => {
    ord("#A");
    const r = await cambiaStato("#A", "RETIRADO", { cobrado: true, metodo_pago: "manual", actor_type: "operator", origin: "entregas" });
    assert.strictEqual(r.success, false, "il payload FE non è autorevole");
    assert.strictEqual(UPDATED.length, 0);
  });

  // ── CASO B: già pagato ──────────────────────────────────────────────────────
  await t("ya_pagado=true → RETIRADO senza metodo, metodo canonico PRESERVATO", async () => {
    ord("#A", { ya_pagado: true, metodo_pago: "tarjeta" });
    const r = await cambiaStato("#A", "RETIRADO", { hora_entrega: Date.now(), actor_type: "rider", origin: "driver_app" });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(STORE["#A"].estado, "RETIRADO");
    assert.strictEqual(STORE["#A"].metodo_pago, "tarjeta", "il metodo originale non va sovrascritto");
    assert.strictEqual(STORE["#A"].cobrado, true);
    assert.strictEqual(STORE["#A"].ya_pagado, true);
  });

  await t("ya_pagado=true + metodo diverso in ingresso → NON sovrascrive", async () => {
    ord("#A", { ya_pagado: true, metodo_pago: "tarjeta" });
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", actor_type: "operator", origin: "entregas" });
    assert.ok(r.success);
    assert.strictEqual(STORE["#A"].metodo_pago, "tarjeta");
  });

  await t("ya_pagado=true SENZA metodo registrato + metodo valido → colma il buco", async () => {
    ord("#A", { ya_pagado: true, metodo_pago: "" });
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "bizum", actor_type: "operator", origin: "entregas" });
    assert.ok(r.success);
    assert.strictEqual(STORE["#A"].metodo_pago, "bizum");
    assert.strictEqual(STORE["#A"].cobrado, true);
  });

  await t("cobrado=true + metodo reale già in DB → già pagato, nessun secondo pagamento", async () => {
    ord("#A", { cobrado: true, metodo_pago: "efectivo" });
    const r = await cambiaStato("#A", "RETIRADO", { actor_type: "operator", origin: "entregas" });
    assert.ok(r.success);
    assert.strictEqual(STORE["#A"].metodo_pago, "efectivo");
  });

  await t('cobrado=true ma metodo "manual" in DB (dato sporco legacy) → NON conta come pagato', async () => {
    ord("#A", { cobrado: true, metodo_pago: "manual" });
    const r = await cambiaStato("#A", "RETIRADO", { actor_type: "operator", origin: "entregas" });
    assert.strictEqual(r.success, false, "lo stato sporco non deve valere come pagamento");
  });

  // ── RITIRO ──────────────────────────────────────────────────────────────────
  await t("RITIRO non pagato + efectivo → cobrado=true (era il buco G-3)", async () => {
    ord("#R", { tipo_consegna: "RITIRO" });
    const r = await cambiaStato("#R", "RETIRADO", { metodo_pago: "efectivo", actor_type: "operator", origin: "dashboard" });
    assert.ok(r.success);
    assert.strictEqual(STORE["#R"].cobrado, true, "il RITIRO incassato deve risultare cobrado");
    assert.strictEqual(STORE["#R"].metodo_pago, "efectivo");
  });

  await t("RITIRO già pagato → nessun secondo pagamento", async () => {
    ord("#R", { tipo_consegna: "RITIRO", ya_pagado: true, metodo_pago: "bizum" });
    const r = await cambiaStato("#R", "RETIRADO", { actor_type: "operator", origin: "dashboard" });
    assert.ok(r.success);
    assert.strictEqual(STORE["#R"].metodo_pago, "bizum");
    assert.strictEqual(STORE["#R"].cobrado, true);
  });

  // ── AUDIT: actor / origin / event_type ──────────────────────────────────────
  await t("actor rider + origin driver_app → log coerente", async () => {
    ord("#A");
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", actor_type: "rider", origin: "driver_app" });
    const l = lastLog();
    assert.ok(l, "log mancante");
    assert.strictEqual(l.actor_type, "rider");
    assert.strictEqual(l.origin, "driver_app");
  });

  await t("actor operator + origin entregas → log coerente (fallback operatore distinguibile)", async () => {
    ord("#A");
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", actor_type: "operator", origin: "entregas" });
    const l = lastLog();
    assert.strictEqual(l.actor_type, "operator");
    assert.strictEqual(l.origin, "entregas");
  });

  await t("actor_id assente → NULL (mai inventato)", async () => {
    ord("#A");
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", actor_type: "rider", origin: "driver_app" });
    assert.strictEqual(lastLog().actor_id, null);
  });

  await t("event_type: DOMICILIO → delivered", async () => {
    ord("#A");
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", actor_type: "rider", origin: "driver_app" });
    assert.strictEqual(lastLog().event_type, "delivered");
  });

  await t("event_type: RITIRO → picked_up", async () => {
    ord("#R", { tipo_consegna: "RITIRO" });
    await cambiaStato("#R", "RETIRADO", { metodo_pago: "efectivo", actor_type: "operator", origin: "dashboard" });
    assert.strictEqual(lastLog().event_type, "picked_up");
  });

  // ── LEGACY COMPAT ───────────────────────────────────────────────────────────
  await t("legacy EN_ENTREGA → RETIRADO resta finalizzabile", async () => {
    ord("#L", { estado: "EN_ENTREGA" });
    const r = await cambiaStato("#L", "RETIRADO", { metodo_pago: "tarjeta", actor_type: "operator", origin: "entregas" });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(STORE["#L"].estado, "RETIRADO");
    assert.strictEqual(STORE["#L"].metodo_pago, "tarjeta");
    assert.strictEqual(lastLog().estado_from, "EN_ENTREGA");
  });

  await t("legacy EN_ENTREGA già pagato → finalizzabile senza metodo", async () => {
    ord("#L", { estado: "EN_ENTREGA", ya_pagado: true, metodo_pago: "efectivo" });
    const r = await cambiaStato("#L", "RETIRADO", { actor_type: "operator", origin: "entregas" });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(STORE["#L"].estado, "RETIRADO");
  });

  // ── LISTO → RETIRADO diretto (nuovo flusso, senza EN_ENTREGA) ───────────────
  await t("LISTO → RETIRADO diretto su DOMICILIO è legale (nessun EN_ENTREGA)", async () => {
    ord("#A", { estado: "LISTO" });
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", actor_type: "rider", origin: "driver_app" });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(lastLog().estado_from, "LISTO");
    assert.strictEqual(lastLog().estado_to, "RETIRADO");
  });

  await t("nessuna mutazione DRIVER_STATO e nessuna riga delivery_logs", async () => {
    ord("#A");
    await cambiaStato("#A", "RETIRADO", { metodo_pago: "efectivo", actor_type: "rider", origin: "driver_app" });
    assert.ok(!UPSERTS.some((u) => u.row && u.row.chiave === "DRIVER_STATO"), "DRIVER_STATO toccato");
    assert.ok(!OTHER_INSERTS.some((i) => i.table === "delivery_logs"), "delivery_logs scritto");
  });

  // ── RETIRADO ripetuto su ordine già RETIRADO = NO-OP PURO ──────────────────
  // [PAYMENT-IDEMPOTENCY 2026-09-23] contratto precedente REVOCATO: il self-loop
  // non è più la "correzione metodo" (torture test: tab stale bizum→efectivo senza
  // log). La correzione ha la sua azione, cambiaMetodoPago (paymentIdempotency.test.js).
  await t("RETIRADO ripetuto con metodo diverso: noop, NESSUNA scrittura, nessun log", async () => {
    ord("#A", { estado: "RETIRADO", cobrado: false, metodo_pago: "manual" });
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "tarjeta", actor_type: "operator", origin: "dashboard" });
    assert.ok(r.success && r.noop === true, JSON.stringify(r));
    assert.strictEqual(STORE["#A"].metodo_pago, "manual");
    assert.strictEqual(STORE["#A"].cobrado, false);
    assert.strictEqual(UPDATED.length, 0, "nessuna UPDATE su ordenes");
    assert.strictEqual(LOGS.length, 0, "nessun log");
  });

  await t("RETIRADO ripetuto con metodo non valido: noop, metodo invariato", async () => {
    ord("#A", { estado: "RETIRADO", cobrado: true, metodo_pago: "efectivo" });
    const r = await cambiaStato("#A", "RETIRADO", { metodo_pago: "manual", actor_type: "operator", origin: "dashboard" });
    assert.ok(r.success && r.noop === true, JSON.stringify(r));
    assert.strictEqual(STORE["#A"].metodo_pago, "efectivo");
    assert.strictEqual(UPDATED.length, 0);
  });

  // ── Transizioni non-RETIRADO invariate ──────────────────────────────────────
  await t("EN_COCINA → LISTO non è toccata dal gate pagamento", async () => {
    ord("#A", { estado: "EN_COCINA" });
    const r = await cambiaStato("#A", "LISTO", { actor_type: "operator", origin: "dashboard" });
    assert.ok(r.success, JSON.stringify(r));
    assert.strictEqual(STORE["#A"].estado, "LISTO");
    assert.strictEqual(STORE["#A"].cobrado, false, "cobrado non va toccato fuori da RETIRADO");
  });

  // ── unit puri del modulo ────────────────────────────────────────────────────
  await t("finalization: isValidPaymentMethod", async () => {
    for (const m of ["efectivo", "tarjeta", "bizum", "EFECTIVO", " bizum "]) assert.ok(fin.isValidPaymentMethod(m), m);
    for (const m of ["manual", "", null, undefined, "paypal", "efectvo"]) assert.ok(!fin.isValidPaymentMethod(m), String(m));
  });

  await t("finalization: isAlreadyPaid", async () => {
    assert.ok(fin.isAlreadyPaid({ ya_pagado: true }));
    assert.ok(fin.isAlreadyPaid({ cobrado: true, metodo_pago: "bizum" }));
    assert.ok(!fin.isAlreadyPaid({ cobrado: true, metodo_pago: "manual" }));
    assert.ok(!fin.isAlreadyPaid({ cobrado: false, metodo_pago: "bizum" }));
    assert.ok(!fin.isAlreadyPaid(null));
  });

  console.log(`\n  passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
