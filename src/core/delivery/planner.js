// ===============================================================
// src/core/delivery/planner.js
// Delivery Planning Orchestrator — ENGINE PURO (passo 1)
// Spec: LaDieciBotV2_DELIVERY_PLANNING_ORCHESTRATOR_SPEC.md (rev.3)
// ===============================================================
// FUNZIONE PURA: nessun DB, nessun Supabase, nessun side-effect, nessun import
// di consumatori live. Tutto entra dallo `snapshot`, tutto esce dal `Plan`.
//
// Invarianti chiave (vedi spec §2):
//   I1  il derivato non alimenta mai il derivato → calcoliamo dai FATTI GREZZI;
//       per gli ordini CONGELATI DURI echeggiamo i loro valori committati (realtà),
//       non li ricalcoliamo.
//   I8  forno_out ≤ partenza del proprio giro, per OGNI membro (tutte le pizze del
//       giro escono per la partenza).
//   I9  retraso si calcola sulla promessa + granularità, MAI sulla delivery_window.
//
// NIENTE è cablato a un consumatore: questo modulo è importabile solo da test.
// ===============================================================

"use strict";

// ── Default di dominio (sovrascrivibili dallo snapshot) ───────────────────────
const DEFAULTS = {
  // Forno: cap NOMINALE 4/slot, ma overload "morbido" tollerato (§Soft oven overload):
  //   ≤4        ok
  //   5         soft overload  → warning, NESSUNO shift automatico
  //   6–7       overload serio → warning serio, nessuno shift automatico
  //   ≥8        hard overload  → shift / richiede decisione
  forno: { slotMin: 10, maxPerSlot: 4, softOverloadMax: 5, seriousOverloadMax: 7 },
  margineCotturaMin: 5,                     // D1
  promiseSlotMin: 10,                       // D4: promessa a slot da 10 min
  bufferOpsDriverMin: 3,                    // §Driver buffer: default 3 (era 5). 5+5+5 mangia la serata.
  defaultMaxOrdiniPerGiro: 3,
  giroRecommendationWindowMin: 20,          // entro quanto un giro è "raccomandato"
  giroAggregationMarginMin: 2,              // parità frontend: pizza nuova ≤ partenza+2
  // Manual multi-zone route / rider block (§Manual route):
  riderBlockDurMismatchMin: 5,              // |manuale−stimata| oltre cui scatta il warning
  riderBlockDurMismatchRatio: 0.3,          // oppure scarto relativo > 30%
  riderBlockEarlyToleranceMin: 15,          // consegna troppo PRIMA della promessa → block desfasado
};

// ── Helper temporali (service-day-aware) ──────────────────────────────────────
// Servizio serale a cavallo di mezzanotte: 00:00–05:59 → +24h.
// (after-midnight è edge noto: vedi test documentato.)
function toSvc(hhmm) {
  if (hhmm == null) return null;
  const m = String(hhmm).trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 6) h += 24; // night-service normalization
  return h * 60 + min;
}
function fromSvc(min) {
  if (min == null) return null;
  const w = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
}
const slotStart = (min, slotMin) => Math.floor(min / slotMin) * slotMin;
const ceilTo = (min, step) => Math.ceil(min / step) * step;

// Stati che NON entrano nella pianificazione/forno attivo.
const INACTIVE_STATES = new Set(["RETIRADO", "COMPLETADO", "COMPLETATO", "POR_CONFIRMAR"]);
const HARD_FROZEN_STATES = new Set(["LISTO", "EN_ENTREGA", "RETIRADO"]);

// ── Classificazione congelamento (spec §5) ────────────────────────────────────
//   MOVIBILE        : NUEVO/POR_CONFIRMAR e forno_out > now+margine
//   SEMI_CONGELATO  : EN_COCINA e forno_out > now+margine (spostabile solo avanti)
//   CONGELATO_DURO  : forno_out ≤ now+margine  OR  estado ∈ {LISTO,EN_ENTREGA,RETIRADO}
function classifyFreeze(order, nowSvc, margine) {
  const fo = toSvc(order.forno_out);
  const hardByState = HARD_FROZEN_STATES.has(order.estado);
  const hardByTime = fo != null && fo <= nowSvc + margine;
  if (hardByState || hardByTime) return "CONGELATO_DURO";
  if (order.estado === "EN_COCINA") return "SEMI_CONGELATO";
  return "MOVIBILE";
}

// ── Tolleranza promessa (D4) ──────────────────────────────────────────────────
// slot (default) → tolleranza = slot; al minuto (eccezione esplicita) → ~0.
function toleranceMin(order, promiseSlotMin) {
  return order.promesa_precisa === true ? 0 : promiseSlotMin;
}

// ===============================================================
// Manual multi-zone route / RIDER BLOCK (spec §Manual route)
// ===============================================================
// Un manual_route è un VINCOLO FORTE deciso dall'operatore/rider: un solo giro
// sequenziale (pizzeria → A → B → C) che PUÒ attraversare zone diverse e che il
// planner NON deve spezzare. Occupa il rider da block_start a block_end e impedisce
// l'inserimento di altri delivery in quell'intervallo (salvo override esplicito).
//
//   manual_giro {
//     id, type:"manual_route", order_ids, route_order?,
//     block_start?, manual_duration_min?, created_by_operator?, force?
//   }
//
// Durata operativa del block:
//   • manual_duration_min presente → AUTORITATIVA (block_end = block_start + durata);
//     se molto diversa dalla stima → warning `duracion_manual_vs_estimada`.
//   • assente → stimata dalla sequenza con i dati di andata/fallback (NIENTE ritorno
//     in pizzeria tra una consegna e l'altra: legs cliente→cliente).
//
// Tutto puro: nessun side-effect, niente I/O. Echeggia FATTI GREZZI (I1).

