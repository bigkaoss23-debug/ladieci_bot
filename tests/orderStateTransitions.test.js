// ORDER-STATE-TRANSITION-LOGS-40
// Eseguire: node tests/orderStateTransitions.test.js
// Nessuna rete, nessun DB reale: Supabase e' stubbatto via require.cache.

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let STORE = {};
let INSERTS = [];
let UPDATES = [];
let failLogInsert = false;

supa.sbSelect = async (table, query = "") => {
  if (table === "config") return [];
  if (table === "clientes") return [];
  if (table === "geo_cache") return [];
  if (table === "manual_giros") return [];
  if (table === "ordenes") {
    const mId = query.match(/id=eq\.([^&]+)/);
    if (mId) {
      const id = decodeURIComponent(mId[1]);
      return STORE[id] ? [STORE[id]] : [];
    }
    return [];
  }
  return [];
};

supa.sbInsert = async (table, row) => {
  if (table === "orden_estado_logs" && failLogInsert) {
    throw new Error("simulated_log_insert_failure");
  }
  INSERTS.push({ table, row });
  if (table === "ordenes") STORE[row.id] = { ...row };
  return [row];
};

supa.sbUpdate = async (table, filter, patch) => {
  UPDATES.push({ table, filter, patch });
  if (table === "ordenes") {
    const mId = filter.match(/id=eq\.([^&]+)/);
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

const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];
require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ ok: true });

const {
  buildStateTimestampPatch,
  sanitizeMetadata,
  stateEventType,
} = require("../src/utils/orderStateLogger");
const { creaOrdine, cambiaStato } = require("../src/agents/agentOrdini");

let passed = 0;
let failed = 0;

const assert = (name, cond, detail = "") => {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
};

const section = (s) => console.log(`\n── ${s} ──`);
const lastOrderUpdate = () => [...UPDATES].reverse().find(x => x.table === "ordenes");
const logs = () => INSERTS.filter(x => x.table === "orden_estado_logs").map(x => x.row);
const reset = () => {
  STORE = {};
  INSERTS = [];
  UPDATES = [];
  failLogInsert = false;
};

