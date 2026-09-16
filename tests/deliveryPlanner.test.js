// tests/deliveryPlanner.test.js
// Delivery Planning Orchestrator — passo 1. Funzioni PURE, nessun DB/Supabase.
// Run: node tests/deliveryPlanner.test.js
// Copre gli scenari di SPEC §13.

const assert = require("assert");
const { buildPlan, evaluateNewOrder, _internal } = require("../src/core/delivery/planner");
const { toSvc, fromSvc } = _internal;

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
const ord = (o) => ({ tipo_consegna: "DOMICILIO", estado: "NUEVO", n_pizze: 1, ...o });

// ── §13.1 — #001 multi-stop Q1, andate diverse → forno_out condiviso (I8) ──────
console.log("\n── 1. #001 multi-stop (andate 1 vs 4) ──");
{
  const plan = buildPlan({
    now: "17:00",
    orders: [
      ord({ id: "#001", zona: "Q1", hora: "20:00", andata_min: 1 }),
      ord({ id: "#002", zona: "Q1", hora: "20:00", andata_min: 4 }),
    ],
  });
  const a = plan.orders["#001"], b = plan.orders["#002"];
  check("stesso giro", a.giro_id === b.giro_id, `${a.giro_id} vs ${b.giro_id}`);
  check("forno_out condiviso = partenza (I8)", a.forno_out === b.forno_out, `${a.forno_out} vs ${b.forno_out}`);
  check("forno_out = 19:56 (worst-case tg=4), NON 19:59", a.forno_out === "19:56", a.forno_out);
  check("forno_out === salida per #001", a.forno_out === a.salida, `${a.forno_out}/${a.salida}`);
}

// ── §13.2 — Q5 conflitto reale: window reale + retraso NON assorbito (I9) ──────
console.log("\n── 2. Q5 conflitto/retraso reale ──");
{
  const plan = buildPlan({
    now: "17:00",
    driver: { libero_desde: "20:37" },
    orders: [
      ord({ id: "Q5a", zona: "Q5", hora: "20:35", andata_min: 12 }),
      ord({ id: "Q5b", zona: "Q5", hora: "20:35", andata_min: 13 }),
      ord({ id: "Q5c", zona: "Q5", hora: "20:35", andata_min: 14 }),
    ],
  });
  const trip = plan.trips[0];
  check("un solo giro Q5", plan.trips.length === 1 && trip.zona === "Q5");
  check("delivery_window reale = [20:49, 20:51]",
    JSON.stringify(trip.delivery_window) === JSON.stringify(["20:49", "20:51"]),
    JSON.stringify(trip.delivery_window));
  check("forno_out tutti = partenza 20:37 (I8)",
    plan.orders.Q5a.forno_out === "20:37" && plan.orders.Q5c.forno_out === "20:37");
  check("retraso NON assorbito (tutti conflicto, I9)",
    plan.orders.Q5a.conflicto && plan.orders.Q5b.conflicto && plan.orders.Q5c.conflicto,
    `${plan.orders.Q5a.retraso}/${plan.orders.Q5b.retraso}/${plan.orders.Q5c.retraso}`);
  check("retraso ultimo (andata14) = 6 sulla promessa+slot10", plan.orders.Q5c.retraso === 6, String(plan.orders.Q5c.retraso));
}

// ── §13.3 — manual giro che attraversa due slot ───────────────────────────────
console.log("\n── 3. manual giro a cavallo di due slot ──");
{
  const plan = buildPlan({
    now: "17:00",
    orders: [
      ord({ id: "#001", zona: "Q1", hora: "20:00", andata_min: 4, manual_giro_id: "mg_2" }),
      ord({ id: "#002", zona: "Q1", hora: "20:00", andata_min: 4, manual_giro_id: "mg_2" }),
      ord({ id: "#007", zona: "Q1", hora: "20:30", andata_min: 4, manual_giro_id: "mg_2" }),
    ],
  });
  check("un solo trip (catena manuale)", plan.trips.length === 1, String(plan.trips.length));
  check("count = 3", plan.trips[0].count === 3);
  check("warning spans_slots", plan.trips[0].warnings.includes("spans_slots"), JSON.stringify(plan.trips[0].warnings));
}