// Stima sequenziale della route (cliente→cliente, senza rientri intermedi).
// Senza matrice punto-punto usiamo `andata_min` di ogni stop come proxy del salto
// che lo raggiunge, più un buffer operativo per consegna. Ritorna i tempi cumulati
// di arrivo a ogni stop (dal momento di partenza = 0) e la durata totale del block.
function estimateRouteDuration(stops, bufferOpsMin) {
  const arrivals = [];
  let cum = 0;
  for (let i = 0; i < stops.length; i++) {
    const hop = Math.max(0, Number(stops[i].andata_min) || 0); // proxy salto → stop i
    cum += hop;
    arrivals.push(cum);          // arrivo (consegna) allo stop i
    cum += bufferOpsMin;         // sosta/citofono/handoff prima di ripartire
  }
  // durata block = ultimo arrivo + un'ultima sosta operativa al cliente finale.
  const total = (arrivals.length ? arrivals[arrivals.length - 1] : 0) + bufferOpsMin;
  return { arrivals, total };
}

// Costruisce un rider block da una def manual_route + i suoi membri (ordini reali).
// ctx = { nowSvc, cfg, driverFloor, addOven }
// Ritorna { trip, interval:[start,end], orders:{id->proj} } oppure null se vuoto.
function buildRiderBlock(route, rawMembers, ctx) {
  const { nowSvc, cfg, driverFloor } = ctx;
  if (!rawMembers.length) return null;

  // Ordina i membri secondo route_order (se presente), altrimenti order_ids/arrivo.
  const orderIndex = new Map();
  const seq = Array.isArray(route.route_order) && route.route_order.length
    ? route.route_order
    : (Array.isArray(route.order_ids) ? route.order_ids : rawMembers.map(m => m.id));
  seq.forEach((id, i) => orderIndex.set(id, i));
  const stops = [...rawMembers].sort(
    (a, b) => (orderIndex.has(a.id) ? orderIndex.get(a.id) : 1e9) -
              (orderIndex.has(b.id) ? orderIndex.get(b.id) : 1e9)
  );

  const est = estimateRouteDuration(stops, cfg.bufferOpsDriverMin);
  const hasManual = route.manual_duration_min != null && Number.isFinite(Number(route.manual_duration_min));
  const actualDur = hasManual ? Number(route.manual_duration_min) : est.total;

  // ── block_start ────────────────────────────────────────────────────────────
  // operatore ha indicato block_start → autoritativo (anche se il rider è occupato:
  // in quel caso warning `rider_ocupado`, l'operatore comanda). Altrimenti stima:
  // parti per consegnare il primo stop intorno alla sua promessa, mai prima che il
  // rider sia libero.
  let blockStart, startSource;
  if (route.block_start != null) {
    blockStart = toSvc(route.block_start);
    startSource = "manual";
  } else {
    const promises = stops.map(s => toSvc(s.forzado_hora || s.hora)).filter(x => x != null);
    const earliest = promises.length ? Math.min(...promises) : driverFloor;
    const firstLeg = est.arrivals.length ? est.arrivals[0] : 0;
    blockStart = Math.max(driverFloor, earliest - firstLeg);
    startSource = "estimated";
  }
  const riderBusy = blockStart < driverFloor;          // rider non libero a block_start
  const blockEnd = blockStart + actualDur;

  // Scala i tempi di arrivo stimati sulla durata effettiva (manuale o stimata),
  // così i per-stop entrega restano coerenti col block_end dichiarato.
  const denom = est.total > 0 ? est.total : (actualDur || 1);
  const scale = actualDur > 0 ? actualDur / denom : 1;

  // ── warnings di blocco ───────────────────────────────────────────────────────
  const warnings = [];
  if (hasManual) {
    const diff = Math.abs(actualDur - est.total);
    if (diff > cfg.riderBlockDurMismatchMin && diff > cfg.riderBlockDurMismatchRatio * Math.max(1, est.total)) {
      warnings.push("duracion_manual_vs_estimada");
    }
  }
  if (riderBusy) warnings.push("rider_ocupado");

  const zones = [...new Set(stops.map(s => s.zona).filter(Boolean))];
  if (zones.length > 1) warnings.push("multi_zona");

  // ── per-stop: entrega, retraso (I9), prontezza pizza (I8) ─────────────────────
  const ordersOut = {};
  const issues = [];
  let pizzeTot = 0;
  const memberIds = [];
  const entregas = [];
  for (let i = 0; i < stops.length; i++) {
    const m = stops[i];
    memberIds.push(m.id);
    const pizze = Number(m.n_pizze) || 0;
    pizzeTot += pizze;
    const freeze = classifyFreeze(m, nowSvc, cfg.margineCotturaMin);
    const arrivalSvc = Math.round(blockStart + est.arrivals[i] * scale);
    entregas.push(arrivalSvc);

    // retraso sulla promessa + granularità, MAI sulla finestra del block (I9).
    const tol = toleranceMin(m, cfg.promiseSlotMin);
    const promessaSvc = toSvc(m.forzado_hora || m.hora);
    const retraso = promessaSvc != null ? Math.max(0, arrivalSvc - (promessaSvc + tol)) : 0;

    // prontezza pizza: tutte le pizze del block escono a block_start (I8). Se un membro
    // ha un forno_out committato OLTRE block_start, o non è materialmente cuocibile in
    // tempo, è un rischio reale → non "tutto ok" silenzioso.
    const foCommitted = toSvc(m.forno_out);
    const notReady = foCommitted != null && foCommitted > blockStart;

    // desfase: la promessa dell'ordine si è mossa rispetto al block → consegna troppo
    // PRESTO (pizza fatta in anticipo / ordine fuori sync). Segnala incoerenza così una
    // modifica successiva (es. hora +30) non lascia la timeline "sporca" e silenziosa.
    const early = promessaSvc != null ? (promessaSvc - tol) - arrivalSvc : 0;
    const desfasado = early > cfg.riderBlockEarlyToleranceMin;

    const reasons = [`rider_block ${route.id}`];
    if (m.zona) reasons.push(`zona ${m.zona}`);
    if (notReady) { reasons.push("pizza_not_ready"); issues.push({ order: m.id, type: "pizza_not_ready", forno_out: m.forno_out, block_start: fromSvc(blockStart) }); }
    if (retraso > 0) { reasons.push("cliente_fuera_slot"); issues.push({ order: m.id, type: "cliente_fuera_slot", retraso }); }
    if (desfasado) { reasons.push("orden_desfasada"); issues.push({ order: m.id, type: "orden_desfasada", early, promesa: m.forzado_hora || m.hora, entrega: fromSvc(arrivalSvc) }); }

    ctx.addOven(blockStart, pizze);   // tutte le pizze escono a block_start

    ordersOut[m.id] = {
      id: m.id, tipo: "DOMICILIO", giro_id: `BLK:${route.id}`, freeze,
      rider_block: route.id,
      forno_out: fromSvc(blockStart),          // I8
      salida: fromSvc(blockStart),
      entrega: fromSvc(arrivalSvc),
      retraso, conflicto: retraso > 0,
      forzado: !!route.force || !!m.forzado,
      reasons,
    };
  }

  // ── coerenza del block + opzioni di risoluzione ──────────────────────────────
  const coherent = issues.length === 0;
  let options = [];
  if (!coherent) {
    warnings.push("block_incoherente");
    options = [
      { action: "quitar_orden", reason: "togli dal block gli ordini in conflitto" },
      { action: "mover_bloque", reason: "sposta block_start per recuperare prontezza/slot" },
      { action: "mantener_forzado", reason: "mantieni forzato accettando warning" },
      { action: "preguntar_operador", reason: "chiedi priorità all'operatore" },
    ];
  }
  // force:true ⇒ vincolo forte: il block resta com'è, i warning si propagano (D3).
  const status = coherent ? "coherent" : (route.force ? "forced" : "needs_decision");

  const trip = {
    id: `BLK:${route.id}`,
    type: "manual_route",
    manual_giro_id: route.id,
    zona: zones.length === 1 ? zones[0] : null,
    zones,
    created_by_operator: route.created_by_operator !== false,
    force: !!route.force,
    block_start: fromSvc(blockStart),
    block_end: fromSvc(blockEnd),
    duration_min: actualDur,
    duration_source: hasManual ? "manual" : "estimated",
    estimated_duration_min: est.total,
    route_order: stops.map(m => m.id),
    delivery_window: [fromSvc(Math.min(...entregas)), fromSvc(Math.max(...entregas))],
    anchor: fromSvc(slotStart(blockStart, cfg.promiseSlotMin)),
    departure: fromSvc(blockStart),
    rientro: fromSvc(blockEnd),
    pizze: pizzeTot,
    count: stops.length,
    members: memberIds,
    coherent, status, issues, options, warnings,
  };

  return { trip, interval: [blockStart, blockEnd], orders: ordersOut };
}

