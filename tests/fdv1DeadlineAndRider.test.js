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
const { applyPatch } = require("./helpers/postgrestPatch");
supa.sbUpdate = async (table, filter, patch, prefer) => {
  // [PAYMENT-IDEMPOTENCY] la finalizzazione è un UPDATE condizionato: filtri + return=representation.
  if (table === "ordenes" && prefer) { UPDATED.push({ filter, patch }); return applyPatch(STORE, filter, patch, prefer); }
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
const { legacyDeadlineFromHora, formatMadridHHMM } = require("../src/core/delivery/deadline");

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => { if (cond) { console.log("  ok  " + name); passed++; } else { console.log("  FAIL " + name + (detail ? " — " + detail : "")); failed++; } };
const reset = () => { INSERTED = []; UPDATED = []; UPSERTS = []; OTHER_INSERTS = []; STORE = {}; FAIL_INSERTS = 0; ATTEMPTS = []; };
const item = [{ n: "Margherita", p: 12, q: 1 }];

// ── [DEADLINE-HORA 2026-09-22] ──────────────────────────────────────────────
// Il contratto riscritto QUI, indipendentemente dalla funzione sotto test:
//     deadline = max(ts + 55', istante assoluto della `hora` persistita)
// Non chiamiamo effectiveDeadline (sarebbe tautologico): la formula è ripetuta a
// mano. `legacyDeadlineFromHora` è la sola parte condivisa, e ha 33 unit test
// dedicati in tests/effectiveDeadline.test.js.
const FLOOR_MIN = 55;
const expectedDeadline = (row) => {
  const floor = row.ts + FLOOR_MIN * 60000;
  const promised = legacyDeadlineFromHora(row.hora, row.ts);
  return new Date(Number.isFinite(promised) && promised > floor ? promised : floor).toISOString();
};
// Orari deterministici RELATIVI all'istante del test: le vecchie hora costanti
// ("22:10") rendevano l'esito dipendente dall'ora in cui si lanciava la suite.
const horaTraMinuti = (min) => formatMadridHHMM(Date.now() + min * 60000);

(async () => {
  console.log("fdv1DeadlineAndRider.test.js");

  // ── 2 + 3: dashboard DOMICILIO ASAP (hora entro il pavimento) ──────────
  // Il 90,8% del traffico reale sta qui (mediana hora−ts = 32'): il
  // comportamento DEVE restare identico a prima della patch.
  reset();
  const horaAsap = horaTraMinuti(20);
  let r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: horaAsap, items: item, client_req_id: "req-dash-1" });
  let row = INSERTED[0];
  ok("dashboard DOMICILIO ASAP: insert ok", r && r.success && row, JSON.stringify(r));
  ok("dashboard DOMICILIO ASAP (hora a +20'): delivery_deadline_at = ts + 55' — INVARIATO dalla patch",
    row && row.delivery_deadline_at === new Date(row.ts + 55 * 60000).toISOString(), row && `${row.ts} ${row.hora} ${row.delivery_deadline_at}`);
  ok("dashboard DOMICILIO ASAP: hora = promessa al cliente, NON lo specchio della deadline", row && row.hora === horaAsap);
  ok("dashboard DOMICILIO ASAP: nessun patch post-insert di hora/deadline", !UPDATED.some((u) => "hora" in u.patch || "delivery_deadline_at" in u.patch));

  // replay (same client_req_id) → idempotent, no second insert, no new deadline
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: horaAsap, items: item, client_req_id: "req-dash-1" });
  ok("replay same client_req_id: idempotent, one insert, deadline unchanged", r && r.idempotent === true && INSERTED.length === 1);

  // ── [DEADLINE-HORA] dashboard DOMICILIO PROGRAMMATO (hora oltre il pavimento) ──
  // È il caso #001 del 2026-09-22: creato 17:51, promesso 21:47. Prima della
  // patch nasceva con deadline 18:46 ed era TARDE quasi tre ore in anticipo.
  reset();
  const horaProg = horaTraMinuti(150);
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "Programmato", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: horaProg, items: item, client_req_id: "req-prog-1" });
  row = INSERTED[0];
  ok("dashboard DOMICILIO programmato: insert ok", r && r.success && row, JSON.stringify(r));
  ok("dashboard DOMICILIO programmato (hora a +150'): deadline = hora, NON ts+55'",
    row && row.delivery_deadline_at === expectedDeadline(row)
        && row.delivery_deadline_at !== new Date(row.ts + 55 * 60000).toISOString(),
    row && `${row.hora} → ${row.delivery_deadline_at}`);
  ok("dashboard DOMICILIO programmato: la deadline cade nel minuto della hora promessa",
    row && formatMadridHHMM(Date.parse(row.delivery_deadline_at)) === row.hora,
    row && `${row.hora} vs ${formatMadridHHMM(Date.parse(row.delivery_deadline_at))}`);
  ok("dashboard DOMICILIO programmato: non è TARDE alla nascita (deadline nel futuro)",
    row && Date.parse(row.delivery_deadline_at) > row.ts + 55 * 60000);

  // ── 3: WhatsApp bot DOMICILIO (operatorManual falsy) ───────────────────
  reset();
  r = await creaOrdine({ canal: "WA", waId: "34600000000", nombre: "Bot", tipo_consegna: "DOMICILIO", direccion: "Reino 1", zona: "Q1", hora: "21:30", items: item, forno_out: "21:20" });
  row = INSERTED[0];
  // [DEADLINE-HORA] il bot usa `horaFinale` (lo slot-search può spostare la hora
  // richiesta): la deadline deve seguire la hora PERSISTITA, mai quella chiesta.
  ok("WhatsApp DOMICILIO: deadline = max(ts+55', hora PERSISTITA) — calcolata su horaFinale",
    row && row.delivery_deadline_at === expectedDeadline(row), row && `${row.ts} ${row.hora} ${row.delivery_deadline_at}`);
  ok("WhatsApp DOMICILIO: hora stays the bot promise 21:30", row && row.hora === "21:30");

  // ── RITIRO: no delivery deadline ───────────────────────────────────────
  reset();
  await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "R", tipo_consegna: "RITIRO", hora: "21:00", items: item });
  ok("RITIRO: delivery_deadline_at null, hora untouched", INSERTED[0] && INSERTED[0].delivery_deadline_at === null && INSERTED[0].hora === "21:00");


  // ── createdMs generated ONCE, reused across INSERT retries ───────────────
  reset(); FAIL_INSERTS = 2;
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: horaTraMinuti(150), items: item, client_req_id: "req-retry" });
  ok("INSERT retried after 2 PK collisions (3 attempts)", ATTEMPTS.length === 3 && r.success, `${ATTEMPTS.length} ${JSON.stringify(r)}`);
  ok("same ts on every attempt (createdMs not regenerated)", new Set(ATTEMPTS.map((a) => a.ts)).size === 1);
  // [DEADLINE-HORA] su un ordine PROGRAMMATO la deadline è calcolata, non costante:
  // i retry non devono ricalcolarla con un createdMs nuovo.
  ok("same delivery_deadline_at on every attempt = max(ts+55', hora)",
    new Set(ATTEMPTS.map((a) => a.delivery_deadline_at)).size === 1 && ATTEMPTS[0].delivery_deadline_at === expectedDeadline(ATTEMPTS[0]),
    JSON.stringify(ATTEMPTS.map((a) => a.delivery_deadline_at)));
  ok("state timestamps derive from the same instant (updated_at = ts on every attempt)", ATTEMPTS.every((a) => Date.parse(a.updated_at) === a.ts));
  reset(); FAIL_INSERTS = 1;
  await creaOrdine({ canal: "WA", waId: "34600000001", nombre: "Bot", tipo_consegna: "DOMICILIO", direccion: "Reino 1", zona: "Q1", hora: "21:30", items: item, forno_out: "21:20", estado: "EN_COCINA" });
  ok("WhatsApp EN_COCINA with a retry: en_cocina_at = confirmado_at = ts, deadline = max(ts+55', hora) on both attempts",
    ATTEMPTS.length === 2 && ATTEMPTS.every((a) => Date.parse(a.en_cocina_at) === a.ts && Date.parse(a.confirmado_at) === a.ts && a.delivery_deadline_at === expectedDeadline(a)) && ATTEMPTS[0].ts === ATTEMPTS[1].ts,
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
  //
  // ⚠️ [DEADLINE-HORA 2026-09-22] CONTRATTO DI PRODOTTO REVOCATO ESPLICITAMENTE.
  //
  // Fino al 2026-09-22 il contratto era: "modificare `hora` NON tocca
  // delivery_deadline_at", e il caso E qui sotto lo verificava, controllando pure
  // che la colonna non finisse nel PATCH. Quel contratto rendeva impossibile
  // correggere un ordine programmato: l'unico campo che esprime la promessa al
  // cliente non aveva alcun effetto sul limite operativo, e l'ordine restava
  // TARDE in cucina per ore.
  //
  // Nuovo contratto canonico (DOMICILIO):
  //     delivery_deadline_at = max(ts ORIGINALE + 55', hora corrente)
  // La deadline SEGUE `hora` in ENTRAMBE le direzioni — spostare `hora` indietro
  // la accorcia — con `ts + 55'` come pavimento invalicabile. RITIRO → NULL.
  //
  // Questa non è una manutenzione dei test: è una decisione di prodotto revocata.
  // I casi E sotto sono riscritti, non adattati.
  const TS = Date.parse("2026-09-21T18:00:00Z");   // 20:00 Madrid
  const FLOOR = new Date(TS + 55 * 60000).toISOString(); // 18:55Z = 20:55 Madrid
  // La `hora` di base 21:30 Madrid (19:30Z) è OLTRE il pavimento: con il nuovo
  // contratto la deadline di #700 è la hora promessa, non più ts+55'.
  const DL_HORA = new Date(Date.parse("2026-09-21T19:30:00Z")).toISOString();
  const base = (extra) => ({ id: "#700", tipo_consegna: "RITIRO", estado: "EN_COCINA", hora: "21:30", ts: TS, delivery_deadline_at: null,
    items: item, nombre: "X", canal: "MANUAL", direccion: null, zona: null, forzado: false, ...extra });
  const mod = async (u) => modificaOrdine("#700", { ...u, operatorManual: true });

  reset();
  await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "R", tipo_consegna: "RITIRO", hora: "21:00", items: item });
  ok("A new RITIRO: delivery_deadline_at NULL", INSERTED[0].delivery_deadline_at === null);

  reset(); STORE["#700"] = base();
  r = await mod({ tipo_consegna: "DOMICILIO", direccion: "Reino 1" });
  ok("B RITIRO → DOMICILIO: deadline dal ts ORIGINALE (mai now), = max(ts+55', hora 21:30) = hora",
    r.success && STORE["#700"].delivery_deadline_at === DL_HORA, `${JSON.stringify(r)} ${STORE["#700"].delivery_deadline_at}`);
  ok("B hora untouched by the conversion", STORE["#700"].hora === "21:30");

  r = await mod({ tipo_consegna: "RITIRO", direccion: "" });
  ok("C DOMICILIO → RITIRO: deadline NULL (not operative)", r.success && STORE["#700"].delivery_deadline_at === null, String(STORE["#700"].delivery_deadline_at));

  r = await mod({ tipo_consegna: "DOMICILIO", direccion: "Reino 1" });
  ok("D DOMICILIO → RITIRO → DOMICILIO: ricostruita deterministicamente dal ts originale = max(ts+55', hora)",
    STORE["#700"].delivery_deadline_at === DL_HORA, String(STORE["#700"].delivery_deadline_at));

  // ── E (RISCRITTO) — la deadline segue `hora`, pavimento ts+55' ────────────
  UPDATED = [];
  r = await mod({ hora: "22:45" });
  ok("E1 hora AVANTI (21:30 → 22:45): deadline avanza con la promessa",
    STORE["#700"].hora === "22:45" && STORE["#700"].delivery_deadline_at === new Date(Date.parse("2026-09-21T20:45:00Z")).toISOString(),
    STORE["#700"].delivery_deadline_at);
  ok("E1 la deadline viene davvero SCRITTA nel patch (il vecchio contratto lo vietava)",
    UPDATED.some((u) => "delivery_deadline_at" in u.patch), JSON.stringify(UPDATED.map((u) => Object.keys(u.patch))));

  UPDATED = [];
  r = await mod({ hora: "21:00" });
  ok("E2 hora INDIETRO (22:45 → 21:00): deadline si ACCORCIA fino alla nuova promessa",
    STORE["#700"].hora === "21:00" && STORE["#700"].delivery_deadline_at === new Date(Date.parse("2026-09-21T19:00:00Z")).toISOString(),
    STORE["#700"].delivery_deadline_at);

  UPDATED = [];
  r = await mod({ hora: "20:10" });
  ok("E3 hora PRIMA del pavimento (20:10 < ts+55' = 20:55): deadline = ts+55', non scende oltre",
    STORE["#700"].hora === "20:10" && STORE["#700"].delivery_deadline_at === FLOOR,
    STORE["#700"].delivery_deadline_at);

  // ripristina una hora oltre il pavimento per i casi F e seguenti
  await mod({ hora: "21:30" });
  ok("E4 ritorno a hora 21:30: deadline ricalcolata di nuovo sulla promessa",
    STORE["#700"].delivery_deadline_at === DL_HORA, STORE["#700"].delivery_deadline_at);

  UPDATED = [];
  r = await mod({ direccion: "Playa 3", zona: "Q5", zona_manuale: true });
  ok("F edit di indirizzo / zona: deadline invariata e NON riscritta (solo hora e tipo la muovono)",
    STORE["#700"].delivery_deadline_at === DL_HORA && !UPDATED.some((u) => "delivery_deadline_at" in u.patch));

  UPDATED = [];
  r = await mod({ tipo_consegna: "DOMICILIO" });
  ok("same tipo re-sent (DOMICILIO → DOMICILIO): deadline invariata nel valore",
    STORE["#700"].delivery_deadline_at === DL_HORA, STORE["#700"].delivery_deadline_at);

  UPDATED = [];
  r = await mod({ delivery_deadline_at: "2030-01-01T00:00:00.000Z", nota: "x" });
  ok("a client can never set delivery_deadline_at through modificaOrdine", STORE["#700"].delivery_deadline_at === DL_HORA);

  // 5° call site: riga legacy DOMICILIO SENZA deadline → ricostruita dal ts originale.
  // LIMITE NOTO E VOLUTO: il recupero avviene solo negli edit che entrano nel blocco
  // di ricalcolo di modificaOrdine (items / tipo_consegna / hora / direccion /
  // durata_andata_min / descuento). Un edit di sola `nota` non lo attraversa e la
  // riga resta senza deadline finché non la si tocca davvero. Allargare quel gate
  // farebbe ricalcolare forno_out e totale a ogni modifica: fuori dallo scope.
  reset();
  STORE["#701"] = { ...base({ id: "#701", tipo_consegna: "DOMICILIO", direccion: "Reino 1", delivery_deadline_at: null }) };
  r = await modificaOrdine("#701", { nota: "solo nota", operatorManual: true });
  ok("legacy DOMICILIO: un edit di sola nota NON entra nel blocco → deadline ancora null (limite noto)",
    STORE["#701"].delivery_deadline_at === null, String(STORE["#701"].delivery_deadline_at));
  r = await modificaOrdine("#701", { direccion: "Reino 1", operatorManual: true });
  ok("legacy DOMICILIO senza deadline: ricostruita dal ts ORIGINALE al primo edit che entra nel blocco",
    STORE["#701"].delivery_deadline_at === DL_HORA, String(STORE["#701"].delivery_deadline_at));

  reset();
  r = await creaOrdine({ operatorManual: true, canal: "MANUAL", nombre: "T", tipo_consegna: "DOMICILIO", direccion: "Reino 1", hora: horaTraMinuti(20), items: item, delivery_deadline_at: "2030-01-01T00:00:00.000Z" });
  ok("a client can never set delivery_deadline_at through creaOrdine", INSERTED[0].delivery_deadline_at === expectedDeadline(INSERTED[0]));

  // ── 1: rider hook off ──────────────────────────────────────────────────
  // [DELIVERY-REFACTOR 2026-09-22] LISTO → EN_ENTREGA non è più una transizione
  // legale: restano la finalizzazione moderna e quella dell'ordine legacy in-flight.
  for (const [from, to] of [["LISTO", "RETIRADO"], ["EN_ENTREGA", "RETIRADO"]]) {
    reset();
    STORE["#900"] = { id: "#900", tipo_consegna: "DOMICILIO", estado: from, zona: "Q1", manual_giro_id: null, hora: "21:00", delivery_deadline_at: "2026-09-21T19:00:00.000Z", ts: 1 };
    // [DELIVERY-REFACTOR 2026-09-22] RETIRADO passa dalla regola di pagamento canonica:
    // senza metodo reale è rifiutato. Qui il focus resta il rider hook spento.
    const _extras = { actor_type: "operator", origin: "test" };
    if (to === "RETIRADO") _extras.metodo_pago = "efectivo";
    const res = await cambiaStato("#900", to, _extras);
    ok(`cambiaStato ${from}→${to}: state written`, res && res.success && STORE["#900"].estado === to, JSON.stringify(res));
    ok(`cambiaStato ${from}→${to}: NO DRIVER_STATO write`, !UPSERTS.some((u) => u.table === "config"), JSON.stringify(UPSERTS));
    ok(`cambiaStato ${from}→${to}: NO delivery_logs insert`, !OTHER_INSERTS.some((u) => u.table === "delivery_logs"));
    ok(`cambiaStato ${from}→${to}: hora and delivery_deadline_at untouched`, STORE["#900"].hora === "21:00" && STORE["#900"].delivery_deadline_at === "2026-09-21T19:00:00.000Z");
  }

  console.log(`\n== fdv1DeadlineAndRider: ${passed} pass / ${failed} fail`);
  if (failed) process.exitCode = 1;
})();
