// tests/effectiveDeadline.test.js — [DEADLINE-HORA 2026-09-22]
//
// Unit test della funzione canonica `effectiveDeadline(createdMs, hora, minutes)`:
//
//     delivery_deadline_at = max(createdMs + N min, istante assoluto di `hora`)
//
// Prima di questo file `core/delivery/deadline.js` aveva copertura ZERO: né
// computeAutoDeadline né legacyDeadlineFromHora avevano un test diretto (la
// prima era coperta solo indirettamente da fdv1DeadlineAndRider attraverso
// creaOrdine, la seconda da niente). Promuovere legacyDeadlineFromHora da ramo
// di fallback a percorso principale senza rete sarebbe stato un salto nel buio:
// questo file è quella rete.
//
// Nessun mock, nessun DB: funzioni pure. Orari Madrid via Intl, indipendenti
// dalla TZ del processo (per questo i test passano `Date.parse("...Z")` e
// confrontano istanti assoluti, mai stringhe locali).

const { effectiveDeadline, computeAutoDeadline, legacyDeadlineFromHora, DELIVERY_DEADLINE_DEFAULT_MIN } =
  require("../src/core/delivery/deadline");

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { console.log("  ok  " + name); passed++; }
  else { console.log("  FAIL " + name + (detail ? " — " + detail : "")); failed++; }
};

// Istante assoluto → ISO, per confronti leggibili nei messaggi di errore.
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;
const N = DELIVERY_DEADLINE_DEFAULT_MIN; // 55

console.log("effectiveDeadline.test.js");

// ── 1. hora <= ts + 55  →  ts + 55 (il 90,8% del traffico reale) ────────────
// È il test anti-regressione più importante dell'intero file: se questo rompe,
// la patch ha cambiato il comportamento degli ordini ASAP, che sono quasi tutti.
{
  const created = Date.parse("2026-09-22T16:00:00Z"); // 18:00 Madrid (CEST)
  const atteso = created + N * MIN;                   // 18:55 Madrid

  // hora molto prima del pavimento
  let r = effectiveDeadline(created, "18:20", N);
  ok("hora 18:20 (+20') ≤ ts+55 → ts+55", r.deadlineMs === atteso, iso(r.deadlineMs));

  // hora = mediana reale del traffico (+32 min)
  r = effectiveDeadline(created, "18:32", N);
  ok("hora 18:32 (+32', mediana reale) → ts+55", r.deadlineMs === atteso, iso(r.deadlineMs));

  // hora = p90 reale (+54 min): ancora sotto il pavimento
  r = effectiveDeadline(created, "18:54", N);
  ok("hora 18:54 (+54', p90 reale) → ts+55", r.deadlineMs === atteso, iso(r.deadlineMs));

  // bordo esatto: hora === ts+55 → identico, nessun off-by-one
  r = effectiveDeadline(created, "18:55", N);
  ok("hora 18:55 (= ts+55 esatto) → ts+55, nessun off-by-one", r.deadlineMs === atteso, iso(r.deadlineMs));

  // il risultato è identico a computeAutoDeadline: stessa forma, stessi campi
  const auto = computeAutoDeadline(created, N);
  ok("sotto il pavimento il risultato è identico a computeAutoDeadline",
    r.deadlineMs === auto.deadlineMs && r.deadlineIso === auto.deadlineIso && r.hora === auto.hora);
}

// ── 2. hora > ts + 55  →  hora (ordine programmato) ─────────────────────────
{
  const created = Date.parse("2026-09-22T16:00:00Z"); // 18:00 Madrid

  // +1 minuto oltre il pavimento: la soglia deve essere netta
  let r = effectiveDeadline(created, "18:56", N);
  ok("hora 18:56 (= ts+56) → hora, soglia netta a un minuto",
    r.deadlineMs === Date.parse("2026-09-22T16:56:00Z"), iso(r.deadlineMs));

  // il caso reale #001: creato 17:51, promesso 21:47 (+236 min)
  const c001 = Date.parse("2026-09-22T15:51:28Z"); // 17:51:28 Madrid
  r = effectiveDeadline(c001, "21:47", N);
  ok("caso #001 (creato 17:51, hora 21:47) → deadline 21:47 Madrid, non 18:46",
    r.deadlineMs === Date.parse("2026-09-22T19:47:00Z"), iso(r.deadlineMs));
  ok("caso #001: hora specchio = 21:47", r.hora === "21:47", r.hora);

  // il massimo storico su 60 giorni: +123 min
  r = effectiveDeadline(Date.parse("2026-09-22T16:00:00Z"), "20:03", N);
  ok("massimo storico (+123') → hora", r.deadlineMs === Date.parse("2026-09-22T18:03:00Z"), iso(r.deadlineMs));
}

