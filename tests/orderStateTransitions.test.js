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

  section("Event type mapping");
  {
    assert("COMPLETADO -> completed", stateEventType("RETIRADO", "COMPLETADO", "RITIRO") === "completed");
    assert("CANCELADO -> cancelled", stateEventType("EN_COCINA", "CANCELADO", "DOMICILIO") === "cancelled");
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
