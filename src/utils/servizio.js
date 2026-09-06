// ===============================================================
// language-guard: allow-legacy servizio.js is this file's own existing name, not new vocabulary
// servizio.js
//
// N-2 — the atomic nightly-close entry point this file used to hold
// language-guard: allow-legacy chiudiServizio/serata_summary/backup_serata are the existing deleted function name and table names this paragraph cites for audit history, not new vocabulary
// (chiudiServizio: lock-first serata_summary INSERT, backup_serata safety
// language-guard: allow-legacy writeStorico/writeArchivioConv/ordenes are the existing deleted-function/table names this paragraph cites for audit history, not new vocabulary
// net, writeStorico/writeArchivioConv, verify, then cancella ordenes/conv/
// wa_msgs) was deleted in the application-wide legacy/dead-code purge. It had
// zero reachable production callers: the manual HTTP action's "else" branch
// is structurally unreachable (open_operational_service_v1 is the only
// session-creating primitive and always stamps lifecycle_semantics=
// 'operational_service_v1'; zero economic_period_v1 sessions can exist
// anymore), the S2-1G deferred-close retry could never actually fire (its
// only feeder, the incident-safe rollover orchestrator, always suppressed
// the exact signal that retry waited for), and the orchestrator's own three
// automatic entry points (close-tick, boot catch-up, external-cron backup)
// were frozen behind LEGACY_AUTOMATIC_LIFECYCLE_ENABLED and are now retired,
// not just gated — see index.js and the deleted src/serviceSessions/
// incidentSafeRollover.js. V3 (serviceLifecycleEngine.js) replaced it
// entirely and never depended on it.
//
// What survives here are the still-live, independently-reachable pieces:
// language-guard: allow-legacy scanServizio/backupSerata are the existing surviving export names this paragraph describes, not new vocabulary
// scanServizio (read-only Finalizar pre-flight scan), backupSerata (the
// 23:40 preventive snapshot, index.js schedula2340), and computeSummary
// (tested directly, historical summary shape).
// ===============================================================

const { sbSelect, sbInsert, sbUpsert } = require("./supabase");
// language-guard: allow-legacy calcolaTotaleOrdine is the existing helpers.js export name, unchanged by removing calcolaTotale from this same destructure, not new vocabulary
const { calcolaTotaleOrdine, deliveryFeeFor, isBevanda, isDesert } = require("./helpers");
const { getCurrentOperationalSession, serviceSessionQuery } = require("../serviceSessions/currentOperationalSession");
const { aggregate: aggregateCloseout } = require("../closeout/currentServiceCloseout");

// The pre-close scan reads through this indirection so a test can hand it an
// in-memory `select`; with no injected dependency it IS `sbSelect`, and every
// other function and code path in this file is unchanged.
const _defaultScanSelect = sbSelect;

// ─── Date helpers ────────────────────────────────────────────────
function madridDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${day}`;
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
//
// K4 (Finalizar closeout hardening, 2026-09-06) — the pre-close list `attivi`
// is keyed by CATEGORY-NAMESPACED identity, NEVER by customer identity. One
// customer can hold several unresolved orders at once (two DOMICILIO orders on
// one `wa_id`, a Mesa comanda plus a phone order …); each is its own blocker
// and must stay its own row. Keying orders by `wa_id`/`tel` collapsed
// same-customer orders into a single entry — the list then silently dropped a
// real economic exposure while `blocking.orders` still counted it, so summary
// and detail disagreed. Orders are now keyed by their OWN canonical identity
// (`order_uid`, or the text id for a legacy row without one); conversations
// stay per-customer (a chat thread IS per customer); the three namespaces
// cannot collide, so every distinct blocker in `blocking` maps to exactly one
// row in `attivi`.
//
// `select` / `resolveCurrentService` are test seams only. With no argument the
// behaviour is byte-identical to before: `sbSelect` and the lifecycle pointer
// `getCurrentOperationalSession()`.
// language-guard: allow-legacy scanServizio is the existing export name; only its optional test-seam args are new, not new vocabulary
async function scanServizio({ select, resolveCurrentService } = {}) {
  const oggi = madridDateStr();
  const sbSelect = typeof select === "function" ? select : _defaultScanSelect;
  const currentService = resolveCurrentService
    ? await resolveCurrentService()
    : await getCurrentOperationalSession();
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
    // The order's OWN identity — never the customer's. `order_uid` is the
    // canonical N-2 key; a legacy row without one keeps its unique text id.
    const key = `ord:${o.order_uid || o.id}`;
    if (!attiviMap[key]) attiviMap[key] = { kind: "order", wa_id: o.wa_id || o.tel || "", nombre: o.nombre || o.id || "", hora: o.hora || "", stato: o.estado || "" };
  });
  (Array.isArray(contiMesaAperti) ? contiMesaAperti : []).forEach(session => {
    const key = `mesa:${session.table_id || session.id}`;
    attiviMap[key] = {
      kind: "table",
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
  //
  // FINALIZAR V3 CANONICAL CLOSEOUT V1 — DEFERRED_LATENT_PATTERN. This is a
  // 3-argument aggregateCloseout() call (no order_obligations), but it reads
  // ONLY ledger.paymentTotals.* — receipt-side totals from
  // order_financial_events, which do not depend on the obligation argument. It
  // never touches ledger.totals.gross / .unpaid / .overCollected, so it is
  // provably unaffected by the LEGACY_GROSS_CLOSEOUT_WRITER root cause and is
  // intentionally NOT migrated in that slice. See the anti-regression guard in
  // tests/finalizarV3AggregateObligationCallSites.static.test.js.
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


module.exports = {
  computeSummary,
  scanServizio,
  backupSerata,
  madridDateStr,
  fasciaOraDa
};
