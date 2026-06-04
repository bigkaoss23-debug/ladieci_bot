// tests/deliveryPlannerMultiSnapshotAB.test.js
// ===============================================================
// SUPER STRESS A/B — multi-snapshot reale (4 serate consecutive 28→31 mag 2026)
// Run: node tests/deliveryPlannerMultiSnapshotAB.test.js
// ===============================================================
// Planner PURO isolato. Fixture STATICHE (nessuna query live, nessuna scrittura).
//   VECCHIO: forno_out reale persistito (backup) + driver fields RICOSTRUITI (zones.js).
//   NUOVO:   buildPlan(snapshot) rev.5.
// Replay: ordini archiviati (RETIRADO) ripianificati come fatti grezzi (MOVIBILE), now 19:00.
// Asserisce INVARIANTI universali che devono valere su OGNI serata reale.
// ===============================================================
"use strict";
const { buildPlan, _internal } = require("../src/core/delivery/planner");
const { computeDriverFields } = require("../src/utils/zones");
const { toSvc, slotStart } = _internal;

const SNAPSHOTS = ["20260528", "20260529", "20260530", "20260531"]
  .map(d => require("./fixtures/deliveryPlannerRealSnapshot" + d));

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`    ✓ ${label}`); }
  else { fail++; console.log(`    ✗ ${label} ${extra}`); }
}
const KNOWN_WARNINGS = new Set(["spans_slots", "giro_overflow", "forno_soft_overload", "forno_overload_serio", "forno_pieno"]);

let totOrd = 0, totDom = 0, totRit = 0, totMatch = 0, totDiff = 0;
const zonesAll = new Set();

