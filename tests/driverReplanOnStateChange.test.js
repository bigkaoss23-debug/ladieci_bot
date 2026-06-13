// tests/driverReplanOnStateChange.test.js
// DRIVER_REPLAN_STALE_FIX_01
// Verifica che i campi driver vengano ricalcolati (replan globale) quando cambia
// la capacità rider: cambiaStato → LISTO/EN_ENTREGA/RETIRADO e delete DOMICILIO.
// Nessuna rete/DB reale: Supabase stubbato via require.cache (come
// orderStateTransitions.test.js). forno_out mai toccato dal path driver.

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let STORE = {};
let SELECTS = [];
let UPDATES = [];

// sbSelect: gestisce sia il fetch per id (id=eq.X) sia la query globale di replan
// (tipo_consegna=eq.DOMICILIO & estado=not.in.(RETIRADO,COMPLETATO)).
supa.sbSelect = async (table, query = "") => {
  if (table !== "ordenes") return [];
  SELECTS.push(query);
  const mId = query.match(/id=eq\.([^&]+)/);
  if (mId) {
    const id = decodeURIComponent(mId[1]);
    return STORE[id] ? [STORE[id]] : [];
  }
  // Query globale replan: DOMICILIO non terminali.
  if (/tipo_consegna=eq\.DOMICILIO/.test(query) && /estado=not\.in/.test(query)) {
    return Object.values(STORE).filter(o =>
      o.tipo_consegna === "DOMICILIO" && !["RETIRADO", "COMPLETATO"].includes(o.estado));
  }
  return [];
};
supa.sbInsert = async (table, row) => {
  if (table === "ordenes") STORE[row.id] = { ...row };
  return [row];
};
supa.sbUpdate = async (table, filter, patch) => {
  UPDATES.push({ table, filter, patch });
  if (table === "ordenes") {
    const mId = String(filter).match(/id=eq\.([^&]+)/);
    if (mId) {
      const id = decodeURIComponent(mId[1]);
      STORE[id] = { ...(STORE[id] || { id }), ...patch };
    }
  }
  return {};
};
let DELETES = [];
supa.sbDelete = async (table, filter) => {
  DELETES.push({ table, filter });
  if (table === "ordenes") {
    const mId = String(filter).match(/id=eq\.([^&]+)/);
    if (mId) delete STORE[decodeURIComponent(mId[1])];
  }
  return {};
};
supa.sbUpsert = async () => ({});
supa.getConfig = async () => ({});

const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ ok: true });

const { cambiaStato, eliminaOrdine } = require("../src/agents/agentOrdini");
const { computeDriverFields } = require("../src/utils/zones");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

const reset = () => { STORE = {}; SELECTS = []; UPDATES = []; DELETES = []; };
const globalReplanSelects = () =>
  SELECTS.filter(q => /tipo_consegna=eq\.DOMICILIO/.test(q) && /estado=not\.in/.test(q));
const driverUpdates = () =>
  UPDATES.filter(u => u.table === "ordenes" && u.patch &&
    ("conflicto_driver" in u.patch || "salida_driver_estimada" in u.patch));
const anyFornoOutPatch = () =>
  UPDATES.some(u => u.table === "ordenes" && u.patch && "forno_out" in u.patch);

const dom = (id, estado, zona, hora, dur, extra = {}) => ({
  id, estado, tipo_consegna: "DOMICILIO", zona, hora,
  durata_andata_min: dur, manual_giro_id: null, ...extra,
});

