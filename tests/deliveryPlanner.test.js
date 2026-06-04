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
// MANUAL MULTI-ZONE ROUTE / RIDER BLOCK (spec §Manual route)
// ===============================================================

// ── M1 — manual route multi-zona base: un solo rider block ────────────────────
console.log("\n── M1. manual route multi-zona (Q1/Q2/Q5, durata 15) ──");
{
  const plan = buildPlan({
    now: "19:00",
    manual_giros: [{
      id: "mg1", type: "manual_route",
      order_ids: ["A", "B", "C"], route_order: ["A", "B", "C"],
      block_start: "20:00", manual_duration_min: 15,
      created_by_operator: true, force: true,
    }],
    orders: [
      ord({ id: "A", zona: "Q1", hora: "20:10", andata_min: 4 }),
      ord({ id: "B", zona: "Q2", hora: "20:10", andata_min: 8 }),
      ord({ id: "C", zona: "Q5", hora: "20:10", andata_min: 12 }),
    ],
  });
  check("un solo rider block", plan.blocks.length === 1, String(plan.blocks.length));
  const blk = plan.blocks[0];
  check("nessun trip separato per zona (solo il block)", plan.trips.length === 1, String(plan.trips.length));
  check("type = manual_route", blk.type === "manual_route", blk.type);
  check("block_start coerente = 20:00", blk.block_start === "20:00", blk.block_start);
  check("block_end = start + 15 = 20:15", blk.block_end === "20:15", blk.block_end);
  check("durata da manuale (duration_source=manual)", blk.duration_source === "manual" && blk.duration_min === 15);
  check("3 zone diverse nello stesso block", JSON.stringify(blk.zones) === JSON.stringify(["Q1", "Q2", "Q5"]), JSON.stringify(blk.zones));
  check("count 3 / members A,B,C", blk.count === 3 && JSON.stringify(blk.members) === JSON.stringify(["A", "B", "C"]));
  check("tutte le pizze escono a block_start (I8)",
    plan.orders.A.forno_out === "20:00" && plan.orders.B.forno_out === "20:00" && plan.orders.C.forno_out === "20:00");
  check("rider timeline occupata = nessun overlap interno", plan.rider_overlaps.length === 0);
}

// ── M2 — il rider block impedisce nuovi delivery dentro la finestra ───────────
console.log("\n── M2. block 20:00–20:15 blocca nuovo delivery a 20:05 ──");
{
  const snap = {
    now: "19:00",
    manual_giros: [{ id: "mgB", type: "manual_route", order_ids: ["M"], block_start: "20:00", manual_duration_min: 15, force: true }],
    orders: [ord({ id: "M", zona: "Q3", hora: "20:00", andata_min: 5 })],
  };
  const v = evaluateNewOrder(snap, ord({ id: "NEW", zona: "Q1", hora: "20:05", andata_min: 5 }));
  const sep = v.options.find(o => o.type === "separate");
  const jb = v.options.find(o => o.type === "join_block");
  check("separata NON dentro il block → marcata blocked_by_rider_block", sep && sep.blocked_by_rider_block === true, JSON.stringify(sep));
  check("separata spinta a salida ≥ block_end (20:15)", sep && sep.salida === "20:15", sep && sep.salida);
  check("join nel block solo con override esplicito", jb && jb.requires_override === true && jb.status === "blocked", JSON.stringify(jb));
}

// ── M3 — ordine non pronto dentro il block ────────────────────────────────────
console.log("\n── M3. ordine con forno_out dopo block_start ──");
{
  const plan = buildPlan({
    now: "19:00",
    manual_giros: [{ id: "mg3", type: "manual_route", order_ids: ["X", "Y"], block_start: "20:00", manual_duration_min: 15 }],
    orders: [
      ord({ id: "X", zona: "Q1", hora: "20:10", andata_min: 4 }),
      ord({ id: "Y", zona: "Q2", hora: "20:10", andata_min: 6, estado: "EN_COCINA", forno_out: "20:05" }),
    ],
  });
  const blk = plan.blocks[0];
  check("block NON coerente", blk.coherent === false, String(blk.coherent));
  check("status ≠ coherent (force_required / needs_decision)", blk.status === "needs_decision", blk.status);
  check("issue pizza_not_ready su Y", blk.issues.some(i => i.order === "Y" && i.type === "pizza_not_ready"), JSON.stringify(blk.issues));
  check("warning pizza_not_ready sull'ordine (non silenzioso)", plan.orders.Y.reasons.includes("pizza_not_ready"), JSON.stringify(plan.orders.Y.reasons));
}