(async () => {
  section("Helper — timestamp patch + metadata non-PII");
  {
    const patch = buildStateTimestampPatch({
      from: "LISTO",
      to: "EN_ENTREGA",
      now: "2026-06-05T20:00:00.000Z",
      tipoConsegna: "DOMICILIO",
      extras: {},
    });
    assert("EN_ENTREGA valorizza en_entrega_at", patch.en_entrega_at === "2026-06-05T20:00:00.000Z");
    assert("EN_ENTREGA valorizza hora_salida legacy se manca", Number.isFinite(patch.hora_salida));
    const clean = sanitizeMetadata({
      tipo_consegna: "DOMICILIO",
      tel: "699000000",
      nested: { direccion: "secret", ok: true },
      items: [{ n: "secret" }],
    });
    assert("sanitizeMetadata rimuove tel", clean.tel === undefined);
    assert("sanitizeMetadata rimuove direccion annidata", clean.nested?.direccion === undefined);
    assert("sanitizeMetadata preserva campi operativi", clean.tipo_consegna === "DOMICILIO" && clean.nested.ok === true);
  }

  section("Create — ordine nuovo genera timestamp e log created");
  {
    reset();
    await creaOrdine({
      operatorManual: true,
      tipo_consegna: "RITIRO",
      hora: "20:00",
      estado: "EN_COCINA",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    const order = INSERTS.find(x => x.table === "ordenes")?.row;
    const log = logs()[0];
    assert("ordine inserito con updated_at", !!order.updated_at);
    assert("EN_COCINA inserisce en_cocina_at", !!order.en_cocina_at);
    assert("EN_COCINA da creazione inserisce confirmado_at", !!order.confirmado_at);
    assert("log created scritto", log?.event_type === "created");
    assert("log senza telefono/nome/indirizzo in metadata", !/tel|nombre|direccion/i.test(JSON.stringify(log.metadata)));
  }

  section("POR_CONFIRMAR → EN_COCINA");
  {
    reset();
    STORE["#101"] = { id: "#101", estado: "POR_CONFIRMAR", tipo_consegna: "RITIRO", manual_giro_id: null };
    const res = await cambiaStato("#101", "EN_COCINA", { actor_type: "operator", origin: "dashboard" });
    const upd = lastOrderUpdate().patch;
    const log = logs()[0];
    assert("state update success", res.success === true);
    assert("patch stato EN_COCINA", upd.estado === "EN_COCINA");
    assert("patch updated_at", !!upd.updated_at);
    assert("patch en_cocina_at", !!upd.en_cocina_at);
    assert("patch confirmado_at", !!upd.confirmado_at);
    assert("log from/to corretto", log.estado_from === "POR_CONFIRMAR" && log.estado_to === "EN_COCINA");
    assert("event_type confirmed", log.event_type === "confirmed");
  }

  section("EN_COCINA → LISTO → EN_ENTREGA → RETIRADO delivery");
  {
    reset();
    STORE["#102"] = { id: "#102", estado: "EN_COCINA", tipo_consegna: "DOMICILIO", manual_giro_id: null };
    await cambiaStato("#102", "LISTO", { actor_type: "operator", origin: "dashboard" });
    assert("LISTO valorizza listo_at", !!lastOrderUpdate().patch.listo_at);
    assert("LISTO event marked_ready", logs()[0].event_type === "marked_ready");

    await cambiaStato("#102", "EN_ENTREGA", {
      hora_salida: 123,
      actor_type: "rider",
      origin: "entregas",
    });
    const enEntregaUpd = UPDATES.filter(x => x.table === "ordenes").at(-1).patch;
    const enEntregaLog = logs().at(-1);
    assert("EN_ENTREGA valorizza en_entrega_at", !!enEntregaUpd.en_entrega_at);
    assert("EN_ENTREGA preserva hora_salida passata", enEntregaUpd.hora_salida === 123);
    assert("EN_ENTREGA actor/origin rider", enEntregaLog.actor_type === "rider" && enEntregaLog.origin === "entregas");
    assert("EN_ENTREGA event sent_delivery", enEntregaLog.event_type === "sent_delivery");

    await cambiaStato("#102", "RETIRADO", {
      hora_entrega: 456,
      cobrado: true,
      metodo_pago: "cash",
      actor_type: "rider",
      origin: "entregas",
    });
    const retiradoUpd = UPDATES.filter(x => x.table === "ordenes").at(-1).patch;
    const retiradoLog = logs().at(-1);
    assert("RETIRADO valorizza retirado_at", !!retiradoUpd.retirado_at);
    assert("RETIRADO preserva hora_entrega passata", retiradoUpd.hora_entrega === 456);
    assert("RETIRADO delivery event delivered", retiradoLog.event_type === "delivered");
  }

  section("LISTO → RETIRADO ritiro");
  {
    reset();
    STORE["#103"] = { id: "#103", estado: "LISTO", tipo_consegna: "RITIRO", manual_giro_id: null };
    await cambiaStato("#103", "RETIRADO", { actor_type: "operator", origin: "cocina" });
    const upd = lastOrderUpdate().patch;
    const log = logs()[0];
    assert("ritiro valorizza retirado_at", !!upd.retirado_at);
    assert("ritiro non inventa hora_entrega", upd.hora_entrega === undefined);
    assert("ritiro event picked_up", log.event_type === "picked_up");
  }

  section("Log failure non blocca cambio stato");
  {
    reset();
    STORE["#104"] = { id: "#104", estado: "EN_COCINA", tipo_consegna: "RITIRO", manual_giro_id: null };
    failLogInsert = true;
    const res = await cambiaStato("#104", "LISTO", {});
    assert("cambiaStato ritorna success anche se log fallisce", res.success === true);
    assert("ordine aggiornato comunque a LISTO", STORE["#104"].estado === "LISTO");
  }

  section("Helper — self-loop NON sovrascrive timestamp (live #002 2026-06-05)");
  {
    // buildStateTimestampPatch puro: from === to → solo updated_at, nessun *_at.
    const retiradoLoop = buildStateTimestampPatch({
      from: "RETIRADO",
      to: "RETIRADO",
      now: "2026-06-05T21:05:30.000Z",
      tipoConsegna: "DOMICILIO",
      extras: {},
    });
    assert("self-loop RETIRADO non valorizza retirado_at", retiradoLoop.retirado_at === undefined);
    assert("self-loop RETIRADO non re-inietta hora_entrega", retiradoLoop.hora_entrega === undefined);
    assert("self-loop RETIRADO tocca solo updated_at", Object.keys(retiradoLoop).join(",") === "updated_at");

    const listoLoop = buildStateTimestampPatch({ from: "LISTO", to: "LISTO", now: "2026-06-05T20:22:00.000Z" });
    assert("self-loop LISTO non valorizza listo_at", listoLoop.listo_at === undefined);

    const cocinaLoop = buildStateTimestampPatch({ from: "EN_COCINA", to: "EN_COCINA", now: "2026-06-05T20:00:00.000Z" });
    assert("self-loop EN_COCINA non valorizza en_cocina_at/confirmado_at",
      cocinaLoop.en_cocina_at === undefined && cocinaLoop.confirmado_at === undefined);

    // Transizione reale resta intatta (controllo di non-regressione).
    const realTransition = buildStateTimestampPatch({ from: "EN_COCINA", to: "LISTO", now: "2026-06-05T20:21:00.000Z" });
    assert("transizione reale EN_COCINA→LISTO valorizza listo_at", !!realTransition.listo_at);
  }

  section("cambiaStato — self-loop RETIRADO→RETIRADO è no-op idempotente (#002)");
  {
    reset();
    // #002 live: già RETIRADO con retirado_at del primo ritiro reale (20:35:03).
    STORE["#002"] = {
      id: "#002", estado: "RETIRADO", tipo_consegna: "DOMICILIO",
      manual_giro_id: null, retirado_at: "2026-06-05T20:35:03.000Z", wa_id: "wa#002",
    };
    const res = await cambiaStato("#002", "RETIRADO", { actor_type: "operator", origin: "dashboard" });
    assert("cambiaStato self-loop ritorna success", res.success === true);
    assert("cambiaStato self-loop flagga noop:true", res.noop === true);
    assert("retirado_at NON sovrascritto (resta primo ritiro reale)",
      STORE["#002"].retirado_at === "2026-06-05T20:35:03.000Z");
    const updPatch = lastOrderUpdate()?.patch || {};
    assert("patch self-loop non contiene retirado_at", updPatch.retirado_at === undefined);
    assert("nessun log di transizione ridondante su self-loop", logs().length === 0);
  }

  section("cambiaStato — COMPLETADO/CANCELADO self-loop no-op, niente timestamp nuovo");
  {
    reset();
    STORE["#C1"] = { id: "#C1", estado: "COMPLETADO", tipo_consegna: "RITIRO", manual_giro_id: null, completado_at: "2026-06-05T23:00:00.000Z" };
    const r1 = await cambiaStato("#C1", "COMPLETADO", {});
    assert("COMPLETADO→COMPLETADO noop", r1.success === true && r1.noop === true);
    assert("completado_at preservato", STORE["#C1"].completado_at === "2026-06-05T23:00:00.000Z");

    reset();
    STORE["#X1"] = { id: "#X1", estado: "CANCELADO", tipo_consegna: "RITIRO", manual_giro_id: null, cancelado_at: "2026-06-05T19:00:00.000Z" };
    const r2 = await cambiaStato("#X1", "CANCELADO", {});
    assert("CANCELADO→CANCELADO noop", r2.success === true && r2.noop === true);
    assert("cancelado_at preservato", STORE["#X1"].cancelado_at === "2026-06-05T19:00:00.000Z");
    assert("no log su CANCELADO self-loop", logs().length === 0);
  }

  section("cambiaStato — EN_COCINA self-loop non resetta conv/items (hook saltato)");
  {
    reset();
    STORE["#E1"] = { id: "#E1", estado: "EN_COCINA", tipo_consegna: "DOMICILIO", manual_giro_id: null, en_cocina_at: "2026-06-05T20:10:00.000Z", wa_id: "wa#E1", zona: "Q1", hora: "20:30" };
    const r = await cambiaStato("#E1", "EN_COCINA", {});
    assert("EN_COCINA→EN_COCINA noop", r.success === true && r.noop === true);
    assert("en_cocina_at preservato", STORE["#E1"].en_cocina_at === "2026-06-05T20:10:00.000Z");
    const convReset = UPDATES.some(u => u.table === "conv" && u.patch && Array.isArray(u.patch.items));
    assert("hook EN_COCINA NON eseguito su self-loop (conv.items non resettato)", convReset === false);
  }

  section("cambiaStato — undo legittimo LISTO→EN_COCINA resta permesso e logga");
  {
    reset();
    STORE["#U1"] = { id: "#U1", estado: "LISTO", tipo_consegna: "RITIRO", manual_giro_id: null, listo_at: "2026-06-05T20:21:00.000Z" };
    const r = await cambiaStato("#U1", "EN_COCINA", { actor_type: "operator", origin: "dashboard" });
    assert("undo LISTO→EN_COCINA success e NON noop", r.success === true && r.noop === false);
    assert("undo logga la transizione reale", logs().length === 1 && logs()[0].estado_to === "EN_COCINA");
  }

  section("Event type mapping");
  {
    assert("COMPLETADO -> completed", stateEventType("RETIRADO", "COMPLETADO", "RITIRO") === "completed");
    assert("CANCELADO -> cancelled", stateEventType("EN_COCINA", "CANCELADO", "DOMICILIO") === "cancelled");
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