// ===============================================================
// buildPlan(snapshot) -> Plan
// ===============================================================
// snapshot = {
//   now: "HH:MM",
//   forno?: { slotMin, maxPerSlot },
//   margineCotturaMin?, promiseSlotMin?, bufferOpsDriverMin?,
//   zones?: { Q1:{maxOrdiniPerGiro}, ... },
//   driver?: { libero_desde: "HH:MM" } | null,   // rider reale: quando rientra
//   manual_giros?: [{                            // §Manual route — rider block
//     id, type:"manual_route", order_ids:[...], route_order?:[...],
//     block_start?, manual_duration_min?, created_by_operator?, force?
//   }],
//   // §Real rider events — eventi reali come TRIGGER (non dipendenza assoluta).
//   // Se presenti, fissano il pavimento di disponibilità rider per il FUTURO;
//   // se assenti, si usa la simulazione. Si conserva source/confidence.
//   driver_status?: { available_from: "HH:MM", source?: "driver_app"|"operator_button"|"system_estimate" },
//   driver_events?: [{ type:"rider_left"|"rider_returned"|"rider_available", at:"HH:MM", source? }],
//   orders: [{
//     id, tipo_consegna:"DOMICILIO"|"RITIRO", estado, zona,
//     hora,                 // promessa cliente (fatto grezzo)
//     andata_min,           // snapshot geo (fatto grezzo)
//     n_pizze,
//     manual_giro_id?, forzado?, forzado_hora?, promesa_precisa?, created_at?,
//     // per i CONGELATI: valori committati (realtà, input — I1):
//     forno_out?, salida_driver_estimada?, entrega_estimada?
//   }]
// }
// Confidenza per source dell'evento reale (driver_app più affidabile della stima).
const SOURCE_CONFIDENCE = { driver_app: 0.95, operator_button: 0.8, system_estimate: 0.5 };