// ── §13.4 — No agregable (pizza nuova esce dopo la partenza del giro) ──────────
console.log("\n── 4. No agregable ──");
{
  const snap = {
    now: "17:30",
    orders: [ord({ id: "G1", zona: "Q2", hora: "17:55", andata_min: 6, estado: "EN_COCINA" })],
  };
  const v = evaluateNewOrder(snap, ord({ id: "NEW", zona: "Q2", hora: "18:15", andata_min: 6 }));
  const join = v.options.find(o => o.type === "join_giro");
  check("esiste opzione join sul giro Q2", !!join);
  check("join → blocked + no_agregable", join && join.status === "blocked" && join.no_agregable === true,
    join && `${join.status}/${join.no_agregable}/${join.reason}`);
  check("selected = separata valida 18:15", v.selected && v.selected.type === "separate" && v.selected.hora === "18:15",
    JSON.stringify(v.selected));
}

// ── §13.5 — Usar giro valido + recommended ────────────────────────────────────
console.log("\n── 5. Usar giro valido ──");
{
  const snap = {
    now: "17:30",
    orders: [ord({ id: "G1", zona: "Q2", hora: "17:55", andata_min: 6, estado: "EN_COCINA" })],
  };
  const v = evaluateNewOrder(snap, ord({ id: "NEW", zona: "Q2", hora: "17:53", andata_min: 6 }));
  const join = v.options.find(o => o.type === "join_giro");
  check("join aggregabile (recommended)", join && join.status === "recommended", join && join.status);
  check("recommended valorizzato", !!v.recommended && v.recommended.type === "join_giro", JSON.stringify(v.recommended));
}

// ── §13.6 — Congelamento durante il commit (I5) ───────────────────────────────
console.log("\n── 6. congelamento tra preview e commit ──");
{
  const baseOrder = {
    id: "F1", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1",
    hora: "17:55", andata_min: 6, n_pizze: 1,
    forno_out: "17:49", salida_driver_estimada: "17:49", entrega_estimada: "17:55",
  };
  const early = buildPlan({ now: "17:30", orders: [{ ...baseOrder }] });
  const late = buildPlan({ now: "17:46", orders: [{ ...baseOrder }] });
  check("@17:30 semi-congelato (ricalcolato)", early.orders.F1.freeze === "SEMI_CONGELATO", early.orders.F1.freeze);
  check("@17:46 congelato duro (parete)", late.orders.F1.freeze === "CONGELATO_DURO", late.orders.F1.freeze);
  check("@17:46 forno_out ECHEGGIATO dal committato (I1, non ricalcolato)",
    late.orders.F1.forno_out === "17:49" && late.orders.F1.entrega === "17:55",
    `${late.orders.F1.forno_out}/${late.orders.F1.entrega}`);
}

// ── §13.7 — Rider realmente partito (partito_alle → pavimento) ─────────────────
console.log("\n── 7. rider realmente partito ──");
{
  const plan = buildPlan({
    now: "19:30",
    driver: { libero_desde: "20:10" },
    orders: [ord({ id: "D1", zona: "Q1", hora: "20:00", andata_min: 5 })],
  });
  check("salida = 20:10 (pavimento rider)", plan.orders.D1.salida === "20:10", plan.orders.D1.salida);
  check("forno_out = 20:10 (I8)", plan.orders.D1.forno_out === "20:10", plan.orders.D1.forno_out);
}

// ── §13.8 — Promise slot 10 / anchor leggibile / window reale ──────────────────
console.log("\n── 8. promise slot 10 + anchor ──");
{
  const plan = buildPlan({ now: "17:00", orders: [ord({ id: "P1", zona: "Q1", hora: "20:07", andata_min: 5 })] });
  check("anchor arrotondato a 20:00", plan.trips[0].anchor === "20:00", plan.trips[0].anchor);
  check("delivery_window reale [20:07,20:07]",
    JSON.stringify(plan.trips[0].delivery_window) === JSON.stringify(["20:07", "20:07"]),
    JSON.stringify(plan.trips[0].delivery_window));
}