for (const fx of SNAPSHOTS) {
  console.log(`\n══════ ${fx.fecha} ══════`);
  const orders = fx.orders.map(o => ({
    id: o.id, tipo_consegna: o.tipo_consegna, estado: "NUEVO",
    zona: o.zona, hora: o.hora, andata_min: o.andata_min,
    durata_andata_min: o.andata_min, n_pizze: o.n_pizze,
  }));
  const plan = buildPlan({ now: "19:00", orders });
  const dfOld = computeDriverFields(orders);
  const dom = fx.orders.filter(o => o.tipo_consegna === "DOMICILIO");
  const rit = fx.orders.filter(o => o.tipo_consegna === "RITIRO");
  totOrd += fx.orders.length; totDom += dom.length; totRit += rit.length;
  dom.forEach(o => zonesAll.add(o.zona));
  const autoTrips = plan.trips.filter(t => t.type === "automatic");

  // ── A/B forno_out reale vs nuovo (baseline solo per confronto, mai input) ──────
  let match = 0, diff = 0;
  for (const o of dom) {
    const n = plan.orders[o.id];
    if (n.forno_out === o.forno_out_db) match++; else {
      diff++;
      const oldRet = dfOld.get(o.id)?.retraso_estimado_min ?? "—";
      console.log(`    Δ ${o.id} ${o.zona} hora ${o.hora}: DB ${o.forno_out_db} → NEW ${n.forno_out} (retraso NEW ${n.retraso}, OLD ricostr ${oldRet}) ${n.reasons.join("; ") || ""}`);
    }
  }
  totMatch += match; totDiff += diff;
  console.log(`    forno_out: ${match} match · ${diff} diff su ${dom.length} domicilio · trips ${autoTrips.length} · overlaps ${plan.rider_overlaps.length}`);

  // ── INVARIANTI universali (devono PASSARE) ────────────────────────────────────
  // 1. forno_out formato valido, niente 24/25, niente clamp impossibile.
  const badFmt = Object.values(plan.orders).filter(n => n.forno_out && (!/^\d\d:\d\d$/.test(n.forno_out) || /^(24|25):/.test(n.forno_out)));
  check("1· forno_out sempre valido (no 24:/25:, no clamp falso)", badFmt.length === 0, JSON.stringify(badFmt.map(x => x.id + ":" + x.forno_out)));

  // 2. rider non parte prima della pizza: salida >= forno_out.
  const badSal = dom.filter(o => { const n = plan.orders[o.id]; return n.salida < n.forno_out; });
  check("2· salida ≥ forno_out per ogni domicilio (rider non parte prima della pizza)", badSal.length === 0, JSON.stringify(badSal.map(x => x.id)));

  // 3. entrega = forno_out + andata (coerenza temporale).
  const badEnt = dom.filter(o => { const n = plan.orders[o.id]; return (toSvc(n.entrega) - toSvc(n.forno_out)) !== (Number(o.andata_min) || 0); });
  check("3· entrega − forno_out == andata (coerenza)", badEnt.length === 0, JSON.stringify(badEnt.map(x => x.id)));

  // 4. nessun rider overlap su tutta la serata.
  check("4· nessun rider overlap (timeline pulita)", plan.rider_overlaps.length === 0, JSON.stringify(plan.rider_overlaps));

  // 5. retraso sulla promessa+slot10: conflicto === retraso>0 (niente window finta).
  const badConf = dom.filter(o => { const n = plan.orders[o.id]; return n.conflicto !== (n.retraso > 0); });
  check("5· conflicto === retraso>0 (promessa+slot, no window cosmetica)", badConf.length === 0, JSON.stringify(badConf.map(x => x.id)));

  // 6. cluster reale stessa (zona,hora) → forno_out e giro condivisi (I8).
  const groups = {};
  for (const o of dom) { const k = `${o.zona}|${o.hora}`; (groups[k] ||= []).push(o.id); }
  let clusterBad = 0, clusters = 0;
  for (const k in groups) {
    if (groups[k].length < 2) continue;
    clusters++;
    const fos = groups[k].map(id => plan.orders[id].forno_out);
    const giros = groups[k].map(id => plan.orders[id].giro_id);
    if (!(fos.every(x => x === fos[0]) && giros.every(g => g === giros[0]))) clusterBad++;
  }
  check(`6· cluster stessa zona/hora condividono forno_out+giro (I8) [${clusters} cluster]`, clusterBad === 0);

  // 7. delivery_window = [min,max] reali delle entregas del giro.
  let winBad = 0;
  for (const t of autoTrips) {
    const ent = t.members.map(id => toSvc(plan.orders[id].entrega));
    if (toSvc(t.delivery_window[0]) !== Math.min(...ent) || toSvc(t.delivery_window[1]) !== Math.max(...ent)) winBad++;
  }
  check("7· delivery_window = [min,max] entregas reali (no scatola finta)", winBad === 0);

  // 8. soft oven overload: trip senza forno_pieno ⇒ carico slot ≤ 7 (serio); soft ⇒ ≥5.
  let a8 = 0;
  for (const t of autoTrips) {
    const slot = slotStart(toSvc(t.departure), plan.config.forno.slotMin);
    const load = plan.ovenLoad[slot] || 0;
    if (!t.warnings.includes("forno_pieno") && load > 7) a8++;                     // hard non flaggato
    if (t.warnings.includes("forno_soft_overload") && load < 5) a8++;             // soft senza overload
  }
  check("8· soft/hard overload coerente (≤7 senza shift; soft ⇒ carico ≥5)", a8 === 0, String(a8));

  // 9. ogni warning di trip è un token noto e spiegabile.
  const unknown = [];
  for (const t of autoTrips) for (const w of t.warnings) if (!KNOWN_WARNINGS.has(w)) unknown.push(w);
  check("9· tutti i warning sono token noti/spiegabili", unknown.length === 0, JSON.stringify(unknown));

  // 10. ritiri occupano forno: sum(ovenLoad) == sum(n_pizze di tutti gli ordini schedulati).
  const ovenTot = Object.values(plan.ovenLoad).reduce((s, v) => s + v, 0);
  const pizzeTot = fx.orders.reduce((s, o) => s + (Number(o.n_pizze) || 0), 0);
  check("10· ritiri occupano forno: Σ ovenLoad == Σ pizze (domicilio+ritiro)", ovenTot === pizzeTot, `${ovenTot} vs ${pizzeTot}`);
}

console.log(`\n══════ TOTALI ══════`);
console.log(`  serate: ${SNAPSHOTS.length} · ordini: ${totOrd} · domicilio: ${totDom} · ritiro: ${totRit} · zone: ${[...zonesAll].sort().join(",")}`);
console.log(`  forno_out vs DB: ${totMatch} match · ${totDiff} diff (diff attese da nuove regole: capacità forno, buffer 3, single-rider)`);
console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