(async () => {
  // ── 1. RETIRADO DOMICILIO → replan globale ──────────────────────────────────
  console.log("\n══ 1. RETIRADO DOMICILIO → replan ══");
  {
    reset();
    STORE["#A"] = dom("#A", "EN_ENTREGA", "Q1", "21:00", 5);
    STORE["#B"] = dom("#B", "EN_COCINA", "Q5", "21:10", 20);
    await cambiaStato("#A", "RETIRADO", { actor_type: "operator" });
    check("replan globale triggerato su RETIRADO", globalReplanSelects().length >= 1,
      JSON.stringify(SELECTS));
    check("nessuna patch forno_out dal path driver", !anyFornoOutPatch());
  }

  // ── 2. LISTO → replan globale ───────────────────────────────────────────────
  console.log("\n══ 2. LISTO → replan ══");
  {
    reset();
    STORE["#A"] = dom("#A", "EN_COCINA", "Q1", "21:00", 5);
    await cambiaStato("#A", "LISTO", { actor_type: "operator" });
    check("replan globale triggerato su LISTO", globalReplanSelects().length >= 1, JSON.stringify(SELECTS));
  }

  // ── 3. EN_ENTREGA → replan globale ──────────────────────────────────────────
  console.log("\n══ 3. EN_ENTREGA → replan ══");
  {
    reset();
    STORE["#A"] = dom("#A", "LISTO", "Q1", "21:00", 5);
    await cambiaStato("#A", "EN_ENTREGA", { actor_type: "operator" });
    check("replan globale triggerato su EN_ENTREGA", globalReplanSelects().length >= 1, JSON.stringify(SELECTS));
  }

  // ── 4. delete DOMICILIO → replan globale ────────────────────────────────────
  console.log("\n══ 4. delete DOMICILIO → replan ══");
  {
    reset();
    STORE["#A"] = dom("#A", "EN_COCINA", "Q1", "21:00", 5);
    STORE["#B"] = dom("#B", "EN_COCINA", "Q5", "21:10", 20);
    const r = await eliminaOrdine("#A");
    check("eliminaOrdine ritorna success", r && r.success === true);
    check("ordine cancellato dallo store", !STORE["#A"]);
    check("replan globale triggerato su delete DOMICILIO", globalReplanSelects().length >= 1, JSON.stringify(SELECTS));
  }

  // ── 5. delete RITIRO → NESSUN replan driver ─────────────────────────────────
  console.log("\n══ 5. delete RITIRO → no replan ══");
  {
    reset();
    STORE["#R"] = { id: "#R", estado: "LISTO", tipo_consegna: "RITIRO", zona: null, hora: "21:00", manual_giro_id: null };
    await eliminaOrdine("#R");
    check("nessun replan globale su delete RITIRO", globalReplanSelects().length === 0, JSON.stringify(SELECTS));
  }

  // ── 6. regression #010: RETIRADO del primo pulisce il conflitto del secondo ──
  console.log("\n══ 6. regression #010 (conflitto si pulisce) ══");
  {
    reset();
    // Due giri Q5 in slot diversi: il rider incatenato fa slittare il secondo.
    const A = dom("#A", "EN_ENTREGA", "Q5", "21:00", 30);
    const B = dom("#B", "EN_COCINA", "Q5", "21:10", 30);
    // Stato PRIMA: con entrambi attivi, #B è in conflitto (retraso>0).
    const before = computeDriverFields([A, B]).get("#B");
    check("setup: #B in conflitto con entrambi attivi", before && before.retraso_estimado_min > 0,
      JSON.stringify(before));
    // Persisti i campi stale su #B (come se calcolati quando entrambi attivi).
    STORE["#A"] = { ...A };
    STORE["#B"] = { ...B, ...before };
    // #A consegnato → libera il rider.
    await cambiaStato("#A", "RETIRADO", { actor_type: "operator" });
    const after = STORE["#B"];
    check("#B ricalcolato: conflicto_driver=false", after.conflicto_driver === false, JSON.stringify(after));
    check("#B ricalcolato: retraso_estimado_min=0", after.retraso_estimado_min === 0, JSON.stringify(after));
    check("#B aggiornato via driver patch", driverUpdates().some(u => /id=eq\.%23B|id=eq\.#B/.test(u.filter)),
      JSON.stringify(UPDATES.map(u => u.filter)));
    check("nessuna patch forno_out", !anyFornoOutPatch());
  }

  // ── 7. no-op: se nulla cambia, nessun update driver inutile ─────────────────
  console.log("\n══ 7. no-op → nessun update driver ══");
  {
    reset();
    const o = dom("#A", "EN_COCINA", "Q1", "22:00", 5);
    // Persisti i campi driver GIÀ corretti (single-order schedule).
    const f = computeDriverFields([o]).get("#A");
    STORE["#A"] = { ...o, ...f };
    await cambiaStato("#A", "LISTO", { actor_type: "operator" });
    check("replan triggerato (select globale emessa)", globalReplanSelects().length >= 1);
    check("nessun update driver-field (fields invariati)", driverUpdates().length === 0,
      JSON.stringify(driverUpdates()));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
