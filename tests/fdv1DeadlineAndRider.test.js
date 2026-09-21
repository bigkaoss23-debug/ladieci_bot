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
let FAIL_INSERTS = 0;          // n. of next ordenes INSERTs answered with a PK collision (23505) → creaOrdine retries
let ATTEMPTS = [];
supa.sbInsert = async (table, row) => {
  if (table === "ordenes") {
    ATTEMPTS.push({ ...row });
    if (FAIL_INSERTS > 0) { FAIL_INSERTS--; await new Promise((r) => setTimeout(r, 15)); return { code: "23505", details: "Key (id)=(" + row.id + ") already exists." }; }
    INSERTED.push(row); STORE[row.id] = { ...row }; return [row];
  }
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

const { creaOrdine, cambiaStato, modificaOrdine } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => { if (cond) { console.log("  ok  " + name); passed++; } else { console.log("  FAIL " + name + (detail ? " — " + detail : "")); failed++; } };
const reset = () => { INSERTED = []; UPDATED = []; UPSERTS = []; OTHER_INSERTS = []; STORE = {}; FAIL_INSERTS = 0; ATTEMPTS = []; };
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


  // ── createdMs generated ONCE, reused across INSERT retries ───────────────
  reset(); FAIL_INSERTS = 2;
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: "22:10", items: item, client_req_id: "req-retry" });
  ok("INSERT retried after 2 PK collisions (3 attempts)", ATTEMPTS.length === 3 && r.success, `${ATTEMPTS.length} ${JSON.stringify(r)}`);
  ok("same ts on every attempt (createdMs not regenerated)", new Set(ATTEMPTS.map((a) => a.ts)).size === 1);
  ok("same delivery_deadline_at on every attempt = ts + 55'", new Set(ATTEMPTS.map((a) => a.delivery_deadline_at)).size === 1 && ATTEMPTS[0].delivery_deadline_at === new Date(ATTEMPTS[0].ts + 55 * 60000).toISOString());
  ok("state timestamps derive from the same instant (updated_at = ts on every attempt)", ATTEMPTS.every((a) => Date.parse(a.updated_at) === a.ts));
  reset(); FAIL_INSERTS = 1;
  await creaOrdine({ canal: "WA", waId: "34600000001", nombre: "Bot", tipo_consegna: "DOMICILIO", direccion: "Reino 1", zona: "Q1", hora: "21:30", items: item, forno_out: "21:20", estado: "EN_COCINA" });
  ok("WhatsApp EN_COCINA with a retry: en_cocina_at = confirmado_at = ts, deadline = ts + 55' on both attempts",
    ATTEMPTS.length === 2 && ATTEMPTS.every((a) => Date.parse(a.en_cocina_at) === a.ts && Date.parse(a.confirmado_at) === a.ts && a.delivery_deadline_at === new Date(a.ts + 55 * 60000).toISOString()) && ATTEMPTS[0].ts === ATTEMPTS[1].ts,
    JSON.stringify(ATTEMPTS.map((a) => [a.ts, a.en_cocina_at, a.confirmado_at])));

  // twin request raced us: client_req_id collision on INSERT → existing id, no second order
  reset();
  STORE["#050"] = { id: "#050", client_req_id: "req-twin", tipo_consegna: "DOMICILIO", ts: 1, delivery_deadline_at: new Date(1 + 55 * 60000).toISOString() };
  const origSelect = supa.sbSelect; let firstLookup = true;
  supa.sbSelect = async (t, q) => { if (t === "ordenes" && /client_req_id=eq/.test(q) && firstLookup) { firstLookup = false; return []; } return origSelect(t, q); };
  supa.sbInsert = ((orig) => async (t, row) => (t === "ordenes" ? { code: "23505", details: "Key (client_req_id)=(req-twin) already exists." } : orig(t, row)))(supa.sbInsert);
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: "22:10", items: item, client_req_id: "req-twin" });
  ok("client_req_id collision on INSERT → existing order returned, no second order / deadline", r && r.idempotent === true && r.id === "#050" && Object.keys(STORE).length === 1, JSON.stringify(r));
  supa.sbSelect = origSelect;
  supa.sbInsert = async (table, row) => {
    if (table === "ordenes") { ATTEMPTS.push({ ...row }); if (FAIL_INSERTS > 0) { FAIL_INSERTS--; return { code: "23505", details: "Key (id) exists" }; } INSERTED.push(row); STORE[row.id] = { ...row }; return [row]; }
    OTHER_INSERTS.push({ table, row }); return [row];
  };

  // ── A–F: tipo conversions and edits (modificaOrdine, dashboard path) ─────
  const TS = Date.parse("2026-09-21T18:00:00Z");
  const DL = new Date(TS + 55 * 60000).toISOString();
  const base = (extra) => ({ id: "#700", tipo_consegna: "RITIRO", estado: "EN_COCINA", hora: "21:30", ts: TS, delivery_deadline_at: null,
    items: item, nombre: "X", canal: "MANUAL", direccion: null, zona: null, forzado: false, ...extra });
  const mod = async (u) => modificaOrdine("#700", { ...u, operatorManual: true });

  reset();
  await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "R", tipo_consegna: "RITIRO", hora: "21:00", items: item });
  ok("A new RITIRO: delivery_deadline_at NULL", INSERTED[0].delivery_deadline_at === null);

  reset(); STORE["#700"] = base();
  r = await mod({ tipo_consegna: "DOMICILIO", direccion: "Reino 1" });
  ok("B RITIRO → DOMICILIO: deadline = ORIGINAL ts + 55' (not now + 55')", r.success && STORE["#700"].delivery_deadline_at === DL, `${JSON.stringify(r)} ${STORE["#700"].delivery_deadline_at}`);
  ok("B hora untouched by the conversion", STORE["#700"].hora === "21:30");

  r = await mod({ tipo_consegna: "RITIRO", direccion: "" });
  ok("C DOMICILIO → RITIRO: deadline NULL (not operative)", r.success && STORE["#700"].delivery_deadline_at === null, String(STORE["#700"].delivery_deadline_at));

  r = await mod({ tipo_consegna: "DOMICILIO", direccion: "Reino 1" });
  ok("D DOMICILIO → RITIRO → DOMICILIO: deadline rebuilt deterministically = original ts + 55'", STORE["#700"].delivery_deadline_at === DL);

  UPDATED = [];
  r = await mod({ hora: "22:45" });
  ok("E hora edit: hora changes, delivery_deadline_at unchanged and not written", STORE["#700"].hora === "22:45" && STORE["#700"].delivery_deadline_at === DL && !UPDATED.some((u) => "delivery_deadline_at" in u.patch), JSON.stringify(UPDATED));

  UPDATED = [];
  r = await mod({ direccion: "Playa 3", zona: "Q5", zona_manuale: true });
  ok("F address / zone edit: delivery_deadline_at unchanged and not written", STORE["#700"].delivery_deadline_at === DL && !UPDATED.some((u) => "delivery_deadline_at" in u.patch));

  UPDATED = [];
  r = await mod({ tipo_consegna: "DOMICILIO" });
  ok("same tipo re-sent (DOMICILIO → DOMICILIO): deadline not rewritten", STORE["#700"].delivery_deadline_at === DL && !UPDATED.some((u) => "delivery_deadline_at" in u.patch));

  UPDATED = [];
  r = await mod({ delivery_deadline_at: "2030-01-01T00:00:00.000Z", nota: "x" });
  ok("a client can never set delivery_deadline_at through modificaOrdine", STORE["#700"].delivery_deadline_at === DL);

  reset();
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: "22:10", items: item, delivery_deadline_at: "2030-01-01T00:00:00.000Z" });
  ok("a client can never set delivery_deadline_at through creaOrdine", INSERTED[0].delivery_deadline_at === new Date(INSERTED[0].ts + 55 * 60000).toISOString());

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
