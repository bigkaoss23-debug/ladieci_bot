// tests/pendingGiroIntentWiring.test.js
// DELIVERY-MANUAL-GIRO-01 Opzione A — wiring tests.
// Verifica il CABLAGGIO in agentOrdini (creaOrdine whitelist + cambiaStato
// entering-EN_COCINA hook). La logica di attach (create-vs-add, eligibilità,
// sanitize) è coperta a parte in tests/manualGiros.test.js. Qui si verifica:
//   - creaOrdine persiste pending_giro_intent (sanitizzato) e l'ordine resta
//     POR_CONFIRMAR senza manual_giro_id;
//   - cambiaStato → EN_COCINA con intent consuma l'intent una volta sola
//     (attach + clear), best-effort, MAI rollback dello stato;
//   - legacy senza intent / transizioni non-EN_COCINA invariati.
// Nessuna rete/DB: supabase + geoResolver stubbati via require.cache. Lo spy su
// manualGiros.attachOrderViaPendingIntent è installato PRIMA di caricare
// agentOrdini (che ne cattura il riferimento al load).

const assert = require("assert");

// ── Stub supabase ────────────────────────────────────────────────
const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let STORE = {};        // id → ordine
let INSERTED = [];     // righe ordenes inserite
let UPDATES = [];      // { filter, patch } su ordenes

supa.sbSelect = async (table, query = "") => {
  if (table !== "ordenes") return [];
  const mId = query.match(/id=eq\.([^&]+)/);
  if (mId) {
    const id = decodeURIComponent(mId[1]);
    return STORE[id] ? [{ ...STORE[id] }] : [];
  }
  // query globale (id-gen window / replan / risincronizza) → DOMICILIO non terminali
  if (/tipo_consegna=eq\.DOMICILIO/.test(query)) {
    return Object.values(STORE).filter(o =>
      o.tipo_consegna === "DOMICILIO" && !["RETIRADO", "COMPLETATO"].includes(o.estado));
  }
  return [];
};
supa.sbInsert = async (table, row) => {
  if (table === "ordenes") { INSERTED.push(row); STORE[row.id] = { ...row }; return [row]; }
  return [row];
};
supa.sbUpdate = async (table, filter, patch) => {
  if (table === "ordenes") {
    UPDATES.push({ filter, patch });
    const mId = String(filter).match(/id=eq\.([^&]+)/);
    if (mId) {
      const id = decodeURIComponent(mId[1]);
      STORE[id] = { ...(STORE[id] || { id }), ...patch };
    }
  }
  return {};
};
supa.sbUpsert = async () => ({});
supa.sbDelete = async () => ({});
supa.getConfig = async () => ({});

// ── Stub geoResolver (creaOrdine resolve path) ──────────────────
const geoPath = require.resolve("../src/utils/geoResolver");
require(geoPath);
require.cache[geoPath].exports.risolviIndirizzo = async () => ({
  zona: "Q5", lat: 36.72, lon: -2.63, durataAndataMin: 12,
  googleMin: 12, haversineMin: 26, source: "google", cached: true, fuoriZona: false, error: null,
});

// ── Spy su manualGiros.attachOrderViaPendingIntent (PRIMA di agentOrdini) ──
const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];
let attachCalls = [];
let attachBehavior = "ok"; // "ok" | "throw" | "fail"
require.cache[mgPath].exports.attachOrderViaPendingIntent = async (orderId, intent) => {
  attachCalls.push({ orderId, intent });
  if (attachBehavior === "throw") throw new Error("simulated attach failure");
  if (attachBehavior === "fail") return { ok: false, error: "order_not_eligible" };
  return { ok: true };
};
// sanitizePendingGiroIntent resta REALE (usato da creaOrdine).

const { creaOrdine, cambiaStato } = require("../src/agents/agentOrdini");

