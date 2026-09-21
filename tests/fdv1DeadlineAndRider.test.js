// tests/fdv1DeadlineAndRider.test.js — [FDV1 LIVE] points 1–3 of the pre-DDL review, on the REAL agentOrdini:
//   1. cambiaStato EN_ENTREGA / RETIRADO no longer writes DRIVER_STATO (config) nor delivery_logs (rider hook off by default);
//   2. `hora` (client promise) and `delivery_deadline_at` are two separate data;
//   3. EVERY new DOMICILIO (dashboard AND WhatsApp bot) gets delivery_deadline_at = ts + 55' in the SAME insert, one timestamp.
// Stub pattern of createOrdenAuthoritative.test.js (supabase + geoResolver + manualGiros via require.cache).
delete process.env.FDV1_RIDER_TELEMETRY;

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;
let INSERTED = [], UPDATED = [], UPSERTS = [], OTHER_INSERTS = [];
let STORE = {};
supa.sbSelect = async (table, query = "") => {
  if (table === "ordenes") {
    const mReq = query.match(/client_req_id=eq\.([^&]+)/);
    if (mReq) { const k = decodeURIComponent(mReq[1]); return Object.values(STORE).filter((o) => o.client_req_id === k).map((o) => ({ id: o.id })); }
    const mId = query.match(/(?:^|&)id=eq\.([^&]+)/);
    if (mId) { const id = decodeURIComponent(mId[1]); return STORE[id] ? [{ ...STORE[id] }] : []; }
    return [];
  }
  return [];
};
supa.sbInsert = async (table, row) => {
  if (table === "ordenes") { INSERTED.push(row); STORE[row.id] = { ...row }; return [row]; }
  OTHER_INSERTS.push({ table, row }); return [row];
};
supa.sbUpdate = async (table, filter, patch) => {
  if (table === "ordenes") { UPDATED.push({ filter, patch }); const m = filter.match(/id=eq\.([^&]+)/); if (m && STORE[decodeURIComponent(m[1])]) Object.assign(STORE[decodeURIComponent(m[1])], patch); }
  return "";
};
supa.sbUpsert = async (table, row) => { UPSERTS.push({ table, row }); return ""; };

const geoPath = require.resolve("../src/utils/geoResolver");
require(geoPath);
require.cache[geoPath].exports.risolviIndirizzo = async () => ({ zona: "Q1", lat: 36.77, lon: -2.60, durataAndataMin: 8, googleMin: 8, haversineMin: 9, source: "google", cached: true, fuoriZona: false, error: null });
const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];

const { creaOrdine, cambiaStato } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => { if (cond) { console.log("  ok  " + name); passed++; } else { console.log("  FAIL " + name + (detail ? " — " + detail : "")); failed++; } };
const reset = () => { INSERTED = []; UPDATED = []; UPSERTS = []; OTHER_INSERTS = []; STORE = {}; };
const item = [{ n: "Margherita", p: 12, q: 1 }];

(async () => {
  console.log("fdv1DeadlineAndRider.test.js");

  // ── 2 + 3: dashboard DOMICILIO ─────────────────────────────────────────
  reset();
  let r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: "22:10", items: item, client_req_id: "req-dash-1" });
  let row = INSERTED[0];
  ok("dashboard DOMICILIO: insert ok", r && r.success && row, JSON.stringify(r));
  ok("dashboard DOMICILIO: delivery_deadline_at = ts + 55' (same insert, same timestamp)", row && row.delivery_deadline_at === new Date(row.ts + 55 * 60000).toISOString(), row && `${row.ts} ${row.delivery_deadline_at}`);
  ok("dashboard DOMICILIO: hora = client promise 22:10, NOT the deadline mirror", row && row.hora === "22:10");
  ok("dashboard DOMICILIO: no post-insert patch of hora/deadline", !UPDATED.some((u) => "hora" in u.patch || "delivery_deadline_at" in u.patch));

  // replay (same client_req_id) → idempotent, no second insert, no new deadline
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: "22:10", items: item, client_req_id: "req-dash-1" });
  ok("replay same client_req_id: idempotent, one insert, deadline unchanged", r && r.idempotent === true && INSERTED.length === 1);

  // ── 3: WhatsApp bot DOMICILIO (operatorManual falsy) ───────────────────
  reset();
  r = await creaOrdine({ canal: "WA", waId: "34600000000", nombre: "Bot", tipo_consegna: "DOMICILIO", direccion: "Reino 1", zona: "Q1", hora: "21:30", items: item, forno_out: "21:20" });
  row = INSERTED[0];
  ok("WhatsApp DOMICILIO: delivery_deadline_at = ts + 55'", row && row.delivery_deadline_at === new Date(row.ts + 55 * 60000).toISOString(), JSON.stringify(r));
  ok("WhatsApp DOMICILIO: hora stays the bot promise 21:30", row && row.hora === "21:30");

  // ── RITIRO: no delivery deadline ───────────────────────────────────────
  reset();
  await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "R", tipo_consegna: "RITIRO", hora: "21:00", items: item });
  ok("RITIRO: delivery_deadline_at null, hora untouched", INSERTED[0] && INSERTED[0].delivery_deadline_at === null && INSERTED[0].hora === "21:00");

  // ── 1: rider hook off ──────────────────────────────────────────────────
  for (const [from, to] of [["LISTO", "EN_ENTREGA"], ["EN_ENTREGA", "RETIRADO"]]) {
    reset();
    STORE["#900"] = { id: "#900", tipo_consegna: "DOMICILIO", estado: from, zona: "Q1", manual_giro_id: null, hora: "21:00", delivery_deadline_at: "2026-09-21T19:00:00.000Z", ts: 1 };
    const res = await cambiaStato("#900", to, { actor_type: "operator", origin: "test" });
    ok(`cambiaStato ${from}→${to}: state written`, res && res.success && STORE["#900"].estado === to, JSON.stringify(res));
    ok(`cambiaStato ${from}→${to}: NO DRIVER_STATO write`, !UPSERTS.some((u) => u.table === "config"), JSON.stringify(UPSERTS));
    ok(`cambiaStato ${from}→${to}: NO delivery_logs insert`, !OTHER_INSERTS.some((u) => u.table === "delivery_logs"));
    ok(`cambiaStato ${from}→${to}: hora and delivery_deadline_at untouched`, STORE["#900"].hora === "21:00" && STORE["#900"].delivery_deadline_at === "2026-09-21T19:00:00.000Z");
  }

  console.log(`\n== fdv1DeadlineAndRider: ${passed} pass / ${failed} fail`);
  if (failed) process.exitCode = 1;
})();
