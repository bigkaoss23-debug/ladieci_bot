// ===============================================================
// servizio.js — chiusura serata atomica
//
// Filosofia:
//   1. Lock-first via INSERT su serata_summary(fecha PK) → race-safe.
//   2. Backup raw SUBITO in backup_serata → safety net se tutto fallisce.
//   3. Calcolo summary completo prima di toccare nulla.
//   4. writeStorico con payload COMPLETO (33 colonne) per ogni ordine.
//   5. writeArchivioConv con onConflict(wa_id, data_servizio).
//   6. UPDATE serata_summary con valori reali.
//   7. VERIFY: count(storico WHERE fecha=oggi) >= ordini archiviati.
//      Se KO → ROLLBACK (cancella storico/serata_summary), NON tocca ordenes.
//   8. Solo dopo verify OK: cancella ordenes/conv/wa_msgs completati.
//   9. Reset config (DRIVER_STATO, ORDER_RESET_TS, LAST_CLOSE_DATE).
//
// L'operatore vede success+summary atomico, o errore preciso, mai stato a metà.
// ===============================================================

const { sbSelect, sbInsert, sbUpsert, sbUpdate, sbDelete } = require("./supabase");
const { calcolaTotale, calcolaTotaleOrdine, deliveryFeeFor, isBevanda, isDesert, direccionToCacheKey } = require("./helpers");
const { lifecycle: serviceSessionLifecycle } = require("../serviceSessions/serviceSessionLifecycle");
const { getCurrentOperationalSession, serviceSessionQuery } = require("../serviceSessions/currentOperationalSession");
// S2-7D6E2 — UNA sola fonte contabile. Il summary archiviato non ricalcola il denaro
// con una seconda regola più debole: chiama lo stesso aggregatore del closeout live.
const { aggregate: aggregateCloseout } = require("../closeout/currentServiceCloseout");

// Incrementa n_ordini_consegnati sulla riga di geo_cache associata all'indirizzo dell'ordine.
// Chiamata da chiudiServizio per ogni ordine archiviato → la "conferma indirizzo" non dipende dal bottone driver.
// Best-effort: se la migration non è applicata o la riga manca, fallisce silenziosamente con warn.
async function bumpGeoCacheDelivered(direccion, geoSource) {
  if (!direccion || !geoSource) return;
  // Solo ordini con lat/lon reali (Google/Nominatim/Photon) sono significativi per geo_cache.
  // "keyword" e null vivono fuori dalla cache, niente da incrementare.
  if (geoSource === "keyword") return;
  const key = direccionToCacheKey(direccion);
  if (!key || key.length < 5) return;
  try {
    const rows = await sbSelect("geo_cache", `direccion_key=eq.${encodeURIComponent(key)}&limit=1`);
    const row = rows?.[0];
    if (!row) return;
    // PATCH, non upsert: la colonna `zona` è NOT NULL → un INSERT-on-conflict con
    // body parziale fallirebbe la validazione INSERT prima del DO UPDATE.
    await sbUpdate("geo_cache",
      `direccion_key=eq.${encodeURIComponent(key)}`,
      { n_ordini_consegnati: (row.n_ordini_consegnati || 0) + 1 }
    );
  } catch (e) {
    console.warn("[geo_cache] n_ordini_consegnati bump failed:", e?.message || e);
  }
}


// ─── Date helpers ────────────────────────────────────────────────
// S2-6A3B — PostgREST returns 204/empty on a successful DELETE and a structured
// {code,message,details} body when the statement is rejected (a RESTRICT foreign key
// from order_financial_events, for instance). The old close path discarded that body
// and declared success, so an order that survived deletion was archived again every
// night. Every destructive delete now goes through this helper: the response is
// inspected AND the residue is re-read, so "deleted" means observed-absent.
function sbErrorOf(res) {
  if (!res) return null;
  if (Array.isArray(res)) return null;
  if (typeof res === "string") return res.trim() ? { code: "delete_unexpected_body", message: res.trim().slice(0, 300) } : null;
  if (typeof res === "object" && (res.code || res.message)) {
    return { code: res.code || "delete_error", message: String(res.message || "").slice(0, 300) };
  }
  return null;
}

async function sbDeleteVerified(table, query) {
  const res = await sbDelete(table, query);
  const err = sbErrorOf(res);
  const left = await sbSelect(table, `${query}&select=id`);
  if (!Array.isArray(left)) {
    return { ok: false, code: err?.code || "delete_verify_unreadable", message: err?.message || "residue unreadable", remaining: null, ids: [] };
  }
  if (left.length > 0) {
    return {
      ok: false,
      code: err?.code || "delete_incomplete",
      message: err?.message || `${left.length} row(s) survived the delete`,
      remaining: left.length,
      ids: left.map(r => r.id).slice(0, 20)
    };
  }
  if (err) return { ok: false, code: err.code, message: err.message, remaining: 0, ids: [] };
  return { ok: true, remaining: 0, ids: [] };
}

function madridDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${day}`;
}

function diaSemanaIta(d = new Date()) {
  const giorni = ["domenica","lunedi","martedi","mercoledi","giovedi","venerdi","sabato"];
  return giorni[d.getDay()];
}

function fasciaOraDa(hora) {
  const h = parseInt(String(hora || "").split(":")[0], 10);
  if (isNaN(h)) return "tardivo";
  if (h < 20) return "presto";
  if (h < 21) return "20:00";
  if (h < 22) return "21:00";
  return "tardivo";
}


// ─── Scan: cosa c'è prima di chiudere (read-only) ────────────────
async function scanServizio() {
  const oggi = madridDateStr();
  const currentService = await getCurrentOperationalSession();
  if (!currentService) {
    return { ok: true, data: oggi, service_session_id: null, completati: { ordini: 0, conv: 0 }, attivi: [] };
  }
  const sessionFilter = (query) => serviceSessionQuery(currentService.id, query);
  const openedAtMs = new Date(currentService.opened_at).getTime();
  if (!Number.isFinite(openedAtMs)) throw new Error("SERVICE_SESSION_OPENED_AT_INVALID");
  const conversationWindow = `ts=gte.${openedAtMs}`;
  const ordiniCompletati = await sbSelect("ordenes", sessionFilter("estado=in.(RETIRADO,COMPLETADO,COMPLETATO)")) || [];
  const convChiuse       = await sbSelect("conv", `${conversationWindow}&stato_ordine=in.(ritirata,confermata,chiusa)`) || [];
  const convAttive       = await sbSelect("conv", `${conversationWindow}&stato_ordine=not.in.(ritirata,confermata,chiusa)`) || [];
  const waMsgsAttivi     = await sbSelect("wa_msgs", `${conversationWindow}&stato=in.(NUEVO,IN_TRATTAMENTO)`) || [];
  const ordiniInCorso    = await sbSelect("ordenes", sessionFilter("estado=in.(POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA)")) || [];
  const contiMesaAperti  = await sbSelect("table_sessions", sessionFilter("status=eq.open")) || [];

  const attiviMap = {};
  (Array.isArray(convAttive)    ? convAttive    : []).forEach(c => { attiviMap[c.wa_id] = { wa_id: c.wa_id, nombre: c.nombre || c.wa_id, hora: c.hora || "", stato: c.stato_ordine || "" }; });
  (Array.isArray(waMsgsAttivi)  ? waMsgsAttivi  : []).forEach(m => { if (!attiviMap[m.wa_id]) attiviMap[m.wa_id] = { wa_id: m.wa_id, nombre: m.nombre || m.wa_id, hora: "", stato: m.stato || "" }; });
  (Array.isArray(ordiniInCorso) ? ordiniInCorso : []).forEach(o => {
    const key = o.wa_id || o.tel || o.id;
    if (!attiviMap[key]) attiviMap[key] = { wa_id: o.wa_id || o.tel || "", nombre: o.nombre || o.id || "", hora: o.hora || "", stato: o.estado || "" };
  });
  (Array.isArray(contiMesaAperti) ? contiMesaAperti : []).forEach(session => {
    const key = `mesa:${session.table_id || session.id}`;
    attiviMap[key] = {
      wa_id: "",
      nombre: session.table_ref || "Mesa",
      hora: "",
      stato: "CUENTA_ABIERTA",
    };
  });

  return {
    ok: true,
    data: oggi,
    service_session_id: currentService.id,
    blocking: {
      orders: Array.isArray(ordiniInCorso) ? ordiniInCorso.length : 0,
      tables: Array.isArray(contiMesaAperti) ? contiMesaAperti.length : 0,
    },
    completati: {
      ordini: Array.isArray(ordiniCompletati) ? ordiniCompletati.length : 0,
      conv:   Array.isArray(convChiuse)       ? convChiuse.length       : 0
    },
    attivi: Object.values(attiviMap)
  };
}


// ─── Backup raw: snapshot completo della serata in 1 riga ────────
// Indipendente da tutto. Anche se la chiusura fallisce, qui c'è tutto.
async function backupSerata({ serviceSessionId = null } = {}) {
  const oggi = madridDateStr();
  let targetSessionId = serviceSessionId;
  if (!targetSessionId) {
    const currentService = await getCurrentOperationalSession();
    targetSessionId = currentService?.id || null;
  }
  if (!targetSessionId) {
    return { success: false, error: "NO_OPEN_SERVICE_SESSION", n_ordini: 0, totale: 0 };
  }
  const ordini = await sbSelect("ordenes", serviceSessionQuery(targetSessionId, "select=*")) || [];
  const lista = Array.isArray(ordini) ? ordini : [];

  let totale = 0, nPizze = 0, nBevande = 0, nDessert = 0;
  for (const o of lista) {
    const t = Number(o.totale) || 0;
    totale += (t > 0) ? t : calcolaTotaleOrdine(o.items || [], o.tipo_consegna || "RITIRO");
    for (const it of (o.items || [])) {
      const nome = it.n || "";
      if (!nome || nome === "Entrega a domicilio") continue;
      const cat = it.cat || "";
      const q = parseInt(it.q || 1) || 1;
      if (cat === "Bebidas" || isBevanda(nome))      nBevande += q;
      else if (cat === "Postres" && nome !== "Pizza Nutella") nDessert += q;
      else if (isDesert(nome))                       nDessert += q;
      else                                           nPizze += q;
    }
  }

  const res = await sbInsert("backup_serata", {
    fecha: oggi,
    ts_backup: Date.now(),
    n_ordini: lista.length,
    totale: Math.round(totale * 100) / 100,
    n_pizze: nPizze,
    n_bevande: nBevande,
    n_dessert: nDessert,
    ordini: lista
  });

  return {
    success: Array.isArray(res) && res.length > 0,
    service_session_id: targetSessionId,
    n_ordini: lista.length,
    totale: Math.round(totale * 100) / 100
  };
}


// ─── Classificazione item (cat prima, fallback su nome) ──────────
function classificaItem(it) {
  const nome = it?.n || "";
  if (!nome || nome === "Entrega a domicilio") return null;
  const cat = it?.cat || "";
  if (cat === "Bebidas" || isBevanda(nome)) return "bevanda";
  if (cat === "Postres" && nome !== "Pizza Nutella") return "dessert";
  if (isDesert(nome)) return "dessert";
  return "pizza";
}


// S2-7D6E2 — `metodoPagoKey` è stato rimosso di proposito. Mappava metodo_pago →
// bucket cassa_*, cioè trattava un INTENTO di pagamento come prova di incasso.
// Il breakdown ora deriva da order_financial_events via aggregateCloseout.


// ─── Costruisci payload storico COMPLETO da un ordine ────────────
// Ogni colonna di ordenes che ha senso archiviare → finisce qui.
function buildStoricoPayload(o, oggi, diaSemana, estadoOverride = null, serviceSessionId = null) {
  const tipoConsegna = o.tipo_consegna || "RITIRO";
  const deliveryFee  = (o.delivery_fee != null) ? Number(o.delivery_fee) : deliveryFeeFor(tipoConsegna);
  const totale       = (Number(o.totale) > 0) ? Number(o.totale) : calcolaTotaleOrdine(o.items || [], tipoConsegna);

  return {
    orden_id:       o.id || "",
    service_session_id: serviceSessionId || o.service_session_id || null,
    client_req_id:  o.client_req_id || null,
    cliente_id:     o.cliente_id || null,
    nombre:         o.nombre || "",
    tel:            o.tel || "",
    wa_id:          o.wa_id || "",
    canal:          o.canal || "WA",
    items:          o.items || [],
    nota:           o.nota || "",
    nota_cucina:    o.nota_cucina || "",
    hora:           o.hora || "",
    estado:         estadoOverride || o.estado || "",
    totale,
    delivery_fee:   deliveryFee,
    tipo_consegna:  tipoConsegna,
    descuento_tipo:    o.descuento_tipo    || null,
    descuento_valor:   o.descuento_valor != null ? Number(o.descuento_valor) : null,
    descuento_importe: o.descuento_importe != null ? Number(o.descuento_importe) : null,
    metodo_pago:    o.metodo_pago || "",
    cobrado:        o.cobrado === true,
    ya_pagado:      o.ya_pagado === true,
    direccion:      o.direccion || null,
    direccion_note: o.direccion_note || null,
    zona:           o.zona || null,
    zona_lat:       o.zona_lat != null ? Number(o.zona_lat) : null,
    zona_lon:       o.zona_lon != null ? Number(o.zona_lon) : null,
    zona_manuale:   o.zona_manuale === true,
    repartidor:     o.repartidor || null,
    hora_salida:    o.hora_salida ? Number(o.hora_salida) : null,
    hora_entrega:   o.hora_entrega ? Number(o.hora_entrega) : null,
    llegado:        o.llegado === true,
    cucina_check:   o.cucina_check || null,
    // Mesa identity must survive the ordenes -> storico move so customer bills,
    // closeout and kitchen-command history keep the original physical table.
    table_session_id:      o.table_session_id || null,
    table_number_snapshot: o.table_number_snapshot != null ? Number(o.table_number_snapshot) : null,
    table_name_snapshot:   o.table_name_snapshot || null,
    table_command_number:  o.table_command_number != null ? Number(o.table_command_number) : null,
    fecha:          oggi,
    dia_semana:     diaSemana,
    fascia_ora:     fasciaOraDa(o.hora),
    ts:             o.ts || Date.now()
  };
}


// ─── Calcolo summary aggregata (pure, no side effects) ───────────
async function computeSummary(ordiniDaArch, oggi, diaSemana, source, sessionOpenedAt = null, financialEvents = []) {
  const summary = {
    fecha: oggi,
    dia_semana: diaSemana,
    ts_chiusura: Date.now(),
    source,
    n_ordini: 0,
    n_pizze: 0, n_bevande: 0, n_dessert: 0,
    n_delivery: 0, n_ritiro: 0,
    n_clienti_unici: 0, n_clienti_nuovi: 0,
    cassa_totale: 0,
    cassa_efectivo: 0, cassa_tarjeta: 0, cassa_bizum: 0, cassa_non_specificato: 0,
    delivery_fee_totale: 0,
    n_domande_gestite: 0,
    per_zona: {},
    per_fascia: {},
    per_canal: {},
    errori: null
  };

  const telSet = new Set();

  for (const o of ordiniDaArch) {
    summary.n_ordini++;

    const tipoConsegna = o.tipo_consegna || "RITIRO";
    const deliveryFee  = (o.delivery_fee != null) ? Number(o.delivery_fee) : deliveryFeeFor(tipoConsegna);
    const totale       = (Number(o.totale) > 0) ? Number(o.totale) : calcolaTotaleOrdine(o.items || [], tipoConsegna);

    summary.cassa_totale += totale;
    summary.delivery_fee_totale += deliveryFee;

    // Delivery vs Ritiro
    if (tipoConsegna === "DOMICILIO") summary.n_delivery++; else summary.n_ritiro++;

    // Items: pizze/bevande/dessert
    for (const it of (o.items || [])) {
      const kind = classificaItem(it);
      if (!kind) continue;
      const q = parseInt(it.q || 1) || 1;
      if (kind === "pizza")        summary.n_pizze   += q;
      else if (kind === "bevanda") summary.n_bevande += q;
      else if (kind === "dessert") summary.n_dessert += q;
    }

    // Clienti unici (per tel)
    const telKey = String(o.tel || o.wa_id || "").trim();
    if (telKey) telSet.add(telKey);

    // Per zona
    if (o.zona) {
      if (!summary.per_zona[o.zona]) summary.per_zona[o.zona] = { n: 0, eur: 0 };
      summary.per_zona[o.zona].n   += 1;
      summary.per_zona[o.zona].eur += totale;
    }

    // Per fascia
    const f = fasciaOraDa(o.hora);
    if (!summary.per_fascia[f]) summary.per_fascia[f] = { n: 0, eur: 0 };
    summary.per_fascia[f].n   += 1;
    summary.per_fascia[f].eur += totale;

    // Per canale
    const canal = (o.canal || "MANUAL").toUpperCase();
    summary.per_canal[canal] = (summary.per_canal[canal] || 0) + 1;
  }

  // S2-7D6E2 — il breakdown cassa è LEDGER-DERIVED, attraverso la stessa funzione
  // usata dal closeout live. `metodo_pago` dichiara un INTENTO; non ha mai provato
  // un incasso. Sommare `totale` per metodo riportava 12.00 incassati su un ordine
  // senza alcun payment event, mentre il closeout live riportava correttamente 0.00
  // (staging #723). cassa_totale resta LORDO (fatturato); i bucket cassa_* sono
  // quanto è stato realmente incassato, quindi
  // pendiente = cassa_totale - (efectivo + tarjeta + bizum + non_specificato).
  // Nessuna colonna nuova, e il numero archiviato ora è uguale al live per costruzione.
  const ledger = aggregateCloseout({ id: null, status: "closing" }, ordiniDaArch, financialEvents || []);
  summary.cassa_efectivo        = ledger.paymentTotals.efectivo;
  summary.cassa_tarjeta         = ledger.paymentTotals.tarjeta;
  summary.cassa_bizum           = ledger.paymentTotals.bizum;
  summary.cassa_non_specificato = ledger.paymentTotals.other;

  // Arrotonda i monetari a 2 cifre
  summary.cassa_totale          = Math.round(summary.cassa_totale * 100) / 100;
  summary.cassa_efectivo        = Math.round(summary.cassa_efectivo * 100) / 100;
  summary.cassa_tarjeta         = Math.round(summary.cassa_tarjeta * 100) / 100;
  summary.cassa_bizum           = Math.round(summary.cassa_bizum * 100) / 100;
  summary.cassa_non_specificato = Math.round(summary.cassa_non_specificato * 100) / 100;
  summary.delivery_fee_totale   = Math.round(summary.delivery_fee_totale * 100) / 100;
  for (const z in summary.per_zona)   summary.per_zona[z].eur   = Math.round(summary.per_zona[z].eur * 100) / 100;
  for (const f in summary.per_fascia) summary.per_fascia[f].eur = Math.round(summary.per_fascia[f].eur * 100) / 100;

  summary.n_clienti_unici = telSet.size;

  // S2-7D6B — these two counts used to start from "midnight of the business
  // date", computed with a LITERAL +02:00 offset. Two bugs in one line: it was
  // wrong every winter (Madrid is UTC+1 in CET), and with two services a day the
  // dinner summary re-counted the whole of lunch's WhatsApp traffic.
  //
  // The window now starts at the moment THIS session opened, so lunch and dinner
  // count only their own, and the offset is derived from the real timezone.
  const windowStartIso = sessionOpenedAt
    ? new Date(sessionOpenedAt).toISOString()
    : madridStartOfDayIso(oggi);
  const windowStartMs = new Date(windowStartIso).getTime();

  try {
    const clientiNuovi = await sbSelect("clientes", `created_at=gte.${windowStartIso}&tel=in.(${[...telSet].map(t => `"${t}"`).join(",") || '""'})`);
    summary.n_clienti_nuovi = Array.isArray(clientiNuovi) ? clientiNuovi.length : 0;
  } catch (_) { summary.n_clienti_nuovi = 0; }

  // Domande gestite: wa_msgs di questa sessione con stato IN_TRATTAMENTO o
  // COMPLETATO (NUEVO = mai gestito, COCINA = già ordine — escludiamo)
  try {
    const waSessione = await sbSelect("wa_msgs", `ts=gte.${windowStartMs}&stato=in.(IN_TRATTAMENTO,COMPLETATO)`);
    summary.n_domande_gestite = Array.isArray(waSessione) ? waSessione.length : 0;
  } catch (_) { summary.n_domande_gestite = 0; }

  return summary;
}

// Midnight of a business date in Europe/Madrid, as a real instant. Derives the
// offset from the zone itself rather than assuming CEST, so it is correct on
// both sides of the DST switch.
function madridStartOfDayIso(businessDate) {
  const naiveUtc = new Date(`${businessDate}T00:00:00Z`);
  const asMadrid = new Date(naiveUtc.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
  const asUtc = new Date(naiveUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = asMadrid.getTime() - asUtc.getTime();
  return new Date(naiveUtc.getTime() - offsetMs).toISOString();
}


// ─── ENTRY POINT: chiudiServizio ─────────────────────────────────
// Ritorna SEMPRE oggetto con shape consistente:
//   { success: true, summary: {...}, data: "YYYY-MM-DD" }
//   { skipped: true, reason: "already_closed_today" | "race_lost", data }
//   { success: false, error: "verify_failed" | "...", details: {...} }
// closeContext — SERVICE CLOSEOUT V2 / SLICE 4C.1. Server-internal only: never
// derived from req.query/req.body anywhere (see the manual "chiudiServizio"
// HTTP action in index.js, which always calls this with exactly 3
// arguments). The single recognized key today:
//   allowOpenTablesAcrossBoundary — a table_session's lifecycle is allowed to
//     span a service-session boundary (accepted cross-service Mesa contract:
//     table_session.service_session_id is historical "where it was opened"
//     metadata, never rewritten at close; a NEW order on that same table
//     after rollover attributes to service_session_state.current_session_id,
//     unchanged code elsewhere). Only performIncidentSafeRollover's own call
//     sets this true, for the AUTOMATIC/REQUIRED rollover path specifically —
//     manual close (index.js "chiudiServizio" action) and the S2-1G deferred-
//     close retry both omit it and keep the historical conservative gate.
// SERVICE LIFECYCLE RUNTIME AUTHORITY RECOVERY — preserveActiveOrders.
//
// deleteAttivi=true used to bundle two decisions into one boolean: (1) let a
// residual non-terminal order pass through without blocking the close, and
// (2) permanently archive+remove that order as force-closed. Every automatic
// caller only ever wanted (1) -- (2) is meant for an explicit, human-
// initiated force-close only (the manual HTTP action's own operator-supplied
// flag). The automatic rollover orchestrator inherited (2) unintentionally,
// proven live: a deliberately-preserved synthetic test record (explicitly
// marked "never remove") was force-archived and folded into a real
// accounting total the moment a stale session finally advanced.
//
// preserveActiveOrders=true keeps (1) and drops (2): a non-terminal order is
// left completely untouched -- same row, same status, still fully workable
// downstream -- instead of being archived/force-terminalized. The incident
// records already written before this function runs remain the truthful,
// persisted account of the residue; this flag only stops the archive step
// from also erasing the evidence those incidents describe.
//
// Purely additive and scoped to one caller (the automatic orchestrator). The
// manual force-close action and the frozen legacy automatic path never set
// it, so deleteAttivi=true's existing behavior for both is unchanged.
async function chiudiServizio(deleteAttivi = false, source = "manual", actor = "system", closeContext = {}) {
  const allowOpenTablesAcrossBoundary = !!closeContext && closeContext.allowOpenTablesAcrossBoundary === true;
  const preserveActiveOrders = !!closeContext && closeContext.preserveActiveOrders === true;
  // STALE_SERVICE_SESSION_SELF_HEAL (2026-08-15) — same cross-boundary posture
  // as allowOpenTablesAcrossBoundary, applied to the one remaining gate that
  // never got an equivalent bypass when preserveActiveOrders/
  // allowOpenTablesAcrossBoundary were added. See the ACTIVE-TRIP GATE below.
  const allowActiveRiderTripAcrossBoundary = !!closeContext && closeContext.allowActiveRiderTripAcrossBoundary === true;
  // Never block on a residual order (deleteAttivi OR preserveActiveOrders).
  const skipActiveOrderBlock = deleteAttivi || preserveActiveOrders;
  // Whether non-terminal orders actually get archived+removed this call.
  const archiveActiveOrders = deleteAttivi && !preserveActiveOrders;
  // Session identity is established by the authoritative lifecycle pointer, never
  // by today's date or by selecting the newest summary.
  const currentIdentity = await serviceSessionLifecycle.currentCloseout();
  if (!currentIdentity?.ok) return { success: false, error: currentIdentity?.code || "service_session_identity_failed" };
  if (currentIdentity.code === "NO_SERVICE_SESSION") return { success: false, error: "NO_SERVICE_SESSION" };
  if (currentIdentity.session?.status === "closed") {
    return { skipped: true, reason: "already_closed_session", service_session_id: currentIdentity.session.id };
  }
  if (!currentIdentity.session?.id || !currentIdentity.session.business_date || !["open","closing"].includes(currentIdentity.session.status)) {
    return { success: false, error: "invalid_service_session_identity" };
  }
  const oggi = currentIdentity.session.business_date;
  // Derived from the immutable opening business date, not the close clock date
  // (a service may close after midnight).
  const diaSemana = diaSemanaIta(new Date(`${oggi}T12:00:00Z`));

  // "Dejar mensajes activos" may preserve WhatsApp conversations, but it must
  // never close the accounting container around a live order. That was the hole
  // that allowed a closed service to retain an EN_COCINA row. Refuse before any
  // rider lock, summary write, archive, or delete so the failure is read-only.
  if (!skipActiveOrderBlock) {
    let serviceOrders;
    try {
      serviceOrders = await sbSelect(
        "ordenes",
        `service_session_id=eq.${encodeURIComponent(currentIdentity.session.id)}`
          + "&select=id,estado&limit=200",
      );
    } catch (error) {
      console.warn(`[chiudiServizio ${source}] active-order gate failed:`, error?.message || error);
      return { success: false, error: "service_active_order_gate_failed", deferred: true, data: oggi };
    }
    if (!Array.isArray(serviceOrders)) {
      return { success: false, error: "service_active_order_gate_failed", deferred: true, data: oggi };
    }
    // Classify in application code instead of relying on SQL `not.in`: SQL's
    // NULL semantics would otherwise omit an order whose state is missing. An
    // unknown/null state is unresolved and must fail closed as well.
    const terminalOrderStates = new Set([
      "RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO",
      "CANCELLED", "ANULADO", "CHIUSO_FORZATO",
    ]);
    const activeOrders = serviceOrders.filter(
      (row) => !terminalOrderStates.has(String(row?.estado || "").toUpperCase()),
    );
    if (activeOrders.length > 0) {
      return {
        success: false,
        error: "service_active_orders_not_resolved",
        deferred: true,
        data: oggi,
        details: {
          count: activeOrders.length,
          orders: activeOrders.map((row) => ({ id: row.id, estado: row.estado })),
        },
      };
    }
  }

  // A table account has a lifecycle beyond the individual kitchen tickets. Even
  // if every command is terminal, the service must not archive/delete its orders
  // while money is still due. Full payment closes the account and frees the Mesa.
  // This gate runs before the rider gate and before beginClose, so refusal is
  // entirely read-only and leaves the service open for the operator.
  let openTableAccounts;
  try {
    openTableAccounts = await sbSelect(
      "table_sessions",
      `service_session_id=eq.${encodeURIComponent(currentIdentity.session.id)}`
        + "&status=eq.open",
    );
  } catch (error) {
    console.warn(`[chiudiServizio ${source}] Mesa gate failed:`, error?.message || error);
    return { success: false, error: "mesa_table_gate_failed", deferred: true, data: oggi };
  }
  if (!Array.isArray(openTableAccounts)) {
    return { success: false, error: "mesa_table_gate_failed", deferred: true, data: oggi };
  }
  if (openTableAccounts.length > 0 && !allowOpenTablesAcrossBoundary) {
    const detailsByTable = new Map();
    openTableAccounts.forEach((row) => detailsByTable.set(String(row.table_id || row.id), {
      id: row.table_id || row.id,
      name: row.table_ref || "Mesa",
      status: "open",
    }));
    return {
      success: false,
      error: "mesa_tables_not_released",
      deferred: true,
      data: oggi,
      details: {
        count: detailsByTable.size,
        tables: Array.from(detailsByTable.values()),
      },
    };
  }
  // SLICE 4C.1 — allowOpenTablesAcrossBoundary=true (automatic rollover only):
  // an occupied table is a legitimate operational entity spanning the
  // service-session boundary, not a blocker. Nothing below this point ever
  // reads or writes table_sessions again — the row(s) in openTableAccounts
  // are left exactly as they are: same id, same status='open', same historical
  // service_session_id. The genuinely-empty case (covers_total IS NULL) is
  // handled entirely elsewhere, BEFORE this function is even called, by
  // rolloverClassifier.js's safe-auto-action + incidentSafeRollover.js's
  // releaseEmptyTableSession — this gate never distinguishes empty from
  // occupied, it simply stops blocking on open table_sessions at all.

  // ─── PASSO 1b (S2-1F): ACTIVE-TRIP GATE ───────────────────────
  // A service close must NEVER run destructively over an active rider trip (PASSO 6/10
  // archive+delete ordenes, which would hide/erase active-trip members). The transactional
  // reset_rider_state_if_idle() is the sole authority (advisory-locked, service-role-only):
  //   • no active trip -> establishes idle state, we continue;
  //   • active trip     -> ACTIVE_TRIP_CONFLICT, no mutation -> defer close, preserve all;
  //   • unexpected error -> FAIL CLOSED (do not archive/delete anything).
  // No direct config read is used as the authority.
  let riderGate;
  try {
    riderGate = await require("../agents/riderTrip").beginServiceCloseIfIdle({ serviceDate: oggi, source });
  } catch (e) {
    console.warn(`[chiudiServizio ${source}] rider-state gate failed:`, e?.message || e);
    return { success: false, error: "rider_state_gate_failed", deferred: true, data: oggi };
  }
  const gateBody = riderGate && riderGate.payload;
  const closeId = gateBody && (gateBody.close_id || gateBody.marker?.close_id);
  const endClose = async (label) => {
    try { await require("../agents/riderTrip").endServiceClose(closeId); }
    catch (e) { console.warn(`[chiudiServizio] endServiceClose (${label}) failed:`, e?.message || e); }
  };
  if (gateBody && gateBody.error === "ACTIVE_TRIP_CONFLICT") {
    // STALE_SERVICE_SESSION_SELF_HEAL (2026-08-15) — proven live on staging:
    // an active rider trip is a genuinely real, unresolved fact. This call
    // NEVER clears, completes, or mutates it: closeId stays unset (nothing
    // below this point calls beginServiceCloseIfIdle again, and endClose's
    // no-op-on-no-marker semantics make every later cleanup call harmless),
    // and config.DRIVER_STATO.active_trip is not written by anything in this
    // function. The trip can still close normally later via the existing
    // close_rider_trip reconciliation path once its member orders reach a
    // terminal state — a separate, real, out-of-scope operational fact, not
    // something this flag papers over. What this flag changes is only
    // whether the trip's mere existence is allowed to keep the SERVICE
    // SESSION boundary stuck — exactly the same posture
    // allowOpenTablesAcrossBoundary already gives an occupied Mesa table.
    // Only the incident-safe rollover call site ever sets this flag; the
    // manual HTTP close action and the frozen legacy retry path never do, so
    // a human explicitly closing the service keeps today's exact behavior.
    if (allowActiveRiderTripAcrossBoundary) {
      // language-guard: allow-legacy chiudiServizio is this existing function's own name, logged verbatim exactly like every other log line in this file, not new vocabulary
      console.warn(`[chiudiServizio ${source}] active rider trip present but crossing the service boundary unarchived (allowActiveRiderTripAcrossBoundary) — trip state untouched`);
    } else {
      // language-guard: allow-legacy chiudiServizio is this existing function's own name, not new vocabulary
      console.warn(`[chiudiServizio ${source}] DEFERRED — active rider trip in progress; no archival/deletion performed`);
      // language-guard: allow-legacy oggi is this existing function's own pre-existing business_date variable, unchanged, not new vocabulary
      return { skipped: true, deferred: true, reason: "active_rider_trip", data: oggi };
    }
  } else if (!(gateBody && gateBody.ok)) {
    console.warn(`[chiudiServizio ${source}] rider-state gate not ok; failing closed`);
    return { success: false, error: "rider_state_gate_failed", deferred: true, data: oggi };
  }

  // Only after the active-trip gate succeeds may the service become `closing`.
  // A deferred rider trip therefore leaves the session open and orderable.
  const sessionClose = await serviceSessionLifecycle.beginClose({ actor, source });
  if (!sessionClose?.ok) { await endClose("session-begin-failed"); return { success: false, error: sessionClose?.code || "service_session_close_failed" }; }
  if (sessionClose.code === "ALREADY_CLOSED") {
    await endClose("already-closed-session");
    return { skipped: true, reason: "already_closed_session", service_session_id: sessionClose.session?.id || null };
  }
  const serviceSession = sessionClose.session;
  if (!serviceSession?.id || serviceSession.business_date !== oggi || serviceSession.status !== "closing") {
    await endClose("session-identity-mismatch");
    return { success: false, error: "invalid_service_session_identity" };
  }
  const serviceSessionId = serviceSession.id;
  const sessionFilter = `service_session_id=eq.${encodeURIComponent(serviceSessionId)}`;

  // ─── PASSO 1: già chiuso oggi? ────────────────────────────────
  // If a previous close crashed after creating serata_summary, the persisted marker makes
  // this a recovery pass: continue through idempotent archive/cleanup and release only on
  // full success. Without a resumed marker, preserve the historical skip and release the
  // just-created gate before any destructive operation.
  const existing = await sbSelect("serata_summary", `${sessionFilter}&limit=1`);
  const summaryAlreadyExists = Array.isArray(existing) && existing.length > 0;
  // An existing summary for this exact session means crash recovery. A duplicate
  // completed close was already handled by the lifecycle's explicit recent pointer.

  // ─── PASSO 2: backup raw SUBITO (safety net) ──────────────────
  const bkp = await backupSerata({ serviceSessionId }).catch(e => {
    console.error(`[chiudiServizio ${source}] backup fallito:`, e);
    return { success: false };
  });

  // ─── PASSO 3: leggi tutti gli ordini target ───────────────────
  const ordCompletati = await sbSelect("ordenes", `${sessionFilter}&estado=in.(RETIRADO,COMPLETADO,COMPLETATO)`) || [];
  // language-guard: allow-legacy — COMPLETATO is the pre-existing estado enum literal in this filter string; only the ternary condition (archiveActiveOrders) changed on this line.
  const ordAttivi     = archiveActiveOrders ? (await sbSelect("ordenes", `${sessionFilter}&estado=not.in.(RETIRADO,COMPLETADO,COMPLETATO)`) || []) : [];
  const ordiniDaArch  = [
    ...(Array.isArray(ordCompletati) ? ordCompletati : []),
    ...(Array.isArray(ordAttivi)     ? ordAttivi.map(o => ({ ...o, estado: "CHIUSO_FORZATO" })) : [])
  ];

  // ─── PASSO 4: compute summary ─────────────────────────────────
  // S2-7D6B — scoped to THIS session's opening instant and stamped with its
  // kind, so lunch and dinner produce two genuinely independent summaries on one
  // business date instead of the dinner one absorbing lunch's numbers.
  const serviceKind = serviceSession.service_kind || null;
  const financialEvents = await sbSelect("order_financial_events", `${sessionFilter}&order=created_at.asc`);
  const summary = await computeSummary(
    ordiniDaArch, oggi, diaSemana, source, serviceSession.opened_at,
    Array.isArray(financialEvents) ? financialEvents : []
  );
  summary.service_session_id = serviceSessionId;
  summary.service_kind = serviceKind;

  // ─── PASSO 5: lock via INSERT serata_summary (PK su fecha) ────
  // Se due processi tentano contemporaneamente, solo uno passa.
  const lockResult = summaryAlreadyExists ? [{ recovered: true }] : await sbInsert("serata_summary", summary);
  const lockOk = Array.isArray(lockResult) && lockResult.length > 0;
  if (!lockOk) {
    // Conflitto chiave primaria → un altro processo è già passato in mezzo a noi
    const errCode = lockResult?.code || lockResult?.[0]?.code || "";
    if (errCode === "23505") {
      await endClose("race-lost");
      return { skipped: true, reason: "race_lost", data: oggi };
    }
    await endClose("lock-failed");
    return { success: false, error: "lock_failed", details: lockResult };
  }

  // Da qui in poi siamo gli unici a chiudere — il lock vive in serata_summary.

  // ─── PASSO 6: writeStorico (payload COMPLETO) ─────────────────
  const erroriStorico = [];
  let storicoOk = 0;
  for (const o of ordiniDaArch) {
    // language-guard: allow-legacy — CHIUSO_FORZATO is the pre-existing terminal-estado literal; only the condition (archiveActiveOrders) changed on this line.
    const isAttivo = archiveActiveOrders && o.estado === "CHIUSO_FORZATO";
    if (String(o.service_session_id || "") !== String(serviceSessionId)) {
      erroriStorico.push(o.id || "?");
      continue;
    }
    const payload = buildStoricoPayload(o, oggi, diaSemana, isAttivo ? "CHIUSO_FORZATO" : null, serviceSessionId);
    const res = await sbUpsert("storico", payload, "service_session_id,orden_id");
    if (!Array.isArray(res) || res.length === 0) erroriStorico.push(o.id || "?");
    else {
      storicoOk++;
      // Conferma indirizzo via segnale "ordine archiviato" — indipendente dal bottone driver.
      // Ordini CHIUSO_FORZATO non contano (non sono andati a buon fine).
      if (!isAttivo) await bumpGeoCacheDelivered(o.direccion, o.geo_source);
    }
  }

  // ─── PASSO 7: writeArchivioConv ───────────────────────────────
  const convCompletate = await sbSelect("conv", "stato_ordine=in.(ritirata,confermata,chiusa)") || [];
  // language-guard: allow-legacy — stato_ordine is the pre-existing column/filter name; only the ternary condition (archiveActiveOrders) changed on this line.
  const convAttive     = archiveActiveOrders ? (await sbSelect("conv", "stato_ordine=not.in.(ritirata,confermata,chiusa)") || []) : [];
  const convDaArch     = [
    ...(Array.isArray(convCompletate) ? convCompletate : []),
    ...(Array.isArray(convAttive)     ? convAttive.map(c => ({ ...c, _forzata: true })) : [])
  ];

  const erroriConv = [];
  let convOk = 0;
  for (const c of convDaArch) {
    const totale = calcolaTotale(c.items || []);
    const res = await sbUpsert("archivio_conv", {
      data_servizio: oggi,
      // S2-7D6B — the archive is now keyed (service_session_id, wa_id). Without
      // it, a customer who orders at lunch AND at dinner had their lunch
      // conversation silently overwritten by the dinner one.
      service_session_id: serviceSessionId,
      wa_id:         c.wa_id || "",
      nombre:        c.nombre || "",
      chat:          c.chat || [],
      items:         c.items || [],
      totale,
      hora:          c.hora || "",
      stato_finale:  c._forzata ? "CHIUSO_FORZATO" : (c.stato_ordine || ""),
      n_messaggi:    (c.chat || []).length,
      ts:            c.ts || Date.now()
    }, "service_session_id,wa_id");
    if (!Array.isArray(res) || res.length === 0) erroriConv.push(c.wa_id || "?");
    else convOk++;
  }

  // ─── PASSO 8: VERIFY ──────────────────────────────────────────
  // Numero righe storico per fecha=oggi >= ordini archiviati attesi?
  // S2-6A3B — the archive is keyed on (service_session_id, orden_id) and upserted, so a
  // resumed close rewrites its own rows instead of appending. Verification is therefore
  // an exact structural match — one archive row per archived order, no extras — rather
  // than the old ">=", which silently tolerated the duplicates a retry used to create.
  const storicoCheck = await sbSelect("storico", `${sessionFilter}&select=orden_id,service_session_id`);
  const storicoActual = Array.isArray(storicoCheck) ? storicoCheck.length : 0;
  const storicoDistinct = Array.isArray(storicoCheck) ? new Set(storicoCheck.map(r => String(r.orden_id))).size : 0;
  const expectedIds = new Set(ordiniDaArch.map(o => String(o.id)));
  const storicoDuplicates = storicoActual - storicoDistinct;
  const verifyOk =
    erroriStorico.length === 0 &&
    storicoDuplicates === 0 &&
    storicoDistinct === expectedIds.size &&
    storicoActual === storicoOk;

  if (!verifyOk) {
    // ROLLBACK: cancella storico e serata_summary di oggi. NON tocca ordenes.
    // L'operatore vede l'errore, può riprovare. Backup raw resta in backup_serata.
    await sbDelete("storico", sessionFilter);
    await sbDelete("serata_summary", sessionFilter);
    // S2-1H — archive/rollback has begun; keep the service_closing marker for recovery.
    return {
      success: false,
      error: "verify_failed",
      details: {
        expected: storicoOk,
        actual:   storicoActual,
        duplicates: storicoDuplicates,
        distinct: storicoDistinct,
        erroriStorico,
        erroriConv,
        backupOk: !!bkp?.success
      }
    };
  }

  // ─── PASSO 9: aggiorna serata_summary con eventuali errori conv ─
  if (erroriConv.length > 0) {
    await sbUpdate("serata_summary", sessionFilter, {
      errori: { storico: erroriStorico, conv: erroriConv }
    });
  }

  // ─── PASSO 9.5: soft-dissolve manual giros ────────────────────
  // DELIVERY-MANUAL-GIRO-01 P1C.1 hook: detach every order still attached
  // to a manual giro and soft-dissolve every still-active giro BEFORE
  // PASSO 10 wipes ordenes rows. Lazy require to avoid the circular dep
  // (manualGiros.js imports madridDateStr from this very file). Best-effort:
  // failures are logged but MUST NOT block the closure flow.
  let manualGirosClose = { dissolved_count: 0, detached_count: 0, errors: [] };
  try {
    const { softDissolveActiveManualGirosForClose } = require("../agents/manualGiros");
    manualGirosClose = await softDissolveActiveManualGirosForClose();
    if (Array.isArray(manualGirosClose.errors) && manualGirosClose.errors.length) {
      console.warn(`[chiudiServizio ${source}] manual_giros soft-dissolve partial errors:`, manualGirosClose.errors);
    }
  } catch (e) {
    console.warn(`[chiudiServizio ${source}] manual_giros soft-dissolve failed:`, e?.message || e);
  }

  // ─── PASSO 10: cleanup ordenes/conv/wa_msgs ───────────────────
  // Financial events are never deleted here — they are immutable evidence and outlive
  // the live order by design. Only conv/wa_msgs/ordenes rows of THIS session are removed.
  // S2-7D6B — a LUNCH close must not wipe runtime state the dinner still needs.
  // These two deletes are global by stato (conv/wa_msgs carry no session id), so
  // for PRANZO we keep them: the same customer may already be mid-conversation
  // for tonight, and archiving lunch is no reason to erase that. The evening
  // close still performs the full sweep, which is where it belongs.
  const isLunchClose = serviceKind === "PRANZO";
  if (!isLunchClose) {
    await sbDelete("conv",    "stato_ordine=in.(ritirata,confermata,chiusa)");
    await sbDelete("wa_msgs", "stato=in.(COMPLETATO,COCINA)");
  } else {
    console.log(`[chiudiServizio ${source}] PRANZO — conv/wa_msgs preservati per il servizio serale`);
  }

  const deleteFailures = [];
  const delTerminali = await sbDeleteVerified("ordenes", `${sessionFilter}&estado=in.(RETIRADO,COMPLETADO,COMPLETATO)`);
  if (!delTerminali.ok) deleteFailures.push({ scope: "terminali", ...delTerminali });

  if (archiveActiveOrders) {
    if (!isLunchClose) {
      await sbDelete("conv",    "stato_ordine=not.in.(ritirata,confermata,chiusa)");
      await sbDelete("wa_msgs", "stato=neq.COMPLETATO");
    }
    const delAttivi = await sbDeleteVerified("ordenes", `${sessionFilter}&estado=not.in.(RETIRADO,COMPLETADO,COMPLETATO)`);
    if (!delAttivi.ok) deleteFailures.push({ scope: "attivi", ...delAttivi });
  }

  // A service is closed only once its orders are observed gone. If any survived, the
  // session stays `closing`: the operator sees a controlled, observable error and the
  // next attempt resumes THIS session, upserting the same archive rows instead of
  // appending a fresh CHIUSO_FORZATO duplicate every night.
  if (deleteFailures.length > 0) {
    console.error(`[chiudiServizio ${source}] ORDER CLEANUP FAILED — session ${serviceSessionId} left closing:`, JSON.stringify(deleteFailures));
    return {
      success: false,
      error: "ordenes_delete_failed",
      service_session_id: serviceSessionId,
      data: oggi,
      details: { failures: deleteFailures, ordini_storico: storicoOk, backupOk: !!bkp?.success }
    };
  }

  // ─── PASSO 11: reset config ───────────────────────────────────
  // DRIVER_STATO was already set idle by the S2-1F active-trip gate (PASSO 1b) via the
  // transactional reset_rider_state_if_idle() — reaching here proves no active trip existed.
  // No direct DRIVER_STATO write occurs anywhere in this flow.
  await sbUpsert("config", { chiave: "ORDER_RESET_TS",  valore: String(Date.now()) }, "chiave");
  // S2-7D6B — the close marker is PER SERVICE KIND. With a single
  // LAST_CLOSE_DATE, closing lunch made the whole business date look finished,
  // so the catch-up would decide the evening had already been closed and skip a
  // dinner that was never archived.
  const closeMarkerKey = serviceKind === "PRANZO" ? "LAST_CLOSE_PRANZO"
    : serviceKind === "SERA" ? "LAST_CLOSE_SERA"
    : "LAST_CLOSE_DATE";
  await sbUpsert("config", { chiave: closeMarkerKey, valore: oggi }, "chiave");
  // LAST_CLOSE_DATE keeps tracking the EVENING close only, which is what the
  // legacy catch-up window (23:00-06:00) has always meant.
  if (serviceKind !== "PRANZO") {
    await sbUpsert("config", { chiave: "LAST_CLOSE_DATE", valore: oggi }, "chiave");
  }
  const completedSession = await serviceSessionLifecycle.completeClose({ sessionId: serviceSessionId, actor, source, preserveActiveOrders });
  if (!completedSession?.ok) {
    return { success: false, error: completedSession?.code || "service_session_complete_failed", service_session_id: serviceSessionId };
  }
  // S2-1G — destructive cleanup done: release the service_closing marker so new rider
  // trips may start again (idempotent; never a direct DRIVER_STATO write).
  await endClose("success");

  // ─── DONE ────────────────────────────────────────────────────
  return {
    success: true,
    service_session_id: serviceSessionId,
    data: oggi,
    summary,
    conv_archiviate: convOk,
    ordini_storico:  storicoOk,
    backupOk:        !!bkp?.success,
    manual_giros_dissolved:      manualGirosClose.dissolved_count || 0,
    manual_giro_orders_detached: manualGirosClose.detached_count  || 0
  };
}


module.exports = {
  computeSummary,
  scanServizio,
  backupSerata,
  chiudiServizio,
  madridDateStr,
  fasciaOraDa
};