// ── §13.9 — RITIRO occupa il forno · soft overload (+1 tollerato, niente shift) ─
console.log("\n── 9. ritiro occupa forno (soft overload) ──");
{
  const plan = buildPlan({
    now: "17:00",
    orders: [
      { id: "RIT", tipo_consegna: "RITIRO", estado: "NUEVO", hora: "20:00", n_pizze: 4 },
      ord({ id: "DOM", zona: "Q1", hora: "20:05", andata_min: 5, n_pizze: 1 }),
    ],
  });
  // 4 (ritiro) + 1 (giro) = 5 → soft overload: NIENTE shift, il delivery resta a 20:00.
  check("slot 20:00 = 5 pizze (4 ritiro + 1 giro, soft)", plan.ovenLoad[1200] === 5, String(plan.ovenLoad[1200]));
  check("delivery NON spinto (soft overload) → resta 20:00", plan.orders.DOM.forno_out === "20:00", plan.orders.DOM.forno_out);
  const trip = plan.trips.find(t => t.id.includes("Q1"));
  check("warning forno_soft_overload (non forno_pieno)", trip && trip.warnings.includes("forno_soft_overload") && !trip.warnings.includes("forno_pieno"), trip && JSON.stringify(trip.warnings));
}

// ── §13.10 — After-midnight (edge noto, documentato) ──────────────────────────
console.log("\n── 10. after-midnight (edge documentato) ──");
{
  check("toSvc 00:11 = 1451", toSvc("00:11") === 1451, String(toSvc("00:11")));
  check("fromSvc 1451 = 00:11", fromSvc(1451) === "00:11", fromSvc(1451));
  check("fromSvc niente 24/25", !/^2[45]:/.test(fromSvc(1500)), fromSvc(1500));
  const plan = buildPlan({ now: "23:50", orders: [ord({ id: "N1", zona: "Q5", hora: "00:11", andata_min: 12 })] });
  check("forno_out 23:59 + entrega 00:11 (single-night ok)",
    plan.orders.N1.forno_out === "23:59" && plan.orders.N1.entrega === "00:11",
    `${plan.orders.N1.forno_out}/${plan.orders.N1.entrega}`);
}

// ===============================================================
// CANONICAL ACTIVE TRIP / RIDER BLOCK (Planner W6.5)
// ===============================================================
// Replaces the pre-W6.5 M1..M7 "manual_route" scenarios outright. Those drove
// planner.js Stage M through `snapshot.manual_giros[].{type,order_ids,
// route_order,block_start,manual_duration_min,created_by_operator,force}` —
// seven columns that do not exist in public.manual_giros, `type` among them,
// so the stage's own first filter could never match on real data. They
// certified a machine that could not run. These T-series scenarios certify the
// machine that does: the canonical ACTIVE TRIP from Trip Authority.

// ── T1 — la trip attiva forma UN solo rider block canonico ────────────────────
console.log("\n── T1. active trip -> un solo rider block canonico ──");
{
  const plan = buildPlan({
    now: "19:00",
    active_trip: {
      trip_id: "T1", giro_id: "G1", departed_at_hhmm: "20:00",
      member_order_ids: ["A", "B", "C"],
      outstanding_order_ids: ["A", "B", "C"], completed_order_ids: [],
    },
    orders: [
      ord({ id: "A", zona: "Q1", hora: "20:10", andata_min: 4, estado: "EN_ENTREGA" }),
      ord({ id: "B", zona: "Q2", hora: "20:10", andata_min: 6, estado: "EN_ENTREGA" }),
      ord({ id: "C", zona: "Q5", hora: "20:10", andata_min: 5, estado: "EN_ENTREGA" }),
    ],
  });
  check("un solo rider block", plan.blocks.length === 1, String(plan.blocks.length));
  const blk = plan.blocks[0];
  check("nessun trip separato per zona (solo il block)", plan.trips.length === 1, String(plan.trips.length));
  check("type = active_trip", blk.type === "active_trip", blk.type);
  check("id = TRIP:<trip_id>", blk.id === "TRIP:T1", blk.id);
  check("giro linkato = G1", blk.manual_giro_id === "G1", blk.manual_giro_id);
  check("departure = departed_at REALE (20:00)", blk.departure === "20:00" && blk.block_start === "20:00", blk.departure);
  // occupancy = 2*tg + buffer = 2*6 + 3 = 15 -> 20:15
  check("block_end = modello round-trip nativo (20:15)", blk.block_end === "20:15", blk.block_end);
  check("duration_source = estimated (mai spacciata per un fatto)", blk.duration_source === "estimated", blk.duration_source);
  check("3 zone diverse nello stesso block", JSON.stringify(blk.zones) === JSON.stringify(["Q1", "Q2", "Q5"]), JSON.stringify(blk.zones));
  check("count 3 / members A,B,C (membership congelata)",
    blk.count === 3 && JSON.stringify(blk.members) === JSON.stringify(["A", "B", "C"]));
  check("membership immutabile dichiarata", blk.immutable_membership === true);
  check("salida di ogni membro = partenza reale", ["A", "B", "C"].every(id => plan.orders[id].salida === "20:00"));
}