// Risolve la disponibilità del rider da eventi reali (trigger) o, in assenza, dalla
// simulazione legacy. Ritorna { svc, available_from, source, confidence, reason, real }.
//   real=true  → l'operatore/driver ha dichiarato un fatto (batte la stima per il FUTURO).
//   real=false → nessun evento: si prosegue con la stima (snapshot.driver.libero_desde).
function resolveRiderAvailability(snapshot) {
  // 1) driver_status esplicito (snapshot puntuale).
  const st = snapshot.driver_status;
  if (st && st.available_from) {
    const source = st.source || "operator_button";
    return mkAvail(toSvc(st.available_from), st.available_from, source, "driver_status.available_from", true);
  }
  // 2) driver_events: prendi l'ultimo rider_returned/rider_available (per `at`).
  const evs = (snapshot.driver_events || []).filter(
    e => e && (e.type === "rider_returned" || e.type === "rider_available") && e.at
  );
  if (evs.length) {
    const last = evs.reduce((a, b) => (toSvc(b.at) ?? -1) >= (toSvc(a.at) ?? -1) ? b : a);
    const source = last.source || "operator_button";
    return mkAvail(toSvc(last.at), last.at, source, `evento reale ${last.type}`, true);
  }
  // 3) Legacy / stima: snapshot.driver.libero_desde.
  if (snapshot.driver && snapshot.driver.libero_desde) {
    return mkAvail(toSvc(snapshot.driver.libero_desde), snapshot.driver.libero_desde,
      "system_estimate", "stima simulazione (nessun evento reale)", false);
  }
  return { svc: null, available_from: null, source: "system_estimate", confidence: SOURCE_CONFIDENCE.system_estimate, reason: "nessun dato rider", real: false };
}
function mkAvail(svc, hhmm, source, reason, real) {
  return { svc, available_from: hhmm, source, confidence: SOURCE_CONFIDENCE[source] ?? 0.5, reason, real };
}