// ── 3. hora assente / vuota / malformata  →  ts + 55, mai un throw ──────────
{
  const created = Date.parse("2026-09-22T16:00:00Z");
  const atteso = created + N * MIN;
  const casi = [null, undefined, "", "   ", "abc", "25:99", "24:00", "99:99", "7", "7:5", ":30", "18:60", "-1:00", {}, [], NaN, 0];
  let tutteOk = true, dettaglio = "";
  for (const c of casi) {
    let r;
    try { r = effectiveDeadline(created, c, N); }
    catch (e) { tutteOk = false; dettaglio = `throw su ${JSON.stringify(c)}: ${e.message}`; break; }
    if (!r || r.deadlineMs !== atteso) { tutteOk = false; dettaglio = `${JSON.stringify(c)} → ${r && iso(r.deadlineMs)}`; break; }
  }
  ok("hora null/vuota/malformata → ts+55 senza throw (" + casi.length + " casi)", tutteOk, dettaglio);

  // "24:00" NON deve essere accettato come mezzanotte: il regex ammette solo 0-23
  ok("'24:00' è rifiutato dal parser, non interpretato come 00:00 del giorno dopo",
    legacyDeadlineFromHora("24:00", created) === null);
}

// ── 4. hora nel passato  →  ts + 55 (pavimento invalicabile) ────────────────
// La deadline segue `hora` in entrambe le direzioni, ma non scende MAI sotto
// ts + 55: la cucina non può ricevere meno di 55 minuti di margine.
{
  const created = Date.parse("2026-09-22T16:00:00Z"); // 18:00 Madrid
  const atteso = created + N * MIN;

  let r = effectiveDeadline(created, "17:30", N);
  ok("hora 17:30 (30' PRIMA della creazione) → ts+55, pavimento rispettato", r.deadlineMs === atteso, iso(r.deadlineMs));

  r = effectiveDeadline(created, "18:00", N);
  ok("hora = istante di creazione → ts+55", r.deadlineMs === atteso, iso(r.deadlineMs));

  r = effectiveDeadline(created, "12:00", N);
  ok("hora 12:00 (6h prima) → ts+55", r.deadlineMs === atteso, iso(r.deadlineMs));
}

// ── 5. wrap di mezzanotte ───────────────────────────────────────────────────
// `hora` è HH:MM senza data: va risolta all'istante PIÙ VICINO alla creazione
// entro ±1 giorno Madrid, altrimenti un ordine delle 23:50 per le 00:16
// darebbe -1414 minuti invece di +26.
{
  // creato 23:50 Madrid del 22/09 → hora 00:16 = giorno DOPO, +26 min
  const created = Date.parse("2026-09-22T21:50:00Z"); // 23:50 Madrid
  const promesso = legacyDeadlineFromHora("00:16", created);
  ok("creato 23:50, hora 00:16 → risolta al giorno dopo (+26'), non -1414'",
    promesso === Date.parse("2026-09-22T22:16:00Z"), iso(promesso));

  // +26 min < 55 → vince comunque il pavimento
  const r = effectiveDeadline(created, "00:16", N);
  ok("creato 23:50, hora 00:16 → ts+55 (il wrap non inventa una deadline lontana)",
    r.deadlineMs === created + N * MIN, iso(r.deadlineMs));

  // wrap con hora oltre il pavimento: creato 23:30, hora 01:00 → +90 min
  const c2 = Date.parse("2026-09-22T21:30:00Z"); // 23:30 Madrid
  const r2 = effectiveDeadline(c2, "01:00", N);
  ok("creato 23:30, hora 01:00 (+90') → hora del giorno dopo",
    r2.deadlineMs === Date.parse("2026-09-22T23:00:00Z"), iso(r2.deadlineMs));

  // creato 00:20, hora 23:40: il candidato più vicino è il giorno PRIMA (-40'),
  // non lo stesso giorno (+23h20). Passato → pavimento.
  const c3 = Date.parse("2026-09-22T22:20:00Z"); // 00:20 Madrid del 23/09
  const p3 = legacyDeadlineFromHora("23:40", c3);
  ok("creato 00:20, hora 23:40 → risolta al giorno PRIMA (-40'), non +23h20",
    p3 === Date.parse("2026-09-22T21:40:00Z"), iso(p3));
  ok("creato 00:20, hora 23:40 → deadline = ts+55 (istante passato)",
    effectiveDeadline(c3, "23:40", N).deadlineMs === c3 + N * MIN);
}