// ── T2 — il rider block occupa il rider e non e` aggregabile ──────────────────
console.log("\n── T2. rider occupato dalla trip in corso ──");
{
  const snap = {
    now: "19:00",
    active_trip: {
      trip_id: "T2", giro_id: "G2", departed_at_hhmm: "20:00",
      member_order_ids: ["M"], outstanding_order_ids: ["M"], completed_order_ids: [],
    },
    orders: [ord({ id: "M", zona: "Q3", hora: "20:00", andata_min: 5, estado: "EN_ENTREGA" })],
  };
  const v = evaluateNewOrder(snap, ord({ id: "NEW", zona: "Q1", hora: "20:05", andata_min: 5 }));
  const sep = v.options.find(o => o.type === "separate");
  const jb = v.options.find(o => o.type === "join_block");
  check("separata dentro la finestra -> blocked_by_rider_block", sep && sep.blocked_by_rider_block === true, JSON.stringify(sep));
  check("join_block offerto ma BLOCCATO", jb && jb.status === "blocked", JSON.stringify(jb));
  check("nessun override possibile: membership post-partenza immutabile",
    jb && jb.requires_override === false && jb.immutable_membership === true, JSON.stringify(jb));
  check("join_block porta il trip_id canonico", jb && jb.trip_id === "T2", jb && jb.trip_id);
}

// ── T3 — no fabricated ETA for an already-departed stop ──────────────────────
console.log("\n── T3. departed stop: no invented arrival ──");
{
  const plan = buildPlan({
    now: "19:00",
    active_trip: {
      trip_id: "T3", giro_id: null, departed_at_hhmm: "20:00",
      member_order_ids: ["X"], outstanding_order_ids: ["X"], completed_order_ids: [],
    },
    orders: [ord({ id: "X", zona: "Q1", hora: "20:10", andata_min: 4, estado: "EN_ENTREGA", forno_out: "19:55" })],
  });
  const x = plan.orders["X"];
  check("entrega = null (nessuna stima di arrivo inventata)", x.entrega === null, JSON.stringify(x.entrega));
  check("eta_status = UNKNOWN", x.eta_status === "UNKNOWN", x.eta_status);
  check("retraso = null, nessun conflitto dedotto dal nulla", x.retraso === null && x.conflicto === false);
  check("forno_out = the order's own committed fact, not re-planned", x.forno_out === "19:55", x.forno_out);
  check("freeze = DEPARTED", x.freeze === "DEPARTED", x.freeze);
}

// ── T4 — la membership congelata NON si restringe quando uno stop si chiude ───
console.log("\n── T4. completed stop: frozen membership intact ──");
{
  const plan = buildPlan({
    now: "19:00",
    active_trip: {
      trip_id: "T4", giro_id: "G4", departed_at_hhmm: "20:00",
      member_order_ids: ["A", "B"],            // congelata alla partenza
      outstanding_order_ids: ["B"], completed_order_ids: ["A"],
    },
    // A e` RETIRADO: terminale, quindi gia` escluso dallo snapshot planner.
    orders: [ord({ id: "B", zona: "Q2", hora: "20:10", andata_min: 6, estado: "EN_ENTREGA" })],
  });
  const blk = plan.blocks[0];
  check("il block esiste ancora", !!blk);
  check("members = [A,B]: the closed stop does NOT disappear",
    JSON.stringify(blk.members) === JSON.stringify(["A", "B"]), JSON.stringify(blk.members));
  check("stops_total 2 / completed 1 / remaining 1",
    blk.stops_total === 2 && blk.stops_completed === 1 && blk.stops_remaining === 1,
    `${blk.stops_total}/${blk.stops_completed}/${blk.stops_remaining}`);
}

// ── T5 — tutti gli stop completati: membership ancora intatta ─────────────────
console.log("\n── T5. tutti gli stop completati ──");
{
  const plan = buildPlan({
    now: "19:00",
    active_trip: {
      trip_id: "T5", giro_id: "G5", departed_at_hhmm: "20:00",
      member_order_ids: ["A", "B"],
      outstanding_order_ids: [], completed_order_ids: ["A", "B"],
    },
    orders: [],                                 // entrambi terminali -> fuori snapshot
  });
  const blk = plan.blocks[0];
  check("il block esiste anche senza membri nello snapshot", !!blk);
  check("members congelati = [A,B]", blk && JSON.stringify(blk.members) === JSON.stringify(["A", "B"]));
  check("stops_remaining = 0 senza perdere la membership",
    blk && blk.stops_remaining === 0 && blk.stops_total === 2);
  check("il rider resta occupato finche` la trip non chiude", blk && blk.block_end >= blk.block_start);
}

