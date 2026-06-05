// tests/orderStateMachineWireGuard.test.js
// ===============================================================
// ORDER-STATE-MACHINE-WIRE-GUARD-49 — verifica del guard cablato in cambiaStato.
// Conferma che le transizioni VALIDE scrivono ordenes+log come prima, e che le
// transizioni INVALIDE (stato sconosciuto / backward / da terminale) vengono
// rifiutate SENZA toccare ordenes né orden_estado_logs.
// Supabase stubbato via require.cache (nessun DB/rete).
// Eseguire: node tests/orderStateMachineWireGuard.test.js
// ===============================================================
"use strict";

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let STORE = {};
let INSERTS = [];
let UPDATES = [];

supa.sbSelect = async (table, query = "") => {
  if (table === "ordenes") {
    const m = query.match(/id=eq\.([^&]+)/);
    if (m) { const id = decodeURIComponent(m[1]); return STORE[id] ? [STORE[id]] : []; }
    return [];
  }
  return [];
};
supa.sbInsert = async (table, row) => {
  INSERTS.push({ table, row });
  if (table === "ordenes") STORE[row.id] = { ...row };
  return [row];
};
supa.sbUpdate = async (table, filter, patch) => {
  UPDATES.push({ table, filter, patch });
  if (table === "ordenes") {
    const m = filter.match(/id=eq\.([^&]+)/);
    if (m) { const id = decodeURIComponent(m[1]); STORE[id] = { ...(STORE[id] || { id }), ...patch }; }
  }
  return {};
};
supa.sbUpsert = async () => ({});
supa.sbDelete = async () => ({});
supa.getConfig = async () => ({});

const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];
require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ ok: true });

const { cambiaStato } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const section = (s) => console.log(`\n── ${s} ──`);
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const reset = () => { STORE = {}; INSERTS = []; UPDATES = []; };
const ordenesUpdates = () => UPDATES.filter(u => u.table === "ordenes");
const logInserts = () => INSERTS.filter(i => i.table === "orden_estado_logs");
const seed = (id, estado, tipo = "RITIRO") => { STORE[id] = { id, estado, tipo_consegna: tipo, manual_giro_id: null }; };