// ── 6. DST marzo Madrid (CET → CEST, +1h alle 02:00 del 29/03/2026) ─────────
// La notte del cambio l'ora locale 02:00→03:00 non esiste. madridWallToInstant
// fa due passaggi proprio per questo: qui verifichiamo che non produca istanti
// assurdi e che l'aritmetica resti coerente.
{
  // creato 01:30 CET (00:30Z) del 29/03, hora 03:30 CEST (01:30Z) → +60 min reali
  const created = Date.parse("2026-03-29T00:30:00Z");
  const promesso = legacyDeadlineFromHora("03:30", created);
  ok("DST marzo: creato 01:30 CET, hora 03:30 CEST → +60' reali (non +120')",
    promesso === Date.parse("2026-03-29T01:30:00Z"), iso(promesso));

  const r = effectiveDeadline(created, "03:30", N);
  ok("DST marzo: +60' > pavimento → vince hora",
    r.deadlineMs === Date.parse("2026-03-29T01:30:00Z"), iso(r.deadlineMs));

  // ora inesistente 02:30 (saltata dal cambio): non deve produrre NaN né throw
  const rGap = effectiveDeadline(created, "02:30", N);
  ok("DST marzo: hora 02:30 (ora inesistente) → risultato finito, nessun NaN/throw",
    Number.isFinite(rGap.deadlineMs) && typeof rGap.deadlineIso === "string");
  ok("DST marzo: hora inesistente non scende mai sotto il pavimento",
    rGap.deadlineMs >= created + N * MIN, iso(rGap.deadlineMs));
}

// ── 7. DST ottobre Madrid (CEST → CET, -1h alle 03:00 del 25/10/2026) ───────
// Quella notte l'ora locale 02:00–03:00 esiste DUE volte: l'ambiguità va risolta
// in modo deterministico, senza NaN e senza violare il pavimento.
{
  // creato 01:30 CEST (23:30Z del 24/10), hora 03:30 CET (02:30Z) → +180' reali
  const created = Date.parse("2026-10-24T23:30:00Z");
  const promesso = legacyDeadlineFromHora("03:30", created);
  ok("DST ottobre: creato 01:30 CEST, hora 03:30 CET → +180' reali (non +120')",
    promesso === Date.parse("2026-10-25T02:30:00Z"), iso(promesso));

  const r = effectiveDeadline(created, "03:30", N);
  ok("DST ottobre: +180' > pavimento → vince hora",
    r.deadlineMs === Date.parse("2026-10-25T02:30:00Z"), iso(r.deadlineMs));

  // ora ambigua 02:30 (esiste due volte): deve dare un istante finito e stabile
  const a1 = legacyDeadlineFromHora("02:30", created);
  const a2 = legacyDeadlineFromHora("02:30", created);
  ok("DST ottobre: hora ambigua 02:30 → istante finito", Number.isFinite(a1), String(a1));
  ok("DST ottobre: hora ambigua risolta in modo STABILE (stesso input, stesso output)", a1 === a2);
  ok("DST ottobre: hora ambigua non viola il pavimento",
    effectiveDeadline(created, "02:30", N).deadlineMs >= created + N * MIN);
}