// ── T6 — automatic giro NON rotto dal nuovo codice (regressione) ──────────────
console.log("\n── T6. automatic giro intatto (nessuna trip attiva) ──");
{
  const plan = buildPlan({
    now: "17:00",
    orders: [
      ord({ id: "#001", zona: "Q1", hora: "20:00", andata_min: 1 }),
      ord({ id: "#002", zona: "Q1", hora: "20:00", andata_min: 4 }),
    ],
  });
  check("nessun block creato", plan.blocks.length === 0);
  check("trip automatico con type=automatic", plan.trips.length === 1 && plan.trips[0].type === "automatic", JSON.stringify(plan.trips.map(t => t.type)));
  check("forno_out condiviso 19:56 (I8 invariato)", plan.orders["#001"].forno_out === "19:56" && plan.orders["#002"].forno_out === "19:56");
}

// ── T7 — invariante rider: block + auto trip non si sovrappongono ─────────────
console.log("\n── T7. invariante rider: nessun block/trip sovrapposto ──");
{
  const plan = buildPlan({
    now: "19:00",
    active_trip: {
      trip_id: "T7", giro_id: "G7", departed_at_hhmm: "20:00",
      member_order_ids: ["R"], outstanding_order_ids: ["R"], completed_order_ids: [],
    },
    orders: [
      ord({ id: "R", zona: "Q1", hora: "20:00", andata_min: 5, estado: "EN_ENTREGA" }),
      ord({ id: "S", zona: "Q5", hora: "20:05", andata_min: 10 }), // automatico → DOPO il block
    ],
  });
  check("nessun overlap rider (block ∩ trip)", plan.rider_overlaps.length === 0, JSON.stringify(plan.rider_overlaps));
  const auto = plan.trips.find(t => t.type === "automatic");
  // occupancy = 2*5 + 3 = 13 -> block_end 20:13
  check("trip automatico parte ≥ block_end (20:13)", auto && auto.departure >= "20:13", auto && auto.departure);
}

// ── T8 — fatti trip non affidabili: DEGRADED esplicito, mai rider libero ──────
console.log("\n── T8. trip facts unavailable -> DEGRADED esplicito ──");
{
  const plan = buildPlan({
    now: "19:00",
    active_trip_unavailable: true,
    active_trip_unavailable_reason: "SCOPE_UNAVAILABLE",
    orders: [ord({ id: "Z", zona: "Q1", hora: "20:00", andata_min: 5 })],
  });
  check("nessun block inventato", plan.blocks.length === 0);
  check("warning esplicito sulla timeline rider non fiabile",
    plan.warnings.some(w => /trip facts no disponibles/.test(w) && /SCOPE_UNAVAILABLE/.test(w)),
    JSON.stringify(plan.warnings));
}

// ── T9 — l'input legacy manual_giros non puo` piu` creare alcun block ─────────
console.log("\n── T9. manual_giros legacy: input morto, nessun effetto ──");
{
  const plan = buildPlan({
    now: "19:00",
    // Esattamente la forma che lo Stage M pre-W6.5 consumava. Sette di queste
    // colonne non esistono in public.manual_giros: qui non deve produrre nulla.
    manual_giros: [{
      id: "mg1", type: "manual_route", order_ids: ["A"], route_order: ["A"],
      block_start: "20:00", manual_duration_min: 15, created_by_operator: true, force: true,
    }],
    orders: [ord({ id: "A", zona: "Q1", hora: "20:10", andata_min: 4 })],
  });
  check("nessun block da manual_giros", plan.blocks.length === 0, String(plan.blocks.length));
  check("the order stays in normal automatic bucketing",
    plan.trips.length === 1 && plan.trips[0].type === "automatic", JSON.stringify(plan.trips.map(t => t.type)));
  check("nessun trip di tipo manual_route esiste piu`",
    !plan.trips.some(t => t.type === "manual_route"));
}
// ── Risultato ─────────────────────────────────────────────────────────────────
console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