// ── Harness ──────────────────────────────────────────────────────
const failures = [];
async function t(name, fn) {
  STORE = {}; INSERTED = []; UPDATES = []; attachCalls = []; attachBehavior = "ok";
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`); }
}
const lastIntentPatch = () =>
  UPDATES.filter(u => u.patch && Object.prototype.hasOwnProperty.call(u.patch, "pending_giro_intent"));

(async () => {
  // ── creaOrdine whitelist ───────────────────────────────────────
  await t("creaOrdine: persiste pending_giro_intent sanitizzato, ordine POR_CONFIRMAR, no giro", async () => {
    const intent = { giroId: "#A", anchorOrderId: "#A", salidaRef: "23:02", entregaRef: "23:21", routeTimeline: ["x"] };
    const r = await creaOrdine({
      operatorManual: true, nombre: "Tester", canal: "MANUAL", hora: "23:21",
      tipo_consegna: "DOMICILIO", direccion: "calle test 1",
      items: [{ id: "p1", q: 1, price: 10 }],
      pending_giro_intent: intent,
    });
    assert.ok(r && (r.success || r.id), "creaOrdine ok");
    assert.strictEqual(INSERTED.length, 1);
    const row = INSERTED[0];
    assert.strictEqual(row.estado, "POR_CONFIRMAR");
    assert.strictEqual(row.manual_giro_id == null, true, "manual_giro_id non impostato alla creazione");
    // routeTimeline scartato, hora normalizzate, solo shape minimo
    assert.deepStrictEqual(row.pending_giro_intent, {
      giroId: "#A", anchorOrderId: "#A", salidaRef: "23:02", entregaRef: "23:21",
    });
    assert.strictEqual(attachCalls.length, 0, "nessun attach alla creazione");
  });

  await t("creaOrdine: intent malformato → pending_giro_intent null", async () => {
    const r = await creaOrdine({
      operatorManual: true, nombre: "Tester", canal: "MANUAL", hora: "23:21",
      tipo_consegna: "DOMICILIO", direccion: "calle test 1",
      items: [{ id: "p1", q: 1, price: 10 }],
      pending_giro_intent: { giroId: "#A" }, // manca anchorOrderId
    });
    assert.ok(r && (r.success || r.id));
    assert.strictEqual(INSERTED[0].pending_giro_intent, null);
  });

  await t("creaOrdine: legacy senza intent → pending_giro_intent null", async () => {
    await creaOrdine({
      operatorManual: true, nombre: "Tester", canal: "MANUAL", hora: "23:21",
      tipo_consegna: "DOMICILIO", direccion: "calle test 1",
      items: [{ id: "p1", q: 1, price: 10 }],
    });
    assert.strictEqual(INSERTED[0].pending_giro_intent, null);
  });

  // ── cambiaStato entering-EN_COCINA hook ────────────────────────
  await t("cambiaStato → EN_COCINA con intent: attach chiamato 1 volta + intent azzerato", async () => {
    const intent = { giroId: "#Q5", anchorOrderId: "#Q5", salidaRef: "23:02", entregaRef: "23:21" };
    STORE["#B"] = { id: "#B", estado: "POR_CONFIRMAR", tipo_consegna: "DOMICILIO", zona: "Q2", hora: "23:09", manual_giro_id: null, pending_giro_intent: intent };
    const r = await cambiaStato("#B", "EN_COCINA", { actor_type: "operator" });
    assert.notStrictEqual(r && r.success, false, "stato cambiato");
    assert.strictEqual(attachCalls.length, 1);
    assert.strictEqual(attachCalls[0].orderId, "#B");
    assert.deepStrictEqual(attachCalls[0].intent, intent);
    const cleared = lastIntentPatch();
    assert.ok(cleared.length >= 1 && cleared[cleared.length - 1].patch.pending_giro_intent === null, "intent azzerato");
    assert.strictEqual(STORE["#B"].pending_giro_intent, null);
  });

  await t("cambiaStato → EN_COCINA con intent ma attach LANCIA: no rollback stato, intent azzerato", async () => {
    attachBehavior = "throw";
    const intent = { giroId: "#Q5", anchorOrderId: "#Q5", salidaRef: null, entregaRef: null };
    STORE["#B"] = { id: "#B", estado: "POR_CONFIRMAR", tipo_consegna: "DOMICILIO", zona: "Q2", hora: "23:09", manual_giro_id: null, pending_giro_intent: intent };
    const r = await cambiaStato("#B", "EN_COCINA", { actor_type: "operator" });
    assert.notStrictEqual(r && r.success, false, "stato cambiato nonostante attach fallito");
    assert.strictEqual(STORE["#B"].estado, "EN_COCINA");
    assert.strictEqual(STORE["#B"].manual_giro_id == null, true, "resta singolo");
    assert.strictEqual(STORE["#B"].pending_giro_intent, null, "intent comunque consumato");
  });

  await t("cambiaStato → EN_COCINA con attach fail (ok:false): nessun throw, intent azzerato", async () => {
    attachBehavior = "fail";
    const intent = { giroId: "#Q5", anchorOrderId: "#Q5", salidaRef: null, entregaRef: null };
    STORE["#B"] = { id: "#B", estado: "POR_CONFIRMAR", tipo_consegna: "DOMICILIO", zona: "Q2", hora: "23:09", manual_giro_id: null, pending_giro_intent: intent };
    const r = await cambiaStato("#B", "EN_COCINA", { actor_type: "operator" });
    assert.notStrictEqual(r && r.success, false);
    assert.strictEqual(attachCalls.length, 1);
    assert.strictEqual(STORE["#B"].pending_giro_intent, null);
  });

  await t("cambiaStato → EN_COCINA SENZA intent (legacy): attach non chiamato", async () => {
    STORE["#B"] = { id: "#B", estado: "POR_CONFIRMAR", tipo_consegna: "DOMICILIO", zona: "Q2", hora: "23:09", manual_giro_id: null, pending_giro_intent: null };
    await cambiaStato("#B", "EN_COCINA", { actor_type: "operator" });
    assert.strictEqual(attachCalls.length, 0);
  });

  await t("cambiaStato → NUEVO (non EN_COCINA) con intent: attach non chiamato, intent preservato", async () => {
    const intent = { giroId: "#Q5", anchorOrderId: "#Q5", salidaRef: null, entregaRef: null };
    STORE["#B"] = { id: "#B", estado: "POR_CONFIRMAR", tipo_consegna: "DOMICILIO", zona: "Q2", hora: "23:09", manual_giro_id: null, pending_giro_intent: intent };
    await cambiaStato("#B", "NUEVO", { actor_type: "operator" });
    assert.strictEqual(attachCalls.length, 0);
    assert.deepStrictEqual(STORE["#B"].pending_giro_intent, intent, "intent non consumato fuori da EN_COCINA");
  });

  // ── report ─────────────────────────────────────────────────────
  if (failures.length) {
    console.error(`\n${failures.length} test(s) failed.`);
    process.exit(1);
  }
  console.log("\npendingGiroIntentWiring.test.js OK");
})().catch(err => { console.error(err); process.exit(1); });
