// src/agents/previewStrategicOpportunities.js
// ===============================================================
// Premium Planner — read-only OFFLINE adapter `previewStrategicOpportunities`.
//
// Orquesta in LABORATORIO la catena Premium già costruita (mattoni puri):
//   snapshot/fixture → currentOrderDraft + anchors
//     → strategicOpportunities (candidati cross-zone "di passaggio")
//     → routeImpact (ETA/slip/status, via bridge)
//     → premiumPlannerBridge → premiumPlannerOpportunities (contract Opportunity)
//     → deliveryProposalSelector (max 4 proposals[] dai dati già assemblati)
//   → response contract `premium-planner-strategic-preview-v1`.
//
// proposals[] è ADDITIVE: si affianca a opportunities[] (mai sostituirlo né
// rimuoverlo). Fallback safe: se il selector lancia, proposals=[] + warning.
//
// NON è wired a index.js, NON è una dispatcher action, NON è un endpoint live.
// Read-only, deps iniettate, write-guarded, no PII — sullo stesso pattern di
// `src/agents/previewOrderPlanner.js`. Vedi
// PREMIUM_PLANNER_READONLY_ADAPTER_DESIGN.md.
//
// DIVERGENZA DICHIARATA (vs design §4/§8): questa fase OFFLINE NON fa
// geo-resolution e NON chiama il planner reale `evaluateNewOrder`. Il
// currentOrderDraft porta la `zona` esplicita; la baseline diretta
// (`firstAvailable`/`bestProposal`) è il candidato diretto della catena
// strategica (anchor=null) valutato da routeImpact. La variante "planner reale +
// geo" resta fase successiva.
//
// startTime: ESPLICITO e obbligatorio in questa fase. Assente → blocker
// `missing_start_time`. MAI Date.now, MAI orario corrente, MAI driver
// availability inventata (loadPlannerSnapshot ritorna driver:null).
// ===============================================================
"use strict";

const {
  buildCandidateForAnchor,
  buildStrategicCandidates,
} = require("../core/delivery/strategicOpportunities");
const { buildRouteImpact } = require("../core/delivery/routeImpact");
const { buildOpportunityFromPlannerOption } = require("../core/delivery/premiumPlannerBridge");
const { buildPremiumOpportunity } = require("../core/delivery/premiumPlannerOpportunities");
const { buildRouteTimeline } = require("../core/delivery/routeTimeline");
const { selectDeliveryProposals, CONTRACT: PROPOSAL_CONTRACT } = require("../core/delivery/deliveryProposalSelector");

const CONTRACT = "premium-planner-strategic-preview-v1";
const SOURCE = "offline-readonly";
const MODE = "read_only";

// Handoff/sosta operativa di default per fermata: lo snapshot non espone
// serviceMin (plannerSnapshot.normalizeOrder non lo mappa). Assunzione esplicita.
const DEFAULT_SERVICE_MIN = 2;

const TERMINAL_STATES = new Set([
  "RETIRADO",
  "COMPLETADO",
  "COMPLETATO",
  "CANCELADO",
  "ANULADO",
  "ENTREGADO",
]);

// Stati che NON permettono l'inserimento PRIMA dell'anchor nel suo giro:
// terminali (ordine chiuso) + EN_ENTREGA (rider GIÀ partito → fisicamente
// impossibile anteporre una fermata). Mantenuta per retro-compatibilità/export;
// il filtro effettivo delle ancore usa ora l'allowlist ANCHOR_ELIGIBLE_STATES.
const NON_INSERTABLE_ANCHOR_STATES = new Set([
  ...TERMINAL_STATES,
  "EN_ENTREGA",
]);

// Allowlist degli stati che POSSONO fare da ancora a un giro strategico: SOLO
// lavoro operativo confermato che il rider porterà davvero — EN_COCINA (in forno)
// e LISTO (pronto, non ancora partito). Esclude di proposito:
//   - POR_CONFIRMAR / NUEVO: non confermati, possono non confermarsi mai (es. il
//     fantasma #001 Q1 20:25, rimasto vivo e usato come ancora → proposta +155 min);
//   - EN_ENTREGA: rider già uscito, non si antepone una fermata;
//   - terminali + CHIUSO_FORZATO: ordini chiusi.
// Allowlist (non blocklist): qualunque stato ignoto/futuro è escluso per default.
const ANCHOR_ELIGIBLE_STATES = new Set(["EN_COCINA", "LISTO"]);