// ── M4 — cliente fuori slot dentro il block (retraso sulla promessa, I9) ──────
console.log("\n── M4. consegna interna oltre la granularità promessa ──");
{
  const plan = buildPlan({
    now: "19:00",
    manual_giros: [{ id: "mg4", type: "manual_route", order_ids: ["Z"], block_start: "20:00", manual_duration_min: 30 }],
    orders: [ord({ id: "Z", zona: "Q1", hora: "20:00", andata_min: 10 })],
  });
  const blk = plan.blocks[0];
  // buffer ops driver = 3 (default): est.total = 10+3 = 13, scale = 30/13 → arrivo +23.
  check("entrega 20:23 (block lungo, buffer 3)", plan.orders.Z.entrega === "20:23", plan.orders.Z.entrega);
  check("retraso = 13 su promessa+slot (NON sulla window)", plan.orders.Z.retraso === 13, String(plan.orders.Z.retraso));
  check("issue cliente_fuera_slot (non nascosto dalla window)", blk.issues.some(i => i.type === "cliente_fuera_slot"), JSON.stringify(blk.issues));
  check("block segnalato incoerente", blk.coherent === false);
}

// ── M5 — modifica ordine dentro il block: hora +30 → block incoerente ─────────
console.log("\n── M5. ordine nel block cambia hora +30 ──");
{
  const plan = buildPlan({
    now: "19:00",
    manual_giros: [{ id: "mg5", type: "manual_route", order_ids: ["P", "Q"], block_start: "20:00", manual_duration_min: 15 }],
    orders: [
      ord({ id: "P", zona: "Q1", hora: "20:10", andata_min: 4 }),
      ord({ id: "Q", zona: "Q2", hora: "20:40", andata_min: 8 }), // promessa spostata +30
    ],
  });
  const blk = plan.blocks[0];
  check("block incoerente", blk.coherent === false, String(blk.coherent));
  check("issue orden_desfasada su Q", blk.issues.some(i => i.order === "Q" && i.type === "orden_desfasada"), JSON.stringify(blk.issues));
  const acts = blk.options.map(o => o.action);
  check("propone quitar/mover/forzar/preguntar",
    ["quitar_orden", "mover_bloque", "mantener_forzado", "preguntar_operador"].every(a => acts.includes(a)), JSON.stringify(acts));
  check("timeline non sporca (nessun overlap)", plan.rider_overlaps.length === 0);
}

// ── M6 — automatic giro NON rotto dal nuovo codice (regressione) ──────────────
console.log("\n── M6. automatic giro intatto (no manual_giros) ──");
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

// ── M7 — invariante rider: block + auto trip non si sovrappongono ─────────────
console.log("\n── M7. invariante rider: nessun block/trip sovrapposto ──");
{
  const plan = buildPlan({
    now: "19:00",
    manual_giros: [{ id: "mg7", type: "manual_route", order_ids: ["R"], block_start: "20:00", manual_duration_min: 20 }],
    orders: [
      ord({ id: "R", zona: "Q1", hora: "20:00", andata_min: 5 }),
      ord({ id: "S", zona: "Q5", hora: "20:05", andata_min: 10 }), // automatico → deve cadere DOPO il block
    ],
  });
  check("nessun overlap rider (block ∩ trip)", plan.rider_overlaps.length === 0, JSON.stringify(plan.rider_overlaps));
  const auto = plan.trips.find(t => t.type === "automatic");
  check("trip automatico parte ≥ block_end (20:20)", auto && auto.departure >= "20:20", auto && auto.departure);
}

// ── Risultato ─────────────────────────────────────────────────────────────────
console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