function buildPlan(snapshot) {
  const cfg = {
    forno: { ...DEFAULTS.forno, ...(snapshot.forno || {}) },
    margineCotturaMin: snapshot.margineCotturaMin ?? DEFAULTS.margineCotturaMin,
    promiseSlotMin: snapshot.promiseSlotMin ?? DEFAULTS.promiseSlotMin,
    bufferOpsDriverMin: snapshot.bufferOpsDriverMin ?? DEFAULTS.bufferOpsDriverMin,
    zones: snapshot.zones || {},
  };
  cfg.riderBlockDurMismatchMin = snapshot.riderBlockDurMismatchMin ?? DEFAULTS.riderBlockDurMismatchMin;
  cfg.riderBlockDurMismatchRatio = snapshot.riderBlockDurMismatchRatio ?? DEFAULTS.riderBlockDurMismatchRatio;
  cfg.riderBlockEarlyToleranceMin = snapshot.riderBlockEarlyToleranceMin ?? DEFAULTS.riderBlockEarlyToleranceMin;
  const nowSvc = toSvc(snapshot.now);
  const maxPerGiro = (zona) =>
    cfg.zones[zona]?.maxOrdiniPerGiro ?? DEFAULTS.defaultMaxOrdiniPerGiro;

  // ── Manual multi-zone route / rider block: indicizza le def operatore ─────────
  const manualRoutes = (snapshot.manual_giros || []).filter(g => g && g.type === "manual_route");
  const routeById = new Map(manualRoutes.map(g => [g.id, g]));
  const orderRouteId = new Map(); // order_id -> route_id
  for (const g of manualRoutes) for (const oid of (g.order_ids || [])) orderRouteId.set(oid, g.id);
  const routeMembers = new Map(); // route_id -> [order,...]  (raccolti dallo scheduling)
  for (const g of manualRoutes) routeMembers.set(g.id, []);

  const orders = (snapshot.orders || []).filter(Boolean);
  const ordersOut = {}; // id -> projection
  const ovenLoad = {};  // slotStart -> pizze
  const warnings = [];
  const addOven = (foSvc, pizze) => {
    if (foSvc == null) return;
    const s = slotStart(foSvc, cfg.forno.slotMin);
    ovenLoad[s] = (ovenLoad[s] || 0) + (pizze || 0);
  };

  // ── Stage 0 — partizione ───────────────────────────────────────────────────
  const active = orders.filter(o => !INACTIVE_STATES.has(o.estado) || o.estado === "RETIRADO");
  // RETIRADO resta "inattivo" per lo scheduling ma lo escludiamo del tutto:
  const sched = orders.filter(o => !INACTIVE_STATES.has(o.estado));

  // Forno: TUTTE le pizze attive contano (domicilio + ritiro) — Cucina vede tutto.
  // Congelati duri + ritiri preoccupano gli slot forno coi loro valori committati.
  const driverWalls = []; // intervalli [partenza,rientro] del rider già impegnato

  // ── §Real rider events — risoluzione disponibilità rider (trigger, non vincolo) ─
  // Priorità: evento reale (rider_returned/available, il più recente) o driver_status
  //   → pavimento di disponibilità per lo scheduling FUTURO, con source/confidence.
  // Se manca ogni evento reale → simulazione (legacy snapshot.driver.libero_desde),
  //   marcata source "system_estimate" (l'operatore non ha premuto nessun bottone).
  const riderAvail = resolveRiderAvailability(snapshot);
  let driverFreeBase = riderAvail.svc != null ? riderAvail.svc : 0;

  const tripBuckets = new Map();

  for (const o of sched) {
    // Membro di un manual_route → fuori dal bucketing normale: lo gestisce il rider
    // block (catena sequenziale, anche multi-zona). NON spezzare (vincolo forte).
    if (orderRouteId.has(o.id)) {
      routeMembers.get(orderRouteId.get(o.id)).push(o);
      continue;
    }

    const freeze = classifyFreeze(o, nowSvc, cfg.margineCotturaMin);
    const pizze = Number(o.n_pizze) || 0;

    if (o.tipo_consegna === "RITIRO") {
      // RITIRO: forno_out = hora (nessuna andata). Occupa forno, non il rider.
      const foSvc = toSvc(o.forno_out) ?? toSvc(o.hora);
      addOven(foSvc, pizze);
      ordersOut[o.id] = {
        id: o.id, tipo: "RITIRO", giro_id: null, freeze,
        forno_out: fromSvc(foSvc), salida: null, entrega: null,
        retraso: 0, conflicto: false, forzado: !!o.forzado, reasons: ["ritiro: occupa forno"],
      };
      continue;
    }

    if (freeze === "CONGELATO_DURO") {
      // Parete: echeggia i valori committati (realtà — NON ricalcola, I1).
      const foSvc = toSvc(o.forno_out);
      const salSvc = toSvc(o.salida_driver_estimada);
      const entSvc = toSvc(o.entrega_estimada);
      addOven(foSvc, pizze);
      if (salSvc != null) {
        const tg = Number(o.andata_min) || 0;
        driverWalls.push([salSvc, entSvc != null ? entSvc + cfg.bufferOpsDriverMin + tg : salSvc + 2 * tg + cfg.bufferOpsDriverMin]);
      }
      ordersOut[o.id] = {
        id: o.id, tipo: "DOMICILIO", giro_id: o.manual_giro_id || null, freeze,
        forno_out: o.forno_out || fromSvc(foSvc),
        salida: o.salida_driver_estimada || fromSvc(salSvc),
        entrega: o.entrega_estimada || fromSvc(entSvc),
        retraso: o.retraso_estimado_min ?? 0,
        conflicto: o.conflicto_driver === true,
        forzado: !!o.forzado,
        reasons: ["congelato duro: parete (valori committati)"],
      };
      continue;
    }

    // MOVIBILE / SEMI → entrano nel bucketing dei giri.
    const key = o.manual_giro_id
      ? `MG:${o.manual_giro_id}`
      : `AU:${o.zona}|${slotStart(toSvc(o.hora), cfg.promiseSlotMin)}`;
    if (!tripBuckets.has(key)) {
      tripBuckets.set(key, {
        key, manual_giro_id: o.manual_giro_id || null,
        zona: o.zona, members: [],
      });
    }
    const b = tripBuckets.get(key);
    if (b.zona !== o.zona) { warnings.push(`giro ${key}: zone miste (${b.zona} vs ${o.zona})`); }
    b.members.push(o);
  }

  // ── Stage M — costruisci i RIDER BLOCK (manual_route) ───────────────────────
  // I block sono vincoli forti dell'operatore: hanno priorità sul movibile automatico.
  // Si schedulano sul pavimento rider (driverFreeBase + walls dei congelati), poi le
  // loro finestre [block_start, block_end] diventano walls per gli automatici (Stage 3),
  // così NESSUN delivery automatico finisce dentro al block (salvo override esplicito).
  const blocks = [];
  {
    let blkFloor = driverFreeBase;
    for (const [, end] of driverWalls) blkFloor = Math.max(blkFloor, end);
    // Ordina i block per block_start dichiarato (manuali prima), gli stimati a seguire.
    const routeIds = [...routeMembers.keys()].sort((a, b) => {
      const sa = toSvc(routeById.get(a).block_start), sb = toSvc(routeById.get(b).block_start);
      return (sa == null ? 1 : 0) - (sb == null ? 1 : 0) || (sa ?? 0) - (sb ?? 0);
    });
    for (const rid of routeIds) {
      const route = routeById.get(rid);
      const members = routeMembers.get(rid);
      const built = buildRiderBlock(route, members, { nowSvc, cfg, driverFloor: blkFloor, addOven });
      if (!built) continue;
      Object.assign(ordersOut, built.orders);
      driverWalls.push(built.interval);           // occupa la timeline rider
      blkFloor = Math.max(blkFloor, built.interval[1]);
      for (const w of built.trip.warnings) {
        if (w === "block_incoherente" || w === "rider_ocupado" || w === "duracion_manual_vs_estimada")
          warnings.push(`block ${rid}: ${w}`);
      }
      blocks.push(built.trip);
    }
  }

  // ── Stage 1 — costruisci i trip ─────────────────────────────────────────────
  const trips = [];
  for (const b of tripBuckets.values()) {
    const horas = b.members.map(m => toSvc(m.hora));
    const tripHora = Math.min(...horas);
    const tg = Math.max(...b.members.map(m => Number(m.andata_min) || 0));
    const pizze = b.members.reduce((s, m) => s + (Number(m.n_pizze) || 0), 0);
    const wMin = Math.min(...horas), wMax = Math.max(...horas);
    const tw = [];
    if (wMax - wMin > cfg.promiseSlotMin) tw.push("spans_slots");
    if (b.members.length > maxPerGiro(b.zona)) tw.push("giro_overflow");
    const anyForzado = b.members.some(m => !!m.forzado);
    const minCreated = Math.min(...b.members.map(m => new Date(m.created_at || 0).getTime() || 0));
    // §Prudent replanning — pavimento "operativo" per i SEMI-CONGELATI: un ordine già
    // in cucina con salida committata NON deve essere anticipato dal tempo recuperato.
    // Il floor = max salida_driver_estimada committata dei membri semi-congelati.
    let frozenFloor = -Infinity;
    for (const m of b.members) {
      if (classifyFreeze(m, nowSvc, cfg.margineCotturaMin) === "SEMI_CONGELATO") {
        const committed = toSvc(m.salida_driver_estimada) ?? toSvc(m.forno_out);
        if (committed != null) frozenFloor = Math.max(frozenFloor, committed);
      }
    }
    trips.push({
      key: b.key, zona: b.zona, manual_giro_id: b.manual_giro_id,
      members: b.members, tripHora, tg, pizze,
      forzado: anyForzado, minCreated, warnings: tw,
      frozenFloor: Number.isFinite(frozenFloor) ? frozenFloor : null,
    });
  }

  // ── Stage 2 — FIFO + tie-breaker (D2) ───────────────────────────────────────
  //   hora_promessa ↑, poi forzato, poi giro già scelto (manual), poi created_at
  trips.sort((a, b) =>
    (a.tripHora - b.tripHora) ||
    (Number(b.forzado) - Number(a.forzado)) ||
    (Number(!!b.manual_giro_id) - Number(!!a.manual_giro_id)) ||
    (a.minCreated - b.minCreated)
  );

  // ── Stage 3 — sequenzia il rider + gate forno (couple forno↔driver) ─────────
  let driverFree = driverFreeBase;
  // walls del rider già impegnato: spingono il pavimento se si sovrappongono
  driverWalls.sort((x, y) => x[0] - y[0]);
  for (const [, end] of driverWalls) driverFree = Math.max(driverFree, end);

  const cap = cfg.forno.maxPerSlot;
  const softMax = cfg.forno.softOverloadMax ?? (cap + 1);
  const seriousMax = cfg.forno.seriousOverloadMax ?? (cap + 3);

  for (const t of trips) {
    const partTeorica = t.tripHora - t.tg;
    // §Prudent replanning: i SEMI-CONGELATI non vengono anticipati sotto la loro
    // salida committata, anche se il rider è tornato prima (tempo recuperato).
    const floor = t.frozenFloor != null ? t.frozenFloor : -Infinity;
    let desiredDep = Math.max(driverFree, partTeorica, floor);

    // §Soft oven overload — gate forno a SOGLIE (non più shift secco a cap+1):
    //   ≤cap        ok
    //   cap+1..soft soft overload   → NESSUN shift, warning morbido
    //   ..serious   overload serio  → NESSUN shift, warning serio
    //   >serious    hard overload   → shift in avanti finché rientra nel serio/cap
    let depSlot = slotStart(desiredDep, cfg.forno.slotMin);
    let movedForForno = false;
    let guard = 0;
    // sposta SOLO per hard overload e solo se uno slot successivo migliora davvero.
    while ((ovenLoad[depSlot] || 0) + t.pizze > seriousMax && guard < 200) {
      const next = depSlot + cfg.forno.slotMin;
      if ((ovenLoad[next] || 0) >= (ovenLoad[depSlot] || 0)) break; // nessun miglioramento → stop
      depSlot = next;
      movedForForno = true;
      guard++;
    }
    const departure = Math.max(desiredDep, depSlot);
    const fornoSlot = slotStart(departure, cfg.forno.slotMin);
    const projected = (ovenLoad[fornoSlot] || 0) + t.pizze;
    ovenLoad[fornoSlot] = projected;
    // classifica l'overload risultante sullo slot di partenza
    let overload = null;
    if (projected > seriousMax) overload = "hard";
    else if (projected > softMax) overload = "serio";
    else if (projected > cap) overload = "soft";

    const rientro = departure + t.tg + cfg.bufferOpsDriverMin + t.tg;
    driverFree = rientro;

    // per-membro
    const entregas = [];
    for (const m of t.members) {
      const andata = Number(m.andata_min) || 0;
      const entregaSvc = departure + andata;
      entregas.push(entregaSvc);
      const tol = toleranceMin(m, cfg.promiseSlotMin);
      const promessaSvc = toSvc(m.forzado_hora || m.hora);
      const retraso = Math.max(0, entregaSvc - (promessaSvc + tol));
      const reasons = [];
      if (movedForForno) reasons.push("forno hard overload: giro spostato avanti");
      else if (overload === "soft") reasons.push("forno soft overload (+1 tollerato, niente shift)");
      else if (overload === "serio") reasons.push("forno overload serio (rivedere)");
      const semiHeld = t.frozenFloor != null && departure <= t.frozenFloor;
      if (semiHeld) reasons.push("semi-congelato protetto: non anticipato dal tempo recuperato");
      if (m.estado === "EN_COCINA") reasons.push("semi-congelato: già in cucina");
      if (m.forzado) reasons.push("forzato dall'operatore");
      ordersOut[m.id] = {
        id: m.id, tipo: "DOMICILIO", giro_id: t.key,
        freeze: m.estado === "EN_COCINA" ? "SEMI_CONGELATO" : "MOVIBILE",
        forno_out: fromSvc(departure),              // I8
        salida: fromSvc(departure),
        entrega: fromSvc(entregaSvc),
        retraso, conflicto: retraso > 0,
        forzado: !!m.forzado, reasons,
      };
    }

    t.departure = departure;
    t.forno_slot = fornoSlot;
    t.overload = overload;
    t.delivery_window = [fromSvc(Math.min(...entregas)), fromSvc(Math.max(...entregas))];
    t.anchor = fromSvc(slotStart(t.tripHora, cfg.promiseSlotMin));
    t.rientro = rientro;
    // §Soft oven overload — warning graduati (solo "hard" implica/segnala lo shift)
    if (overload === "soft") t.warnings.push("forno_soft_overload");
    else if (overload === "serio") t.warnings.push("forno_overload_serio");
    else if (overload === "hard") t.warnings.push("forno_pieno");
    if (movedForForno && !t.warnings.includes("forno_pieno")) t.warnings.push("forno_pieno");
  }

  const autoTrips = trips.map(t => ({
    id: t.key, type: "automatic", zona: t.zona, manual_giro_id: t.manual_giro_id,
    anchor: t.anchor, departure: fromSvc(t.departure),
    delivery_window: t.delivery_window, rientro: fromSvc(t.rientro),
    pizze: t.pizze, count: t.members.length,
    members: t.members.map(m => m.id), warnings: t.warnings,
  }));

  // ── Invariante rider: nessun trip/block sovrapposto sulla timeline (§10) ──────
  const riderIntervals = [
    ...blocks.map(b => ({ id: b.id, start: toSvc(b.block_start), end: toSvc(b.block_end) })),
    ...trips.map(t => ({ id: t.key, start: t.departure, end: t.rientro })),
  ].filter(x => x.start != null && x.end != null).sort((a, b) => a.start - b.start);
  const riderOverlaps = [];
  for (let i = 1; i < riderIntervals.length; i++) {
    if (riderIntervals[i].start < riderIntervals[i - 1].end) {
      riderOverlaps.push([riderIntervals[i - 1].id, riderIntervals[i].id]);
      warnings.push(`rider overlap: ${riderIntervals[i - 1].id} ∩ ${riderIntervals[i].id}`);
    }
  }

  // §Real rider events — esponi la disponibilità rider usata (source/confidence)
  // e, se è un evento reale, segnala che ha aggiornato la timeline futura.
  if (riderAvail.real && riderAvail.available_from) {
    warnings.push(`rider event applicato: disponibile da ${riderAvail.available_from} (${riderAvail.source})`);
  }

  return {
    now: snapshot.now,
    config: cfg,
    driver: {
      available_from: riderAvail.available_from,
      source: riderAvail.source,
      confidence: riderAvail.confidence,
      real_event: riderAvail.real,
      reason: riderAvail.reason,
    },
    trips: [...blocks, ...autoTrips],
    blocks,
    orders: ordersOut,
    ovenLoad,
    rider_overlaps: riderOverlaps,
    warnings,
  };
}