// Ordine di "bontà" degli status per il ranking finale (minore = meglio).
const STATUS_RANK = { compatible: 0, ajuste: 1, no_recomendado: 2, lleno: 3 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normZone(zone) {
  return String(zone == null ? "" : zone).trim().toUpperCase();
}
function isValidHora(value) {
  if (typeof value !== "string") return false;
  const m = value.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return false;
  const h = Number(m[1]);
  return Number.isInteger(h) && h >= 0 && h <= 23;
}
function horaOrNull(value) {
  return isValidHora(value) ? value.trim() : null;
}

// ── anti-staleness anchor ──────────────────────────────────────────────────────
// Soglia di grazia: un anchor il cui riferimento temporale è oltre questi minuti
// NEL PASSATO rispetto a `now` è considerato stantio e NON fa da ancora (evita le
// proposte tossiche tipo +150 da un EN_COCINA/LISTO vecchio). Prudente: gli anchor
// futuri o vicini restano SEMPRE (EN_COCINA programmato dopo, LISTO appena pronto).
const ANCHOR_STALE_GRACE_MIN = 30;

// ── Δpromised guard (BLOCCO A.2) ────────────────────────────────────────────
// Soglia di divario tra le ore PROMESSE delle fermate di un'aggregazione. Oltre
// questo valore i due ordini sono operativamente troppo distanti per stare nello
// stesso giro, ANCHE quando lo slip resta sotto la soglia di routeImpact (caso
// residuo: ordine nuovo molto più tardi → appeso in coda → consegnato in forte
// anticipo → nessuno slip "in ritardo" da catturare). Mirror del guardrail
// manual-giro "Horarios >25 min". 25 min: sopra la spaziatura naturale di un
// giro sano in-canale (~15-20 min, vedi C: Q3 16:20 + Q4 16:40 = 20 → resta ajuste).
const PROMISED_GAP_NO_RECOMENDADO_MIN = 25;

// Massimo divario (minuti) tra le ore promesse delle fermate. Considera solo i
// `promised` validi; <2 promesse note → null (nessun giudizio). Usa la stessa
// normalizzazione night-service di toClockMin così 00:30 e 23:50 sono coerenti.
function maxPromisedGap(stops) {
  const mins = (Array.isArray(stops) ? stops : [])
    .map((s) => toClockMin(s && s.promised))
    .filter((m) => m != null);
  if (mins.length < 2) return null;
  return Math.max(...mins) - Math.min(...mins);
}

// Orario "HH:MM" → minuti-clock, con la STESSA normalizzazione night-service
// (h<6 → +24) di strategicOpportunities.toMin / routeImpact, così `now` e i
// riferimenti degli anchor vivono sullo stesso orologio. Null se non parsabile.
function toClockMin(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (h < 6) h += 24; // night-service normalization
  return h * 60 + min;
}

// minuti-clock → "HH:MM" (inverso di toClockMin). De-normalizza il night-service
// (mod 24) così 1490 → "00:50". Null se input non finito. Solo formato, nessun
// calcolo di business: lo usano salida/regreso degli anchor (serviceLine).
function fromClockMin(mins) {
  if (!Number.isFinite(mins)) return null;
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ── PLANNER_COCINA_FREEZE_15_MIN ────────────────────────────────────────────
// Regola operativa: sotto questa soglia (minuti) dalla salida del giro esistente,
// la cucina è "congelada" → la salida/forno_out NON si modifica. Il lock della
// salida anchor (fonte di verità) GIÀ garantisce che la salida non venga
// anticipata/ritardata; qui ESPONIAMO esplicitamente lo stato (additivo) per
// operatore/UI: `minutesToSalida`, `cocinaFrozen`, `cocinaState`. Sopra soglia →
// "estable" (piccoli aggiustamenti cucina NON ancora implementati → stable by
// default). Con `now` assente lo stato è null (non valutabile, frozen=false):
// backward-compat puro. Nessun Date.now, nessun calcolo orario inventato.
const COCINA_FREEZE_MIN = 15;

// minuti dalla salida del giro rispetto a `nowMin` (clock-min). Null se mancano
// salida o now. Solo lettura.
function minutesToSalidaOf(anchorSalida, nowMin) {
  const sMin = toClockMin(anchorSalida);
  if (sMin == null || nowMin == null) return null;
  return sMin - nowMin;
}

// Stato cucina di un giro rispetto a `nowMin`. Additivo, niente Date.now.
function cocinaStateFor(anchorSalida, nowMin, freezeMin = COCINA_FREEZE_MIN) {
  const mts = minutesToSalidaOf(anchorSalida, nowMin);
  if (mts == null) {
    return { minutesToSalida: null, cocinaFrozen: false, cocinaState: null, cocinaReason: null };
  }
  const frozen = mts < freezeMin;
  return {
    minutesToSalida: mts,
    cocinaFrozen: frozen,
    cocinaState: frozen ? "congelada" : "estable",
    cocinaReason: frozen ? "cocina_frozen_under_15" : null,
  };
}

// Ritardo (minuti) di un cliente GIÀ confermato nel giro → banda semaforo. Pura
// classificazione UI/operatore, MAI un blocco automatico: il `rojo` significa
// "decisione consapevole dell'operatore". 0–5 verde · 6–10 amarillo · >10 rojo.
function clientDelayBand(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 5) return "verde";
  if (m <= 10) return "amarillo";
  return "rojo";
}

// True se due intervalli orari [aStart,aEnd] e [bStart,bEnd] (HH:MM) si
// sovrappongono sull'orologio night-service. Estremo nullo/non parsabile →
// nessun giudizio (false): non inventiamo conflitti su dati incompleti.
function clockIntervalsOverlap(aStart, aEnd, bStart, bEnd) {
  const a0 = toClockMin(aStart), a1 = toClockMin(aEnd);
  const b0 = toClockMin(bStart), b1 = toClockMin(bEnd);
  if (a0 == null || a1 == null || b0 == null || b1 == null) return false;
  return Math.max(a0, b0) < Math.min(a1, b1);
}

// Intervallo [salida, entrega, regreso] di una opportunity DIRETTA, letto dalla
// routeTimeline GIÀ calcolata (mai inventato): salida = fermata departure,
// entrega = summary.giroEta, regreso = summary.returnEta. Null se manca.
function directIntervalFromOpp(opp) {
  const tl = opp && opp.routeTimeline ? opp.routeTimeline : null;
  if (!tl) return null;
  const timeline = Array.isArray(tl.timeline) ? tl.timeline : [];
  const dep = timeline.find((t) => t && t.type === "departure");
  const summary = tl.summary || {};
  return {
    salida: dep && typeof dep.eta === "string" ? dep.eta : null,
    entrega: typeof summary.giroEta === "string" ? summary.giroEta : null,
    regreso: typeof summary.returnEta === "string" ? summary.returnEta : null,
  };
}

// P0 — conflitto rider single-rider: un giro DIRETTO separato la cui finestra
// [salida, regreso] si sovrappone a quella di un anchor già impegnato (EN_COCINA/
// LISTO) NON può essere "compatible": un solo rider non può servire entrambi.
// Ritorna il PRIMO anchor in conflitto, o null. Conservativo: senza salida/regreso
// del diretto o dell'anchor non emette conflitto (nessun falso positivo).
function findRiderConflictAnchor(directOpp, anchors) {
  const di = directIntervalFromOpp(directOpp);
  if (!di || di.salida == null || di.regreso == null) return null;
  for (const a of (Array.isArray(anchors) ? anchors : [])) {
    if (!a) continue;
    const aSalida = a.salida != null ? a.salida : null;
    const aRegreso = a.regreso != null
      ? a.regreso
      : (a.entrega != null ? a.entrega : a.promised);
    if (aSalida == null || aRegreso == null) continue;
    if (clockIntervalsOverlap(di.salida, di.regreso, aSalida, aRegreso)) return a;
  }
  return null;
}

// Riferimento temporale più affidabile per valutare la staleness di un anchor
// DOMICILIO: preferisce l'ETA di consegna stimata, poi la salida driver, poi il
// forno_out, infine la hora promessa. Usa l'orario più "a valle" così non si
// scarta un ordine solo perché la hora nuda è appena passata. Null se nessun
// campo è un "HH:MM" valido (→ nessun giudizio: l'anchor viene tenuto).
function anchorRefHora(o = {}) {
  return horaOrNull(o.entrega_estimada)
    || horaOrNull(o.salida_driver_estimada)
    || horaOrNull(o.forno_out)
    || horaOrNull(o.hora);
}

// True se l'anchor è stantio rispetto a `now` (oltre la grazia nel passato).
// Conservativo: se manca `now` o il riferimento dell'anchor, NON è stantio.
function isAnchorStale(o, nowMin) {
  if (nowMin == null) return false;
  const refMin = toClockMin(anchorRefHora(o));
  if (refMin == null) return false;
  return refMin < nowMin - ANCHOR_STALE_GRACE_MIN;
}

// ── safety / shape helpers ────────────────────────────────────────────────────
function safetyBlock() {
  return { readOnly: true, writes: false, pii: "redacted" };
}

function safeInput(currentOrder) {
  // Echo MINIMO e no-PII: solo zona/hora/pizze del draft. Mai direccion/tel/nome.
  return {
    zona: currentOrder ? currentOrder.zone : null,
    promised: currentOrder ? currentOrder.promised : null,
    pizzas: currentOrder ? currentOrder.pizzas : 0,
  };
}

function safeError(currentOrder, code, message) {
  return {
    ok: false,
    contract: CONTRACT,
    source: SOURCE,
    mode: MODE,
    input: safeInput(currentOrder),
    currentOrder: currentOrder
      ? { zone: currentOrder.zone, promised: currentOrder.promised, pizzas: currentOrder.pizzas }
      : null,
    firstAvailable: null,
    bestProposal: null,
    opportunities: [],
    // proposals[] additive: sempre presente (anche su errore) → lista vuota.
    proposals: [],
    proposalContract: PROPOSAL_CONTRACT,
    serviceLine: [],
    warnings: [],
    blockers: [{ code, message }],
    error: { code, message, safe: true },
    safety: safetyBlock(),
  };
}

// ── normalization ─────────────────────────────────────────────────────────────

// Riduce il draft a soli campi planner-safe (no PII). direccion/telefono/nombre
// NON vengono letti né echeggiati.
function sanitizeCurrentOrderDraft(draft = {}) {
  const zone = normZone(draft.zona != null ? draft.zona : draft.zone);
  if (!zone) return null;
  const pizzasRaw = draft.pizzas != null ? draft.pizzas : draft.n_pizze;
  const serviceRaw = draft.serviceMin != null ? draft.serviceMin : draft.service_min;
  return {
    id: draft.id != null ? String(draft.id) : "__preview_current__",
    zone,
    label: "Pedido actual", // generico: MAI nome cliente
    promised: horaOrNull(draft.promised != null ? draft.promised : draft.hora),
    pizzas: num(pizzasRaw) || 0,
    serviceMin: num(serviceRaw) != null ? num(serviceRaw) : DEFAULT_SERVICE_MIN,
  };
}

// Riduce un anchor (esplicito o da snapshot) a soli campi non-PII.
function sanitizeAnchor(raw = {}) {
  const zone = normZone(raw.zona != null ? raw.zona : raw.zone);
  if (!zone) return null;
  const pizzasRaw = raw.pizzas != null ? raw.pizzas : raw.n_pizze;
  const serviceRaw = raw.serviceMin != null ? raw.serviceMin : raw.service_min;
  const promised = horaOrNull(raw.promised != null ? raw.promised : raw.hora);
  // salida/entrega/regreso del giro esistente (per la "línea de servicio" UI,
  // righe espandibili). Tutti DERIVATI da campi già calcolati dal sistema, MAI
  // inventati. PRECEDENZA ai campi reali del DB già propagati dallo snapshot
  // (salida_driver_estimada, entrega_estimada); poi fallback geometrici:
  //   entrega = entrega_estimada DB || hora promessa;
  //   salida  = salida_driver_estimada DB || forno_out || (entrega − andata);
  //   regreso = entrega + andata (modello simmetrico del rientro rider; nessuna
  //             colonna DB esiste → calcolato, mai inventato). Null se mancano dati.
  const andata = num(raw.andata_min != null ? raw.andata_min : (raw.durata_andata_min != null ? raw.durata_andata_min : raw.andata));
  const entrega = horaOrNull(raw.entrega_estimada) || promised;
  const entregaMin = toClockMin(entrega);
  const salida = horaOrNull(raw.salida_driver_estimada)
    || horaOrNull(raw.forno_out)
    || (entregaMin != null && andata != null ? fromClockMin(entregaMin - andata) : null);
  const regreso = entregaMin != null && andata != null ? fromClockMin(entregaMin + andata) : null;
  return {
    id: raw.id != null ? String(raw.id) : `anchor-${zone.toLowerCase()}`,
    zone,
    // label generica: MAI nome cliente. Se arriva un label esplicito lo
    // accettiamo solo se non sembra PII (nessun controllo euristico: usiamo
    // sempre una label derivata dalla zona per sicurezza).
    label: `Pedido ${zone}`,
    promised,
    pizzas: num(pizzasRaw) || 0,
    serviceMin: num(serviceRaw) != null ? num(serviceRaw) : DEFAULT_SERVICE_MIN,
    // additivi (back-compat: i consumatori esistenti li ignorano).
    salida,
    entrega,
    regreso,
    // SHARED_GIRO_ID: identità del giro a cui l'ordine è agganciato (manual_giros.id
    // denormalizzata su ordenes.manual_giro_id). null/'' → ordine singolo. Serve a
    // raggruppare più ordini dello stesso giro in UN anchor-giro (vedi groupAnchorsByGiro).
    manualGiroId: (() => {
      const g = raw.manual_giro_id != null ? raw.manual_giro_id : raw.manualGiroId;
      return g != null && String(g).trim() !== "" ? String(g).trim() : null;
    })(),
  };
}

// ── SHARED_GIRO_ID — raggruppamento anchor per giro ──────────────────────────
// Min/Max hora (clock-min, night-service) tra una lista, ignorando i null. Servono
// per la salida del giro (la più TEMPRANA: il rider esce una sola volta) e per
// entrega/regreso rappresentativi (i più TARDIVI). Solo lettura, niente invenzione.
function earliestHora(list) {
  const mins = (Array.isArray(list) ? list : []).map(toClockMin).filter((m) => m != null);
  return mins.length ? fromClockMin(Math.min(...mins)) : null;
}
function latestHora(list) {
  const mins = (Array.isArray(list) ? list : []).map(toClockMin).filter((m) => m != null);
  return mins.length ? fromClockMin(Math.max(...mins)) : null;
}

// Fonde i membri di UN giro (≥2 ordini con lo stesso manual_giro_id) in un solo
// anchor-giro che porta TUTTE le sue fermate in `stops[]`. La salida è la fonte di
// verità del giro (la più temprana, NON si anticipa); entrega/regreso/zone sono
// rappresentativi per la serviceLine. `id` = manual_giro_id (stabile, condiviso).
function buildGiroAnchor(giroId, members) {
  const stops = members.map((m) => ({
    id: m.id,
    zone: m.zone,
    label: m.label || `Pedido ${m.zone}`,
    promised: m.promised,
    pizzas: m.pizzas,
    serviceMin: m.serviceMin,
  }));
  const salida = earliestHora(members.map((m) => m.salida));
  const entrega = latestHora(members.map((m) => (m.entrega != null ? m.entrega : m.promised)));
  const regreso = latestHora(members.map((m) => m.regreso));
  return {
    id: String(giroId),
    manualGiroId: String(giroId),
    isGiro: true,
    stops,
    // zona rappresentativa per la serviceLine (display): zone del giro unite.
    zone: stops.map((s) => s.zone).join("+"),
    promised: entrega,
    salida,
    entrega,
    regreso,
    pizzas: members.reduce((s, m) => s + (num(m.pizzas) || 0), 0),
    serviceMin: members.length ? members[0].serviceMin : DEFAULT_SERVICE_MIN,
  };
}

// Raggruppa una lista di anchor (per-ordine) in anchor-giro. SOLO i gruppi con ≥2
// ordini che condividono un manual_giro_id non-null vengono fusi; un ordine singolo
// (con o senza manual_giro_id) resta INALTERATO (id = order id, niente `stops`) →
// comportamento legacy byte-identico. Preserva l'ordine d'ingresso del primo membro.
function groupAnchorsByGiro(anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  const byGiro = new Map();
  for (const a of list) {
    const gid = a && a.manualGiroId ? a.manualGiroId : null;
    if (!gid) continue;
    if (!byGiro.has(gid)) byGiro.set(gid, []);
    byGiro.get(gid).push(a);
  }
  const out = [];
  const emitted = new Set();
  for (const a of list) {
    const gid = a && a.manualGiroId ? a.manualGiroId : null;
    if (gid && byGiro.get(gid).length > 1) {
      if (emitted.has(gid)) continue; // il giro è già stato emesso una volta
      emitted.add(gid);
      out.push(buildGiroAnchor(gid, byGiro.get(gid)));
    } else {
      out.push(a); // singolo ordine → identico a oggi
    }
  }
  return out;
}

// Costruisce gli anchor dallo snapshot read-only: DOMICILIO, inseribili (non
// terminali e rider non ancora partito — vedi NON_INSERTABLE_ANCHOR_STATES), con
// zona e hora, esclusa la bozza corrente. Solo campi non-PII (lo snapshot stesso
// è già no-PII via plannerSnapshot/readOnlyDbAdapter).
//
// FILTRO same-zone (A1): se `opts.currentOrderZone` è fornita, gli ordini della
// STESSA zona del current draft NON diventano anchor strategici. Lo strategic
// Premium layer serve le opportunità cross-zone / "di passaggio"; la
// consolidazione same-zone è dominio del planner classico (`evaluateNewOrder`).
// Senza un leg "Q2->Q2" in deliveryLegs, un anchor same-zone degraderebbe a
// `blocked/missing_travel_times` (rotta [Q2,Q2]) — confuso lato UI. Meglio non
// generarlo. Se `currentOrderZone` è assente → nessun filtro (backward-compat).
//
// FILTRO ANTI-STALE (now): se `opts.now` (o snapshot.now) è disponibile, un anchor
// il cui riferimento temporale è oltre ANCHOR_STALE_GRACE_MIN nel PASSATO viene
// scartato — così un EN_COCINA/LISTO vecchio non genera più proposte tossiche
// (+150). Gli anchor futuri/vicini restano sempre (vedi isAnchorStale). Senza now
// il filtro è no-op (backward-compat).
function buildAnchorsFromSnapshot(snapshot = {}, opts = {}) {
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  const currentId = opts.currentOrderId != null ? String(opts.currentOrderId) : null;
  const currentZone = opts.currentOrderZone != null ? normZone(opts.currentOrderZone) : null;
  const nowMin = toClockMin(opts.now != null ? opts.now : snapshot.now);
  const out = [];
  for (const o of orders) {
    if (!o) continue;
    const tipo = String(o.tipo_consegna || "DOMICILIO").trim().toUpperCase();
    if (tipo !== "DOMICILIO") continue;
    const estado = String(o.estado || "").trim().toUpperCase();
    // Solo lavoro operativo confermato può fare da ancora: EN_COCINA / LISTO.
    // Esclude POR_CONFIRMAR/NUEVO (non confermati, fantasmi), EN_ENTREGA (rider
    // già uscito), terminali e CHIUSO_FORZATO. Vedi ANCHOR_ELIGIBLE_STATES.
    if (!ANCHOR_ELIGIBLE_STATES.has(estado)) continue;
    const zone = normZone(o.zona != null ? o.zona : o.zone);
    if (!zone) continue;
    if (currentId != null && String(o.id) === currentId) continue;
    // same-zone del current → dominio del planner classico, non strategic.
    if (currentZone != null && zone === currentZone) continue;
    // anti-stale: scarta anchor troppo nel passato rispetto a `now`.
    if (isAnchorStale(o, nowMin)) continue;
    const anchor = sanitizeAnchor(o);
    if (anchor) out.push(anchor);
  }
  // SHARED_GIRO_ID: fonde gli ordini dello stesso giro (manual_giro_id) in un
  // anchor-giro unico con tutte le sue fermate. Ordini singoli → invariati.
  return groupAnchorsByGiro(out);
}

// ── opportunity mapping ───────────────────────────────────────────────────────

// Opportunity "blocked" per candidati non viabili (tratte mancanti o cross
// non forzabile): nessun routeEtas finto, status no_recomendado, blocked true.
function blockedOpportunity(cand, currentOrder, code, message) {
  return buildPremiumOpportunity({
    id: cand.id,
    kind: cand.kind,
    giroId: cand.anchorId,
    currentOrderZone: currentOrder.zone,
    currentOrderLabel: currentOrder.label,
    routeZones: cand.routeZones,
    mapPath: cand.mapPath,
    channel: cand.channel,
    routeEtas: [],
    status: "no_recomendado",
    blocked: true,
    warning: message || cand.reason || code,
    explanation: cand.reason || message || "",
    chip: "no_recomendado",
  });
}

// Stops minimi per disegnare una linea BLOCCATA (tratte mancanti / cross non
// viabile) senza inventare orari: zone dal candidato, isNew = zona del current.
function buildBlockedStops(cand, currentOrder) {
  const zones = Array.isArray(cand.routeZones) ? cand.routeZones : [];
  return zones.map((z) => ({
    zone: z,
    label: z === currentOrder.zone ? currentOrder.label : `Pedido ${z}`,
    isNew: z === currentOrder.zone,
    promised: z === currentOrder.zone ? currentOrder.promised : null,
  }));
}

// Allega (additivo) `routeTimeline` v2 a una opportunity già costruita. Il mapper
// è puro; riceve l'impact COMPLETO (driverReturn incluso) o null se bloccata.
function attachRouteTimeline(opp, cand, currentOrder, impact) {
  opp.routeTimeline = buildRouteTimeline({
    proposalId: opp.id,
    startTime: cand.routeImpactInput ? cand.routeImpactInput.startTime : null,
    routeImpact: impact || null,
    stops: cand.routeImpactInput
      ? cand.routeImpactInput.stops
      : buildBlockedStops(cand, currentOrder),
    baseline: opp.baseline,
    kind: opp.kind,
    channel: cand.channel,
    status: opp.status,
    blocked: opp.blocked,
    warning: opp.warning,
    explanation: opp.explanation,
  });
  return opp;
}

// Mappa UN candidato strategico → Opportunity contract-ready.
// Ritorna { opp, blockedReason } oppure null se il candidato va scartato
// (cross con includeCrossZone=false).
function mapCandidateToOpportunity(cand, currentOrder, ctx = {}) {
  const includeCrossZone = ctx.includeCrossZone !== false;
  const isCross = cand.channel === "cross";

  if (isCross && !includeCrossZone) return null;

  // Tratte di viaggio mancanti → bloccato, no ETA fantasma.
  // FIX_41: distinguiamo il caso CROSS-CHANNEL (canale diverso, es. Q4 vs ruta
  // sur) dal generico "faltan tiempos": per il cross il motivo reale è il canale,
  // non un dato mancante a caso. Messaggio esplicito per l'operatore. Nessun
  // cambio a ranking/routing: solo code+message del blocco.
  if (cand.routeImpactInput == null) {
    const code = isCross ? "cross_channel_blocked" : "missing_travel_times";
    const reason = isCross
      ? "Canal diferente · revisar manualmente antes de combinar"
      : (cand.reason || "Tiempos de viaje incompletos");
    const blockedOpp = blockedOpportunity(cand, currentOrder, code, reason);
    attachRouteTimeline(blockedOpp, cand, currentOrder, null);
    return {
      opp: blockedOpp,
      blockedReason: code,
    };
  }

  // Candidato con routeImpactInput: il bridge esegue routeImpact e mappa al
  // contract. syntheticOption dà solo kind/giroId; status/ETA arrivano dal motore.
  const syntheticOption = {
    type: cand.kind === "crear" ? "separate" : "join_giro",
    giro_id: cand.anchorId,
    status: "valid",
    retraso: 0,
  };
  const opp = buildOpportunityFromPlannerOption(syntheticOption, {
    id: cand.id,
    currentOrderZone: currentOrder.zone,
    currentOrderLabel: currentOrder.label,
    routeZones: cand.routeZones,
    mapPath: cand.mapPath,
    routeImpactInput: cand.routeImpactInput,
  });

  // Impact COMPLETO (con driverReturn/routeMin) per il mapper timeline. È una
  // ricomputazione pura/offline dello stesso input già usato dal bridge: serve
  // perché il bridge espone solo il subset opportunity (storicamente senza
  // driverReturn). Niente IO, niente Date.now.
  const fullImpact = buildRouteImpact(cand.routeImpactInput);

  // RICONCILIAZIONE cross-channel: routeImpact NON conosce il canale e potrebbe
  // dire "compatible" su una rotta cross. La decisione strategica (cross =
  // no_recomendado) vince: l'adapter forza lo status a valle del bridge.
  if (isCross) {
    opp.status = "no_recomendado";
    opp.severity = "blocked";
    opp.blocked = true;
    if (!opp.warning) opp.warning = cand.reason || "Canales distintos: ruta no recomendada";
    attachRouteTimeline(opp, cand, currentOrder, fullImpact);
    return { opp, blockedReason: "cross_channel" };
  }

  // RICONCILIAZIONE Δpromised (BLOCCO A.2): orari promessi troppo distanti tra le
  // fermate dell'aggregazione → no_recomendado, anche se lo slip resta sotto la
  // soglia di routeImpact. Asse diverso dallo slip guard (distanza promesse vs
  // lateness): additivo, non lo sostituisce. Forzabile (blocked=false) come lo slip
  // guard: esce dai bottoni di aggregazione rapida (compatible|ajuste) ma resta
  // forzabile con avviso. Non scatta sul single-stop (un solo promised → gap null)
  // né sul manual giro (path separato). Non DEGRADA mai uno status già peggiore.
  const promisedGap = maxPromisedGap(cand.routeImpactInput.stops);
  if (
    promisedGap != null &&
    promisedGap > PROMISED_GAP_NO_RECOMENDADO_MIN &&
    STATUS_RANK[opp.status] < STATUS_RANK.no_recomendado
  ) {
    opp.status = "no_recomendado";
    if (!opp.warning) {
      opp.warning = `Horarios lejanos: ${promisedGap} min entre pedidos (máx ${PROMISED_GAP_NO_RECOMENDADO_MIN})`;
    }
    attachRouteTimeline(opp, cand, currentOrder, fullImpact);
    return { opp, blockedReason: "promised_gap" };
  }

  attachRouteTimeline(opp, cand, currentOrder, fullImpact);
  return { opp, blockedReason: null };
}

// Ranking finale: non bloccati prima, poi per bontà dello status, stabile.
function rankOpportunities(opps) {
  return (Array.isArray(opps) ? opps : [])
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const ba = a.o.blocked ? 1 : 0;
      const bb = b.o.blocked ? 1 : 0;
      if (ba !== bb) return ba - bb;
      const ra = STATUS_RANK[a.o.status] != null ? STATUS_RANK[a.o.status] : 99;
      const rb = STATUS_RANK[b.o.status] != null ? STATUS_RANK[b.o.status] : 99;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map((x) => x.o);
}

// ── response assembly ─────────────────────────────────────────────────────────

function buildStrategicContext(input, currentOrder) {
  return {
    startTime: input.startTime,
    travelTimes: input.travelTimes,
    capacity: input.capacity || {},
    toleranceMin: input.toleranceMin,
  };
}

function buildStrategicPreviewResponse({
  input,
  currentOrder,
  anchors,
  firstAvailable,
  bestProposal,
  opportunities,
  warnings,
}) {
  const warningsOut = Array.isArray(warnings) ? warnings.slice() : [];
  // PLANNER_COCINA_FREEZE_15_MIN: `now` (clock-min) per valutare lo stato cucina
  // di ogni giro. Da `input.now` (HH:MM); assente → nowMin null → stato non
  // valutabile (cocinaState null, frozen false): backward-compat.
  const nowMinResp = toClockMin(input && input.now);
  const serviceLineOut = (Array.isArray(anchors) ? anchors : []).map((a) => {
    const cs = cocinaStateFor(a.salida, nowMinResp);
    return {
      id: a.id,
      zone: a.zone,
      promised: a.promised,
      pizzas: a.pizzas,
      salida: a.salida != null ? a.salida : null,
      entrega: a.entrega != null ? a.entrega : a.promised,
      regreso: a.regreso != null ? a.regreso : null,
      // additivi cucina (per giro): la salida NON viene mai modificata qui.
      minutesToSalida: cs.minutesToSalida,
      cocinaFrozen: cs.cocinaFrozen,
      cocinaState: cs.cocinaState,
    };
  });
  // Warning NON bloccante: almeno un giro con cucina congelada (<15 min a salida).
  if (serviceLineOut.some((e) => e.cocinaFrozen)) {
    warningsOut.push({
      code: "cocina_frozen_under_15",
      message: "Cocina congelada en un giro (<15 min a salida): la salida no se modifica",
    });
  }
  const response = {
    ok: true,
    contract: CONTRACT,
    source: SOURCE,
    mode: MODE,
    input: safeInput(currentOrder),
    currentOrder: {
      zone: currentOrder.zone,
      promised: currentOrder.promised,
      pizzas: currentOrder.pizzas,
    },
    firstAvailable: firstAvailable || null,
    bestProposal: bestProposal || null,
    opportunities: Array.isArray(opportunities) ? opportunities : [],
    // serviceLine: sintesi NON-PII degli anchor (giros/huecos di servizio).
    // salida/entrega/regreso additivi → la UI mostra ogni giro come riga
    // espandibile (Pizzería → entrega → regreso). Valori derivati, mai inventati.
    // + stato cucina additivo (cocinaFrozen/cocinaState/minutesToSalida).
    serviceLine: serviceLineOut,
    warnings: warningsOut,
    blockers: [],
    safety: safetyBlock(),
  };

  // proposals[] ADDITIVE: il selector puro sceglie max 4 proposte dai dati GIÀ
  // assemblati (firstAvailable/bestProposal/opportunities). NON tocca né rimuove
  // opportunities[]: è un campo nuovo accanto. Fallback safe: se il selector
  // lancia, proposals=[] + warning, la preview resta intatta.
  response.proposalContract = PROPOSAL_CONTRACT;
  try {
    const selection = selectDeliveryProposals(response);
    response.proposals = Array.isArray(selection.proposals) ? selection.proposals : [];
  } catch (_) {
    response.proposals = [];
    warningsOut.push({
      code: "proposal_selection_unavailable",
      message: "No se pudieron derivar las propuestas (preview intacta)",
    });
  }

  return response;
}

// ── adapter principale ────────────────────────────────────────────────────────

async function previewStrategicOpportunities(input = {}, deps = {}) {
  const currentOrder = sanitizeCurrentOrderDraft(input.currentOrderDraft || input.currentOrder || {});
  if (!currentOrder) {
    return safeError(null, "missing_current_order", "Falta el pedido actual (zona)");
  }

  // startTime ESPLICITO obbligatorio. MAI Date.now / orario corrente.
  if (input.startTime == null || input.startTime === "") {
    return safeError(currentOrder, "missing_start_time", "Falta startTime explícito (rider libre)");
  }
  if (!isValidHora(input.startTime)) {
    return safeError(currentOrder, "invalid_start_time", "startTime no válido (HH:MM)");
  }

  const warnings = [];

  // Anchors: espliciti (sanitizzati) hanno precedenza; altrimenti dallo snapshot
  // (fixture o deps.loadSnapshot). Nessun DB diretto qui.
  //
  // FIX_26 — separazione delle responsabilità degli anchor (P0 same-zone rider
  // availability). `buildAnchorsFromSnapshot` è chiamato SENZA currentOrderZone:
  // ritorna TUTTI gli anchor operativi (EN_COCINA/LISTO, DOMICILIO, non-stale),
  // INCLUSI quelli same-zone. Il filtro same-zone NON è più applicato qui: un
  // anchor same-zone non è aggregabile (dominio del planner classico) MA occupa
  // comunque il rider single-rider e struttura la serata. Da `allOperationalAnchors`
  // derivo poi le tre viste sotto. "non aggregabile ≠ rider libero".
  let allOperationalAnchors;
  if (Array.isArray(input.anchors)) {
    // SHARED_GIRO_ID: anche gli anchor espliciti vengono raggruppati per giro.
    allOperationalAnchors = groupAnchorsByGiro(input.anchors.map(sanitizeAnchor).filter(Boolean));
  } else {
    let snapshot = input.snapshot;
    if (!snapshot && typeof deps.loadSnapshot === "function") {
      try {
        snapshot = await deps.loadSnapshot({
          db: deps.db,
          date: input.date,
          now: input.now,
          includePii: false,
        });
      } catch (e) {
        return safeError(currentOrder, "snapshot_unavailable", "Snapshot no disponible");
      }
    }
    if (!snapshot) {
      return safeError(currentOrder, "missing_snapshot", "Falta snapshot o loadSnapshot");
    }
    // NB: niente currentOrderZone → same-zone NON filtrato (resta nei vincoli rider).
    allOperationalAnchors = buildAnchorsFromSnapshot(snapshot, {
      currentOrderId: currentOrder.id,
      now: input.now, // anti-stale: riferimento temporale (fallback snapshot.now)
    });
  }

  // candidateAnchors: SOLO anchor cross-zone possono generare insertion strategici
  // (regola A1: la consolidazione same-zone è dominio del planner classico — un leg
  // Zona->stessaZona non esiste e degraderebbe a blocked/missing_travel_times).
  // SHARED_GIRO_ID: per un anchor-giro la "zona" è l'insieme delle sue fermate →
  // si esclude se il nuevo pedido cade in QUALSIASI zona già nel giro. Per un anchor
  // singolo l'insieme è {a.zone} → identico al filtro precedente (a.zone !== current).
  const anchorZones = (a) => (Array.isArray(a.stops) && a.stops.length)
    ? a.stops.map((s) => normZone(s.zone))
    : [normZone(a.zone)];
  const candidateAnchors = allOperationalAnchors.filter((a) => a && !anchorZones(a).includes(currentOrder.zone));
  // riderBusyAnchors / serviceLineAnchors: TUTTI gli anchor operativi, same-zone
  // INCLUSO. Un anchor same-zone non aggregabile occupa comunque il rider e va
  // mostrato nella linea di servizio.
  const riderBusyAnchors = allOperationalAnchors;
  const serviceLineAnchors = allOperationalAnchors;

  // Moduli iniettabili (default ai mattoni puri).
  const makeCandidates = typeof deps.buildStrategicCandidates === "function"
    ? deps.buildStrategicCandidates
    : buildStrategicCandidates;
  const makeDirectCandidate = typeof deps.buildCandidateForAnchor === "function"
    ? deps.buildCandidateForAnchor
    : buildCandidateForAnchor;
  const runRouteImpact = typeof deps.buildRouteImpact === "function"
    ? deps.buildRouteImpact
    : buildRouteImpact;

  const context = buildStrategicContext(input, currentOrder);
  const includeCrossZone = input.includeCrossZone !== false;

  let firstAvailable = null;
  let bestProposal = null;
  try {
    // ── Baseline diretta: candidato per il solo ordine attuale (anchor=null). ──
    const directCand = makeDirectCandidate(currentOrder, null, context);
    if (directCand && directCand.routeImpactInput) {
      const impact = runRouteImpact(directCand.routeImpactInput);
      const firstEta = Array.isArray(impact.routeEtas) && impact.routeEtas[0]
        ? impact.routeEtas[0].eta
        : null;
      firstAvailable = { zone: currentOrder.zone, eta: firstEta, status: impact.status };
      const mappedDirect = mapCandidateToOpportunity(directCand, currentOrder, { includeCrossZone });
      bestProposal = mappedDirect ? mappedDirect.opp : null;

      // ── P0: conflitto rider del diretto vs anchor già impegnati ──
      // Il diretto è valutato in isolamento (anchor=null) → routeImpact lo dà
      // "compatible" anche quando il rider single-rider è già prenotato su un
      // anchor (es. Q5 EN_COCINA) la cui salida cade dentro la finestra del
      // diretto. Qui lo correggiamo: no_recomendado FORZABILE (blocked resta
      // false), con avviso. Mai più "Mejor propuesta compatible" cieca.
      if (bestProposal && bestProposal.blocked !== true) {
        const conflictAnchor = findRiderConflictAnchor(bestProposal, riderBusyAnchors);
        if (conflictAnchor) {
          const di = directIntervalFromOpp(bestProposal);
          const msg = `Conflicto rider: vuelve ${di && di.regreso ? di.regreso : "—"}, pero ${conflictAnchor.zone} debe salir ${conflictAnchor.salida || "—"}`;
          bestProposal.status = "no_recomendado";
          bestProposal.severity = "warning"; // forzabile: blocked NON cambia
          bestProposal.riderConflict = true;
          bestProposal.warning = msg;
          if (!bestProposal.explanation || /compatible/i.test(bestProposal.explanation)) {
            bestProposal.explanation = msg;
          }
          // la card "Mejor propuesta" legge firstAvailable.status → riallinea
          if (firstAvailable) firstAvailable.status = "no_recomendado";
          // La rotta del diretto è corretta (legs invariati); il conflitto è
          // trasversale (vincolo rider su un ALTRO giro), non uno slip della
          // rotta → patchiamo solo risk/operatorMessage del timeline esistente
          // (buildRouteTimeline deriverebbe risk dallo slip della rotta = ok).
          if (bestProposal.routeTimeline) {
            bestProposal.routeTimeline.risk = "warning";
            bestProposal.routeTimeline.operatorMessage = msg;
          }
        }
      }
    } else {
      warnings.push({ code: "direct_unavailable", message: "Baseline directa no disponible (tiempos de viaje)" });
    }

    // ── Opportunità di giro dagli anchor. ──
    let opportunities = [];
    if (!candidateAnchors.length) {
      // Nessun candidato di insertion (cross-zone). Emetti no_anchors SOLO se non
      // c'è neppure un anchor che occupa il rider: se ne esiste uno (es. same-zone),
      // la serviceLine è popolata e l'eventuale conflitto rider è già segnalato su
      // bestProposal → "no_anchors" sarebbe fuorviante (FIX_26).
      if (!riderBusyAnchors.length) {
        warnings.push({ code: "no_anchors", message: "No hay pedidos ancla compatibles" });
      }
    } else {
      const candidates = makeCandidates({
        currentOrder,
        anchors: candidateAnchors,
        startTime: context.startTime,
        travelTimes: context.travelTimes,
        capacity: context.capacity,
        toleranceMin: context.toleranceMin,
      });
      let anyMissingTravel = false;
      let anyCrossChannel = false;
      // PLANNER_COCINA_FREEZE_15_MIN: nowMin per marcare ogni proposta col giro
      // cucina-congelado che insegue (additivo, non cambia routing/status).
      const nowMinTop = toClockMin(input.now);
      for (const cand of candidates) {
        const mapped = mapCandidateToOpportunity(cand, currentOrder, { includeCrossZone });
        if (!mapped) continue; // cross scartato (includeCrossZone=false)
        if (mapped.blockedReason === "missing_travel_times") anyMissingTravel = true;
        if (mapped.blockedReason === "cross_channel_blocked") anyCrossChannel = true;
        // stato cucina del giro anchor su cui insiste la proposta (per chip UI).
        const anch = candidateAnchors.find((a) => a && String(a.id) === String(cand.anchorId));
        if (anch && mapped.opp) {
          const cs = cocinaStateFor(anch.salida, nowMinTop);
          mapped.opp.minutesToSalida = cs.minutesToSalida;
          mapped.opp.cocinaFrozen = cs.cocinaFrozen;
          mapped.opp.cocinaState = cs.cocinaState;
          if (cs.cocinaReason) mapped.opp.cocinaReason = cs.cocinaReason;
        }
        opportunities.push(mapped.opp);
      }
      // FIX_41: warning esplicito cross-channel, separato dal generico.
      if (anyCrossChannel) {
        warnings.push({ code: "cross_channel_blocked", message: "Canal diferente · no se recomienda combinar con esta ruta" });
      }
      if (anyMissingTravel) {
        warnings.push({ code: "missing_travel_times", message: "Algunas rutas no tienen tiempos de viaje" });
      }
    }
    opportunities = rankOpportunities(opportunities);

    return buildStrategicPreviewResponse({
      input,
      currentOrder,
      anchors: serviceLineAnchors, // FIX_26: serviceLine include anche same-zone
      firstAvailable,
      bestProposal,
      opportunities,
      warnings,
    });
  } catch (e) {
    return safeError(currentOrder, "strategic_preview_unavailable", "Premium planner preview no disponible");
  }
}

module.exports = {
  previewStrategicOpportunities,
  buildAnchorsFromSnapshot,
  sanitizeCurrentOrderDraft,
  sanitizeAnchor,
  mapCandidateToOpportunity,
  rankOpportunities,
  buildStrategicPreviewResponse,
  isAnchorStale,
  anchorRefHora,
  toClockMin,
  clockIntervalsOverlap,
  directIntervalFromOpp,
  findRiderConflictAnchor,
  // PLANNER_COCINA_FREEZE_15_MIN (puri, testabili in isolamento)
  minutesToSalidaOf,
  cocinaStateFor,
  clientDelayBand,
  _internal: { CONTRACT, SOURCE, MODE, DEFAULT_SERVICE_MIN, TERMINAL_STATES, NON_INSERTABLE_ANCHOR_STATES, ANCHOR_ELIGIBLE_STATES, ANCHOR_STALE_GRACE_MIN, COCINA_FREEZE_MIN },
};