(async () => {
  // ── 1) transizione valida scrive ordenes + log ─────────────────────────────
  section("1) valida POR_CONFIRMAR → EN_COCINA");
  {
    reset(); seed("#201", "POR_CONFIRMAR");
    const res = await cambiaStato("#201", "EN_COCINA", { actor_type: "operator", origin: "dashboard" });
    assert("success true", res.success === true, JSON.stringify(res));
    assert("estado aggiornato a EN_COCINA", STORE["#201"].estado === "EN_COCINA");
    assert("en_cocina_at valorizzato", !!ordenesUpdates().at(-1).patch.en_cocina_at);
    assert("un update ordenes", ordenesUpdates().length === 1);
    assert("un log creato (confirmed)", logInserts().length === 1 && logInserts()[0].row.event_type === "confirmed");
  }

  // ── 2) stati sconosciuti → rifiuto, NO update, NO log ──────────────────────
  section("2) stati sconosciuti rifiutati");
  for (const bad of ["EN_COCINA cambiaStato", "foo", "", null, " listo "]) {
    reset(); seed("#202", "EN_COCINA");
    const res = await cambiaStato("#202", bad, { actor_type: "operator" });
    const label = JSON.stringify(bad);
    assert(`${label} → invalid_state_transition / unknown_target_state`,
      res.success === false && res.error === "invalid_state_transition" && res.reason === "unknown_target_state",
      JSON.stringify(res));
    assert(`${label} → NESSUN update ordenes`, ordenesUpdates().length === 0);
    assert(`${label} → NESSUN log`, logInserts().length === 0);
    assert(`${label} → estado invariato (EN_COCINA)`, STORE["#202"].estado === "EN_COCINA");
  }

  // ── 3) backward → rifiuto (escluso l'undo operativo LISTO→EN_COCINA) ────────
  section("3) transizioni backward rifiutate");
  for (const [from, to] of [["EN_ENTREGA", "LISTO"], ["EN_ENTREGA", "EN_COCINA"], ["RETIRADO", "EN_COCINA"]]) {
    reset(); seed("#203", from);
    const res = await cambiaStato("#203", to, {});
    assert(`${from} → ${to} rifiutata (illegal_transition)`,
      res.success === false && res.error === "invalid_state_transition" && res.reason === "illegal_transition",
      JSON.stringify(res));
    assert(`${from} → ${to}: nessun update/log`, ordenesUpdates().length === 0 && logInserts().length === 0);
    assert(`${from} → ${to}: estado invariato`, STORE["#203"].estado === from);
  }

  // ── 3B) undo operativo 49B: LISTO → EN_COCINA permesso e tracciato ─────────
  section("3B) undo operativo LISTO → EN_COCINA");
  {
    reset();
    // ordine già passato per LISTO: listo_at preesistente da preservare
    STORE["#213"] = { id: "#213", estado: "LISTO", tipo_consegna: "RITIRO", manual_giro_id: null, listo_at: "2026-06-05T20:00:00.000Z" };
    const res = await cambiaStato("#213", "EN_COCINA", { actor_type: "operator", origin: "dashboard" });
    assert("success true", res.success === true, JSON.stringify(res));
    assert("estado torna EN_COCINA", STORE["#213"].estado === "EN_COCINA");
    assert("un update ordenes eseguito", ordenesUpdates().length === 1);
    assert("en_cocina_at valorizzato", !!ordenesUpdates().at(-1).patch.en_cocina_at);
    assert("listo_at NON cancellato dalla patch", !("listo_at" in ordenesUpdates().at(-1).patch));
    assert("listo_at preservato nello store", STORE["#213"].listo_at === "2026-06-05T20:00:00.000Z");
    assert("log append-only creato (sent_to_kitchen)", logInserts().length === 1 && logInserts()[0].row.event_type === "sent_to_kitchen");
    assert("undo senza PII nel log", !/nombre|telefono|direccion|nota|tel/i.test(JSON.stringify(logInserts()[0].row)));
  }

  // ── 4) resurrezione da stato terminale duro → rifiuto ──────────────────────
  section("4) resurrezione da terminale (from_terminal_state)");
  for (const [from, to] of [["COMPLETADO", "EN_COCINA"], ["COMPLETATO", "LISTO"], ["CANCELADO", "EN_COCINA"]]) {
    reset(); seed("#204", from);
    const res = await cambiaStato("#204", to, {});
    assert(`${from} → ${to} rifiutata (from_terminal_state)`,
      res.success === false && res.reason === "from_terminal_state", JSON.stringify(res));
    assert(`${from} → ${to}: nessun update/log`, ordenesUpdates().length === 0 && logInserts().length === 0);
  }

  // ── 5) bug esatto dello smoke 47 ───────────────────────────────────────────
  section("5) bug smoke-47 esatto");
  {
    reset(); seed("#205", "POR_CONFIRMAR");
    const res = await cambiaStato("#205", "EN_COCINA cambiaStato", {});
    assert('"EN_COCINA cambiaStato" rifiutato e NON salvato', res.success === false && STORE["#205"].estado === "POR_CONFIRMAR");
  }

  // ── 6) terminale valido: LISTO → RETIRADO (ritiro) ─────────────────────────
  section("6) valida LISTO → RETIRADO");
  {
    reset(); seed("#206", "LISTO", "RITIRO");
    const res = await cambiaStato("#206", "RETIRADO", { actor_type: "operator", origin: "cocina" });
    assert("success true", res.success === true);
    assert("retirado_at valorizzato", !!ordenesUpdates().at(-1).patch.retirado_at);
    assert("log picked_up", logInserts().at(-1).row.event_type === "picked_up");
  }

  // ── 7) flusso felice completo NON bloccato ─────────────────────────────────
  section("7) catena completa resta valida");
  {
    reset(); seed("#207", "POR_CONFIRMAR", "DOMICILIO");
    for (const to of ["EN_COCINA", "LISTO", "EN_ENTREGA", "RETIRADO", "COMPLETADO"]) {
      const r = await cambiaStato("#207", to, { actor_type: "operator", origin: "dashboard" });
      assert(`→ ${to} ok`, r.success === true, JSON.stringify(r));
    }
    assert("stato finale COMPLETADO", STORE["#207"].estado === "COMPLETADO");
    assert("no-op idempotente COMPLETADO→COMPLETADO? (deve restare lecito)",
      (await cambiaStato("#207", "COMPLETADO", {})).success === true);
  }

  // ── 8) no PII nell'errore ──────────────────────────────────────────────────
  section("8) errore senza PII");
  {
    reset(); seed("#208", "RETIRADO");
    const res = await cambiaStato("#208", "EN_COCINA", {});
    assert("errore non contiene PII", !/nombre|telefono|direccion|nota|tel/i.test(JSON.stringify(res)), JSON.stringify(res));
    assert("errore espone solo stati", "estado_actual" in res && "estado_solicitado" in res);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