// ===============================================================
// evaluateNewOrder(snapshot, newOrder) -> verdict (spec §8)
// ===============================================================
// Option-first: genera le opzioni (separata / join giri esistenti), valida ognuna
// ri-eseguendo buildPlan sullo snapshot + ordine ipotetico (preview === engine, I4).
function evaluateNewOrder(snapshot, newOrder) {
  const cfg = {
    margineCotturaMin: snapshot.margineCotturaMin ?? DEFAULTS.margineCotturaMin,
    promiseSlotMin: snapshot.promiseSlotMin ?? DEFAULTS.promiseSlotMin,
    recoWindow: DEFAULTS.giroRecommendationWindowMin,
  };
  const nowSvc = toSvc(snapshot.now);
  const base = buildPlan(snapshot);
  const options = [];

  // forno_out "naturale" del nuovo ordine (separata): hora - andata.
  const reqHoraSvc = toSvc(newOrder.hora);
  const andata = Number(newOrder.andata_min) || 0;

  // Rider block attivi: la partenza desiderata che cade dentro un block non può
  // essere servita lì dentro (vincolo forte) → la separata viene spinta dopo il block.
  const desiredDepSvc = reqHoraSvc != null ? reqHoraSvc - andata : null;
  const hitBlock = base.blocks.find(b =>
    desiredDepSvc != null && desiredDepSvc >= toSvc(b.block_start) && desiredDepSvc < toSvc(b.block_end));

  // ── Opzione separata alla hora richiesta ────────────────────────────────────
  {
    const snap2 = withOrder(snapshot, { ...newOrder, manual_giro_id: null });
    const plan = buildPlan(snap2);
    const proj = plan.orders[newOrder.id];
    // Guard físico (D1): una pizza no puede salir del horno en el pasado. El mínimo
    // forno_out factible = now + margen de cocción → la entrega mínima = now +
    // cocción + andata. Sin esto buildPlan agendaba el reparto en el pasado (no hay
    // suelo "now" en la Stage 3) y la separada se marcaba "valid" con forno_out ya
    // pasado → el operador podía confirmar una entrega imposible (bug crítico
    // can_confirm). Coherente con previewOrderTiming ("muy pronta · mínimo …").
    const projFornoSvc = proj ? toSvc(proj.forno_out) : null;
    const minFornoSvc = nowSvc != null ? nowSvc + cfg.margineCotturaMin : null;
    const tooEarly = minFornoSvc != null && projFornoSvc != null && projFornoSvc < minFornoSvc;
    const minHora = minFornoSvc != null ? fromSvc(minFornoSvc + andata) : null;
    const status = (!tooEarly && proj && proj.retraso === 0) ? "valid" : "blocked";
    options.push({
      type: "separate",
      hora: proj ? proj.entrega : newOrder.hora,
      anchor: fromSvc(slotStart(toSvc(proj ? proj.entrega : newOrder.hora), cfg.promiseSlotMin)),
      required_forno_out: tooEarly ? null : (proj ? proj.forno_out : null),
      salida: tooEarly ? null : (proj ? proj.salida : null),
      retraso: proj ? proj.retraso : null,
      status,
      ...(tooEarly ? { too_early: true, min_hora: minHora } : {}),
      ...(hitBlock ? { after_block: hitBlock.id, blocked_by_rider_block: true } : {}),
      reason: tooEarly
        ? `Hora pedida muy pronta · mínimo ${minHora} (cocina + andata)`
        : hitBlock
          ? `dentro rider block ${hitBlock.id}: propuesta tras el block (${hitBlock.block_end})`
          : (status === "valid" ? "prima separata libera" : "no llega a la hora pedida"),
    });
  }

  // ── Opzioni join sui giri esistenti stessa zona ─────────────────────────────
  for (const t of base.trips) {
    // Rider block (manual_route): vincolo forte, il planner NON ci infila delivery da
    // solo. Offerto solo come override esplicito dell'operatore.
    if (t.type === "manual_route") {
      options.push({
        type: "join_block", giro_id: t.id, block_start: t.block_start, block_end: t.block_end,
        status: "blocked", requires_override: true,
        reason: "rider block manuale: inserimento solo con override esplicito dell'operatore",
      });
      continue;
    }
    if (t.zona !== newOrder.zona) continue; // zona diversa → Ocupado (non opzione)
    const depSvc = toSvc(t.departure);
    const full = t.count >= (snapshot.zones?.[t.zona]?.maxOrdiniPerGiro ?? DEFAULTS.defaultMaxOrdiniPerGiro);
    // aggregabile SOLO se la pizza nuova (al suo forno naturale = hora−andata) esce
    // entro la partenza del giro (+margine 2), e il giro non è già partito/congelato.
    const newNaturalForno = reqHoraSvc != null ? reqHoraSvc - andata : null;
    const aggMargin = DEFAULTS.giroAggregationMarginMin;
    const tooLate = depSvc <= nowSvc + cfg.margineCotturaMin;          // giro già partito
    const notReady = newNaturalForno != null && newNaturalForno > depSvc + aggMargin;

    if (full || tooLate || notReady) {
      options.push({
        type: "join_giro", giro_id: t.id, anchor: t.anchor,
        delivery_window: t.delivery_window, hora: t.anchor,
        status: "blocked",
        no_agregable: true,
        reason: full ? "giro lleno"
          : tooLate ? "giro ya salió / congelado"
          : "la pizza saldría del horno demasiado tarde para este giro",
      });
      continue;
    }

    // join feasible: simula l'aggiunta dentro il giro.
    const giroMemberId = t.members[0];
    const giroOrder = (snapshot.orders || []).find(o => o.id === giroMemberId);
    const snap2 = withOrder(snapshot, { ...newOrder, manual_giro_id: giroOrder?.manual_giro_id || undefined, hora: giroOrder?.hora || newOrder.hora, _join_zona_slot: true });
    // se il giro è auto (no manual_giro_id), allineiamo la hora allo slot del giro
    const joinHora = giroOrder?.hora || t.anchor;
    const snapJoin = withOrder(snapshot, { ...newOrder, hora: joinHora, manual_giro_id: giroOrder?.manual_giro_id || undefined });
    const planJ = buildPlan(snapJoin);
    const projJ = planJ.orders[newOrder.id];
    options.push({
      type: "join_giro", giro_id: t.id, anchor: t.anchor,
      delivery_window: projJ ? planJ.trips.find(x => x.id === projJ.giro_id)?.delivery_window : t.delivery_window,
      hora: t.anchor, required_forno_out: projJ ? projJ.forno_out : t.departure,
      retraso: projJ ? projJ.retraso : null,
      kitchen_status: "ok", delivery_status: "ok",
      status: "valid",
      reason: "aggregabile, pizza pronta entro la partenza",
    });
  }

  // ── Raccomandazione: miglior join valido entro la finestra; altrimenti separata ─
  const validJoins = options.filter(o => o.type === "join_giro" && o.status === "valid")
    .map(o => ({ ...o, _diff: Math.abs((toSvc(o.anchor) ?? 0) - (reqHoraSvc ?? 0)) }))
    .filter(o => o._diff <= cfg.recoWindow)
    .sort((a, b) => a._diff - b._diff);
  let recommended = null;
  if (validJoins[0]) {
    recommended = { ...validJoins[0], status: "recommended", reason: "más cercano y compatible" };
    const idx = options.findIndex(o => o.giro_id === validJoins[0].giro_id && o.type === "join_giro");
    if (idx >= 0) options[idx] = { ...options[idx], status: "recommended" };
  }

  // ── selected = separata valida (default finché operatore non sceglie il giro) ─
  const sep = options.find(o => o.type === "separate");
  const selected = sep && sep.status === "valid"
    ? { type: "separate", hora: sep.hora, forno_out: sep.required_forno_out, status: "valid" }
    : (recommended ? { type: recommended.type, giro_id: recommended.giro_id, hora: recommended.hora, status: "recommended" }
                   : (sep ? { type: "separate", hora: sep.hora, status: sep.status } : null));

  // ── próximo slot (se separata bloccata): rider libero per la zona, arrotondato su ─
  let proximo_slot = null;
  if (sep && sep.status === "blocked") {
    const zoneTrips = base.trips.filter(t => t.zona === newOrder.zona);
    const riderFree = zoneTrips.length
      ? Math.max(...zoneTrips.map(t => toSvc(t.rientro)))
      : (nowSvc + cfg.margineCotturaMin);
    proximo_slot = fromSvc(ceilTo(riderFree + andata, cfg.promiseSlotMin));
  }

  return { selected, recommended, options, proximo_slot, warnings: base.warnings, snapshot_now: snapshot.now };
}

// helper: clona lo snapshot aggiungendo un ordine (preview, nessuna mutazione)
function withOrder(snapshot, order) {
  return {
    ...snapshot,
    orders: [...(snapshot.orders || []), {
      tipo_consegna: "DOMICILIO", estado: "NUEVO", n_pizze: 1, ...order,
    }],
  };
}

module.exports = {
  buildPlan,
  evaluateNewOrder,
  // esposti per i test:
  _internal: { toSvc, fromSvc, slotStart, ceilTo, classifyFreeze, estimateRouteDuration, buildRiderBlock, resolveRiderAvailability, SOURCE_CONFIDENCE, DEFAULTS },
};