// ── 8. determinismo / idempotenza ──────────────────────────────────────────
// Nessun Date.now() dentro la funzione: due chiamate identiche a distanza di
// tempo devono dare lo stesso ISO, altrimenti i retry di INSERT scriverebbero
// deadline diverse per lo stesso ordine.
{
  const created = Date.parse("2026-09-22T16:00:00Z");
  const casi = ["21:30", "18:10", "", null, "00:16", "abc"];
  let stabile = true, dettaglio = "";
  for (const c of casi) {
    const a = effectiveDeadline(created, c, N);
    const b = effectiveDeadline(created, c, N);
    if (a.deadlineMs !== b.deadlineMs || a.deadlineIso !== b.deadlineIso || a.hora !== b.hora) {
      stabile = false; dettaglio = `instabile su ${JSON.stringify(c)}`; break;
    }
  }
  ok("idempotenza: stesso input → stesso output (" + casi.length + " casi)", stabile, dettaglio);

  // la forma del risultato è sempre la stessa, su entrambi i rami
  const sotto = effectiveDeadline(created, "18:10", N);
  const sopra = effectiveDeadline(created, "21:30", N);
  const forma = (r) => Number.isFinite(r.deadlineMs) && typeof r.deadlineIso === "string"
    && /^\d{2}:\d{2}$/.test(r.hora) && new Date(r.deadlineMs).toISOString() === r.deadlineIso;
  ok("forma del risultato identica sui due rami {deadlineMs, deadlineIso, hora}", forma(sotto) && forma(sopra));

  // `minutes` personalizzato (config DELIVERY_DEADLINE_MIN 15..180)
  ok("minutes=15: pavimento più basso rispettato",
    effectiveDeadline(created, "18:10", 15).deadlineMs === created + 15 * MIN);
  ok("minutes=180: pavimento più alto vince su una hora a +90'",
    effectiveDeadline(created, "19:30", 180).deadlineMs === created + 180 * MIN);
  ok("default minutes = 55 quando omesso",
    effectiveDeadline(created, "18:10").deadlineMs === created + N * MIN);
}

// ── 9. preview canonica: stessa funzione dell'INSERT ───────────────────────
// La preview di Nuevo Pedido deve mostrare ESATTAMENTE il valore che verrà
// persistito. Se divergesse, l'operatore leggerebbe un "Hora límite" diverso da
// quello che la cucina poi vede. previewDeliveryCore è puro: niente DB, niente
// mock, gli passiamo liste vuote.
{
  const { previewDeliveryCore } = require("../src/agents/dashboardDelivery");
  const now = Date.parse("2026-09-22T16:00:00Z"); // 18:00 Madrid
  const args = { newOrder: { tipo_consegna: "DOMICILIO", zona: null }, orders: [], giros: [], cfg: {} };

  // senza hora → comportamento precedente alla patch (now + N)
  let p = previewDeliveryCore({ ...args, nowMs: now });
  ok("preview senza hora → now + 55' (comportamento invariato)",
    p.delivery_deadline_preview === iso(now + N * MIN) && p.hora_preview === "18:55", `${p.hora_preview} ${p.delivery_deadline_preview}`);

  // hora entro il pavimento → invariata
  p = previewDeliveryCore({ ...args, nowMs: now, hora: "18:20" });
  ok("preview con hora ASAP (18:20) → now + 55'", p.delivery_deadline_preview === iso(now + N * MIN), p.hora_preview);

  // hora oltre il pavimento → la preview mostra la promessa
  p = previewDeliveryCore({ ...args, nowMs: now, hora: "21:30" });
  ok("preview con hora programmata (21:30) → 21:30, non 18:55",
    p.delivery_deadline_preview === iso(Date.parse("2026-09-22T19:30:00Z")) && p.hora_preview === "21:30", `${p.hora_preview} ${p.delivery_deadline_preview}`);

  // hora malformata → non rompe la preview
  p = previewDeliveryCore({ ...args, nowMs: now, hora: "abc" });
  ok("preview con hora malformata → now + 55', nessun throw", p.delivery_deadline_preview === iso(now + N * MIN));

  // ⟵ l'invariante che conta: preview === valore che verrà scritto
  for (const h of ["", "18:20", "21:30", "00:16", "abc"]) {
    const prev = previewDeliveryCore({ ...args, nowMs: now, hora: h });
    const write = effectiveDeadline(now, h, N);
    ok(`preview e INSERT concordano per hora=${JSON.stringify(h)}`,
      prev.delivery_deadline_preview === write.deadlineIso && prev.hora_preview === write.hora,
      `${prev.delivery_deadline_preview} vs ${write.deadlineIso}`);
  }
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
