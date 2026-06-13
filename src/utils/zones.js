// ===============================================================
// zones.js — Zone delivery La Dieci (Roquetas de Mar)
// Porting CJS del modulo frontend src/zones.js
// Aggiornato 11-mag-2026 con 5 zone dal Google My Maps ufficiale (KML)
// ===============================================================

const ZONE_DELIVERY = [
  {
    id: "Q1", nome: "CENTRO", tempoGiro: 15, maxOrdiniPerGiro: 4, costo: 2.50,
    // Pueblo / casco urbano. Include Plaza Itálica, Ayuntamiento, Plaza de Toros,
    // Castillo Santa Ana, area 200 Viviendas / Plaza de Andalucía.
    polygon: [
      [-2.6106065, 36.753968],
      [-2.6070016, 36.7520424],
      [-2.6043201, 36.7651583],
      [-2.5979894, 36.7772082],
      [-2.6032465, 36.7790301],
      [-2.6097482, 36.7789269],
      [-2.6190179, 36.762426],
      [-2.6171317, 36.7595905],
      [-2.6164032, 36.7581728],
      [-2.6162569, 36.7572742],
      [-2.6167047, 36.7565487],
      [-2.6106065, 36.753968]
    ]
  },
  {
    id: "Q2", nome: "BUENAVISTA", tempoGiro: 20, maxOrdiniPerGiro: 3, costo: 2.50,
    // Sud lungo Avenida Sabinar parte alta. Calles Cuba, Brasil, Bolivia, Colombia,
    // Cristaleros, Costa Brava. Palazzine residenziali, ~1,8 km dalla pizzeria.
    polygon: [
      [-2.6167047, 36.7565487],
      [-2.6301802, 36.748709],
      [-2.6282061, 36.7436539],
      [-2.6248974, 36.7359663],
      [-2.6165331, 36.7313761],
      [-2.6112959, 36.7416062],
      [-2.6070016, 36.7520424],
      [-2.6116384, 36.7543644],
      [-2.6167047, 36.7565487]
    ]
  },
  {
    id: "Q3", nome: "IES", tempoGiro: 25, maxOrdiniPerGiro: 4, costo: 2.50,
    // Ferro di cavallo periferia ovest+sud pueblo. IES Turaniana, Hospital,
    // Estadio Antonio Peroles, area scuole. Una delle zone più grandi.
    polygon: [
      [-2.6399034, 36.7625174],
      [-2.6385301, 36.7579102],
      [-2.6358694, 36.7544719],
      [-2.6334661, 36.7513085],
      [-2.6293462, 36.7495204],
      [-2.6228234, 36.7533631],
      [-2.6195616, 36.7552499],
      [-2.6172012, 36.7566746],
      [-2.6163856, 36.7574117],
      [-2.6175086, 36.7600564],
      [-2.6191466, 36.7625635],
      [-2.6173908, 36.7655486],
      [-2.6155489, 36.7686368],
      [-2.6167719, 36.768465],
      [-2.619658, 36.7681127],
      [-2.6204841, 36.7670727],
      [-2.6237242, 36.7672274],
      [-2.6399034, 36.7625174]
    ]
  },
  {
    id: "Q4", nome: "CORTIJOS", tempoGiro: 28, maxOrdiniPerGiro: 2, costo: 2.50,
    // Cortijos de Marín, limite ovest = autostrada (non città di La Mojonera).
    // Zona isolata oltre serre, ~3,7 km dalla pizzeria.
    polygon: [
      [-2.6618172, 36.7590341],
      [-2.6593281, 36.7563178],
      [-2.6405741, 36.7566273],
      [-2.6390292, 36.7573493],
      [-2.6404883, 36.7621284],
      [-2.6584269, 36.7615439],
      [-2.6618172, 36.7590341]
    ]
  },
  {
    id: "Q5", nome: "LAS MARINAS", tempoGiro: 30, maxOrdiniPerGiro: 3, costo: 2.50,
    // Sabinar parte bassa. Las Marinas, Playa Serena, Club de Golf, zona Bajadilla.
    // Sud lungo costa, ~4,3 km dalla pizzeria.
    polygon: [
      [-2.6251549, 36.7360351],
      [-2.6414203, 36.7309822],
      [-2.639017, 36.7271299],
      [-2.6409054, 36.7255992],
      [-2.6434802, 36.7200783],
      [-2.6354551, 36.7133357],
      [-2.6165719, 36.73122],
      [-2.6251549, 36.7360351]
    ]
  }
];

// ── Calcolo tempoGiro dinamico da distanza reale ──────────────────
const RISTORANTE_LAT = 36.7621;  // Plaza Itálica 8, Roquetas de Mar (PUNTO DE PARTIDA del KML)
const RISTORANTE_LON = -2.6106;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Calcola tempoGiro (minuti) dalla distanza reale del cliente dal ristorante.
// CONVENZIONE: `tempoGiro` = tempo ANDATA one-way (driver dalla pizzeria al cliente).
// I consumatori (agentCucina, frontend) modellano la finestra di occupazione del driver
// come [hora - tg, hora + tg], cioè durata totale del trip = 2 × tg.
//
// La formula può SOLO ridurre il tempoGiro rispetto al valore fisso della zona —
// mai aumentarlo (evita sovra-blocco per zone ampie come Q5 Las Marinas).
// Se le coordinate non sono disponibili, ritorna zonaFallback.tempoGiro.
//
// NOTA: Il driver attuale gira in MACCHINA (non scooter come precedente versione).
// La macchina è più lenta in città per rotonde/parcheggio/vie strette del casco.
// Velocità calibrata da misure Google Maps reali (urbano ~17-22 km/h, autostrada 34 km/h).
//
// Bonus operatore: quando comunica al cliente l'orario di consegna, l'operatore
// aggiunge sempre ~15 min di cuscino (es. "tra 20:30 e 20:45"). Questo NON è nel
// codice — è una pratica lato operatore per gestire imprevisti senza promesse rigide.
// BUFFER operativo driver al cliente (parcheggio + citofono + scale + handoff).
// Una sola costante esposta — non sommare in altri punti.
// Modello (refactor 14/05/2026):
//   hora_promessa_cliente = forno_out + guida_pura + BUFFER_OPS_DRIVER_MIN
//   round_trip_driver    = guida_pura + BUFFER_OPS_DRIVER_MIN + guida_pura
const BUFFER_OPS_DRIVER_MIN = 3;

function calcolaTempoGiro(lat, lon, zonaFallback = null) {
  if (lat == null || lon == null) return zonaFallback?.tempoGiro ?? 20;
  const ROAD_FACTOR  = 1.70;  // fattore strade urbane (calibrato su misurazioni reali)
  const CAR_KMH      = 20;    // velocità media MACCHINA in città (con soste, semafori, parcheggio)
  const MIN_GIRO     = 8;     // minimo fisico guida one-way (anche per cliente vicinissimo)
  const distKm = haversineKm(RISTORANTE_LAT, RISTORANTE_LON, Number(lat), Number(lon));
  const tempoAndata = (distKm * ROAD_FACTOR / CAR_KMH) * 60; // minuti, andata one-way
  // Ritorna GUIDA PURA (no buffer ops). Il buffer va aggiunto dove serve dal consumatore.
  const tgCalcolato = Math.max(MIN_GIRO, Math.ceil(tempoAndata));
  // Non superare il valore fisso della zona — la formula ottimizza, non penalizza
  return zonaFallback ? Math.min(tgCalcolato, zonaFallback.tempoGiro) : tgCalcolato;
}


function pointInPolygon(point, polygon) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function assegnaZonaDaCoord(lat, lon) {
  for (const zona of ZONE_DELIVERY) {
    if (pointInPolygon([lon, lat], zona.polygon)) return zona;
  }
  return null;
}

// Keyword fallback minimo — usato SOLO quando geocoding (Nominatim, Photon) fallisce.
// Volutamente non esaustivo: il sistema ha cache + 2 geocoder + override manuale operatore.
// "200 viviendas" NON è tag intenzionalmente — barrio sensibile, l'operatore decide caso per caso.
const KEYWORDS_ZONA = {
  Q1: ["plaza italica", "italica", "itálica", "ayuntamiento", "casco"],
  Q2: ["buenavista", "cuba", "brasil", "bolivia", "colombia", "cristaleros"],
  Q3: ["ies", "instituto", "turaniana", "hospital", "castillo santa ana"],
  Q4: ["cortijo", "cortijos", "marín", "marin"],
  Q5: ["las marinas", "marinas", "playa serena", "bajadilla", "minarete"]
};

function assegnaZonaDaKeyword(indirizzo) {
  const lower = (indirizzo || "").toLowerCase();
  for (const [id, keywords] of Object.entries(KEYWORDS_ZONA)) {
    if (keywords.some(k => lower.includes(k))) {
      return ZONE_DELIVERY.find(z => z.id === id) || null;
    }
  }
  return null;
}

// Bounding box del comune di Roquetas de Mar — scarta coordinate di altre città
const ROQUETAS_BOUNDS = { latMin: 36.70, latMax: 36.79, lonMin: -2.68, lonMax: -2.58 };

function coordInRoquetas(lat, lon) {
  return lat >= ROQUETAS_BOUNDS.latMin && lat <= ROQUETAS_BOUNDS.latMax &&
         lon >= ROQUETAS_BOUNDS.lonMin && lon <= ROQUETAS_BOUNDS.lonMax;
}

// Rimuove dettagli appartamento dall'indirizzo prima del geocoding.
// Nominatim ha bisogno solo di "Via + Numero" — scala/piso/interno lo confondono.
// L'indirizzo completo rimane nel campo direccion per il driver.
function limpiaPerGeocode(indirizzo) {
  let s = String(indirizzo).trim();
  // Rimuovi tutto dopo indicatori appartamento espliciti
  s = s.replace(/[\s,]+(?:escalera?|esc\b\.?|piso\b|planta\b|puerta\b|pta\b\.?|bloque?\b|blq\b\.?|portal\b|apto\b\.?|apartamento\b|int(?:erior)?\b|letra\b|izq(?:uierda)?\b|dcha?\b|derecha\b).*$/gi, '');
  // Taglia alla prima virgola SOLO se quello che segue è un dettaglio appartamento
  // (inizia con cifra, simbolo grado, o è ≤4 char tipo "B", "1A").
  // NON tagliare se è un nome di luogo (es. "Aguadulce", "Almería") — altrimenti
  // Nominatim ignora la località e geocodifica la via dentro Roquetas de Mar.
  if (s.includes(',')) {
    const afterComma = s.split(',').slice(1).join(',').trim();
    if (/^\d|[ºª°]/.test(afterComma) || afterComma.length <= 4) s = s.split(',')[0];
  }
  // Rimuovi identificatore finale tipo "15 3ºA" o "15 1ºIzq"
  s = s.replace(/(\d+)\s+\d*[ºª°]\s*[a-z]*\s*$/i, '$1');
  return s.trim();
}

// Geocoding + zone assignment — restituisce { zona, lat, lon, metodo }
// Se Nominatim restituisce coordinate fuori da Roquetas de Mar, le scarta
// e usa solo il fallback keyword (lat/lon = null → tempoGiro fisso zona).
async function geocodificaEAssegnaZona(indirizzo) {
  const out = { zona: null, lat: null, lon: null, metodo: null };
  if (!indirizzo || String(indirizzo).trim().length < 5) return out;

  const UA = { "Accept-Language": "es", "User-Agent": "LaDieciBot/1.0 (pizzeria-orders)" };
  const indirizzoGeocode = limpiaPerGeocode(indirizzo); // solo "Via Numero" per Nominatim

  try {
    const query = encodeURIComponent(indirizzoGeocode + ", Roquetas de Mar");
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`, { headers: UA });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (coordInRoquetas(lat, lon)) {
          const zona = assegnaZonaDaCoord(lat, lon);
          if (zona) return { zona, lat, lon, metodo: "polygon" };
          const zonaKw = assegnaZonaDaKeyword(indirizzo);
          return { zona: zonaKw, lat, lon, metodo: zonaKw ? "keyword" : null };
        }
        // Coordinate fuori da Roquetas — Nominatim ha trovato un'altra città, ignora
      }
    }

    // Retry senza numero civico
    const indirizzoBase = indirizzoGeocode.replace(/\s+\d+\s*$/, "").trim();
    if (indirizzoBase !== indirizzoGeocode && indirizzoBase.length >= 4) {
      const q2 = encodeURIComponent(indirizzoBase + ", Roquetas de Mar");
      const r2 = await fetch(`https://nominatim.openstreetmap.org/search?q=${q2}&format=json&limit=1`, { headers: UA });
      if (r2.ok) {
        const d2 = await r2.json();
        if (d2 && d2.length > 0) {
          const lat = parseFloat(d2[0].lat);
          const lon = parseFloat(d2[0].lon);
          if (coordInRoquetas(lat, lon)) {
            const zona = assegnaZonaDaCoord(lat, lon);
            if (zona) return { zona, lat, lon, metodo: "polygon" };
          }
        }
      }
    }
  } catch (_) { /* fallback keyword */ }

  const zonaKw = assegnaZonaDaKeyword(indirizzo);
  return { zona: zonaKw, lat: null, lon: null, metodo: zonaKw ? "keyword" : null };
}

// ─── Service-day helpers (DELIVERY-DRIVER-SCHEDULE-SEPARATION-01) ─────────────
// Il servizio pizzeria attraversa la mezzanotte: un ordine delle 00:22 è DOPO
// uno delle 23:21, non prima. I confronti/sorting "naïve" (h*60+m) ordinano
// 00:22 (=22) prima di 23:21 (=1401) e rompono lo schedule driver.
//
// Regola: se l'ora è nella coda post-mezzanotte (HH in [0,4)), aggiungiamo 1440
// minuti così resta sulla stessa "service-day line" della serata.
//   20:00 -> 1200   23:21 -> 1401   00:11 -> 1451   00:22 -> 1462   00:25 -> 1465
//
// Helper NUOVI ed espliciti: NON sostituiscono toMin altrove (closingTime,
// proposeForNewOrder, agentCucina restano su clock-min). Usati solo dal path
// driver-schedule (serviceDay:true).
function toServiceDayMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  let min = h * 60 + (m || 0);
  if (h >= 0 && h < 4) min += 1440;
  return min;
}

function fromServiceDayMin(min) {
  if (min == null || !Number.isFinite(min)) return null;
  const wrapped = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function diffServiceDayMinutes(a, b) {
  // b - a in service-day minutes (entrambi già in service-day min).
  if (a == null || b == null) return null;
  return b - a;
}

// ─── Simulazione schedule del driver (schedule-aware, cascade-safe) ──────────
// COPIA 1:1 di ladieci-app33/src/zones.js (frontend). Tenere sincronizzati.
//
// Dato un set di ordini delivery esistenti, simula la giornata del driver in
// sequenza. Permette di calcolare quando il driver sarà REALMENTE libero e
// quando arrivano realmente le pizze (cascade-aware).
//
// Aggregazione same-zone-slot10: ordini stessa zona stesso slot10(hora) vanno
// in UN solo giro (driver fa più consegne in un trip), fino a maxOrdiniPerGiro.
//
// options.serviceDay (default false): se true usa toServiceDayMin per ordinare
// e schedulare i giri (gestisce la coda post-mezzanotte). I caller esistenti
// (proposeForNewOrder, agentCucina) NON passano il flag → comportamento
// invariato. Solo il path driver-field sync lo attiva.
// Stati che NON contano come consegna attiva nello schedule rider: terminali
// (consegna chiusa) + non-confermati (POR_CONFIRMAR). Se simulati come giri attivi
// gonfiano il retraso degli ordini reali. Sorgente unica per simulateDriverSchedule
// e computeDriverFields. Allineata agli stati esclusi altrove (plannerSnapshot).
const DRIVER_INACTIVE_STATES = new Set([
  "RETIRADO",
  "COMPLETADO",
  "COMPLETATO",
  "CHIUSO_FORZATO",
  "CANCELADO",
  "ANULADO",
  "ENTREGADO",
  "POR_CONFIRMAR",
]);

function simulateDriverSchedule(orders, options = {}) {
  const plainToMin = (t) => { if (!t) return null; const [h,m]=String(t).split(":").map(Number); return h*60+(m||0); };
  const toMin = options.serviceDay ? toServiceDayMin : plainToMin;
  const slot10 = (min) => {
    const mArr = Math.round(min / 10) * 10;
    const h = Math.floor(mArr/60)%24, m = mArr % 60;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  };

  const validi = (orders || []).filter(o =>
    o && o.tipo_consegna === "DOMICILIO" && o.hora && o.zona
    && !DRIVER_INACTIVE_STATES.has(o.estado)
  );

  const giriMap = new Map();
  for (const o of validi) {
    const zona = ZONE_DELIVERY.find(z => z.id === o.zona);
    if (!zona) continue;
    const minOra = toMin(o.hora);
    const sl = slot10(minOra);
    const key = `${o.zona}|${sl}`;
    if (!giriMap.has(key)) {
      giriMap.set(key, {
        zona: o.zona, zonaObj: zona, slot: sl,
        horaMin: minOra, count: 0, tg: 0,
      });
    }
    const g = giriMap.get(key);
    g.count += 1;
    g.horaMin = Math.min(g.horaMin, minOra);
    // Preferisce snapshot Google (durata_andata_min) se presente sull'ordine,
    // sennò Haversine. Convenzione one-way (andata pura, no cottura).
    const tgO = o.durata_andata_min != null
      ? o.durata_andata_min
      : calcolaTempoGiro(o.zona_lat, o.zona_lon, zona);
    g.tg = Math.max(g.tg, tgO); // worst case del gruppo
  }

  const giri = Array.from(giriMap.values()).sort((a, b) => a.horaMin - b.horaMin);

  // startTime è un vincolo "driver non libero prima di" in clock-min; "00:00"
  // (default) = nessun vincolo → 0. Mai passarlo per toServiceDayMin (00:00 → 1440).
  let t = options.startTime ? (plainToMin(options.startTime) || 0) : 0;
  for (const g of giri) {
    const partTeorica = g.horaMin - g.tg;
    g.partenzaMin = Math.max(t, partTeorica);
    g.consegnaMin = g.partenzaMin + g.tg;
    // Round trip: andata + BUFFER ops al cliente + ritorno
    g.rientroMin  = g.consegnaMin + BUFFER_OPS_DRIVER_MIN + g.tg;
    t = g.rientroMin;
  }

  return { giri, driverLiberoMin: t };
}

// ─── Driver schedule per-ordine (DELIVERY-DRIVER-SCHEDULE-SEPARATION-01) ──────
// Sorgente UNICA della matematica driver. NON tocca forno_out.
// Per ogni ordine DOMICILIO attivo calcola, dallo schedule driver corrente
// (service-day-aware), i campi advisory separati:
//   salida_driver_estimada  = partenza del giro a cui l'ordine appartiene
//   entrega_estimada        = partenza + durata_andata (consegna del giro)
//   retraso_estimado_min    = max(0, consegna − hora) in minuti service-day
//   conflicto_driver        = retraso_estimado_min > 0
// Ritorna Map<id, {salida_driver_estimada, entrega_estimada, retraso_estimado_min, conflicto_driver}>.
// RITIRO e ordini senza zona/hora NON entrano nella map (campi → null/false dal caller).
function computeDriverFields(orders, options = {}) {
  const sim = simulateDriverSchedule(orders || [], { ...options, serviceDay: true });
  const slot10 = (min) => {
    const mArr = Math.round(min / 10) * 10;
    const h = Math.floor(mArr / 60) % 24, m = mArr % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  // Indice giri per chiave zona|slot (stessa chiave usata in aggregazione).
  const byKey = new Map();
  for (const g of sim.giri) byKey.set(`${g.zona}|${g.slot}`, g);

  const out = new Map();
  for (const o of orders || []) {
    if (!o || o.tipo_consegna !== "DOMICILIO" || !o.zona || !o.hora) continue;
    if (DRIVER_INACTIVE_STATES.has(o.estado)) continue;
    const horaMin = toServiceDayMin(o.hora);
    if (horaMin == null) continue;
    const g = byKey.get(`${o.zona}|${slot10(horaMin)}`);
    if (!g) continue;
    const retraso = Math.max(0, diffServiceDayMinutes(horaMin, g.consegnaMin) || 0);
    out.set(o.id, {
      salida_driver_estimada: fromServiceDayMin(g.partenzaMin),
      entrega_estimada: fromServiceDayMin(g.consegnaMin),
      retraso_estimado_min: retraso,
      conflicto_driver: retraso > 0,
    });
  }
  return out;
}

// ─── Forno-out: quando la pizza deve uscire dal forno ────────────────────────
// Sorgente unica per backend (creaOrdine, getCaricoDelivery) e frontend.
// Regola: pizza esce il più tardi possibile MA non prima che il driver sia libero.
// Anticipo = pizza fredda sul bancone (peggio). Ritardo = driver aspetta in pizzeria (ok).
//   forno_out = hora_consegna − durata_andata, con wrap modulo 24.
//   Se driver_libero è un minuto positivo, può fare da pavimento cascade-aware.
//
// Invariante DB per DOMICILIO: hora = forno_out + durata_andata, SEMPRE.
// Se driver_libero costringe forno_out oltre (hora − andata), allora anche `hora`
// slitta in avanti. Senza questa propagazione si scriveva forno_out > hora — il
// pizzaiolo vedeva la pizza uscire DOPO la sua consegna (bug regressione 685749b).
// Ritorno: { forno_out, hora_finale, slittato }. `slittato=true` segnala al
// chiamante che ha promesso al cliente un orario diverso da quello richiesto.
function calcolaFornoOut({ tipoConsegna, hora, durataAndataMin, driverLiberoMin = 0 }) {
  if (!hora) return { forno_out: null, hora_finale: null, slittato: false };
  // RITIRO o durata mancante: forno_out = hora, niente slittamento possibile.
  if (tipoConsegna !== "DOMICILIO" || !durataAndataMin) {
    return { forno_out: hora, hora_finale: hora, slittato: false };
  }
  const toMin = (t) => { const [h,m] = String(t).split(":").map(Number); return h*60+(m||0); };
  const wrapDayMin = (m) => ((m % 1440) + 1440) % 1440;
  const toH = (m) => {
    const w = wrapDayMin(m);
    return `${String(Math.floor(w/60)).padStart(2,"0")}:${String(w%60).padStart(2,"0")}`;
  };
  const horaMin = toMin(hora);
  const fornoNaiveMin = horaMin - durataAndataMin;
  const hasDriverFloor = Number.isFinite(driverLiberoMin) && driverLiberoMin > 0;
  const fornoRealMin = hasDriverFloor ? Math.max(fornoNaiveMin, driverLiberoMin) : fornoNaiveMin;
  const slittato = fornoRealMin > fornoNaiveMin;
  const horaFinalMin = slittato ? fornoRealMin + durataAndataMin : horaMin;
  return {
    forno_out:   toH(fornoRealMin),
    hora_finale: toH(horaFinalMin),
    slittato
  };
}

// ─── Proposta per un nuovo ordine (cascade-aware + aggregation same-zone-slot) ─
// Output:
//   {
//     ok: bool,                     // true se hora richiesta è fattibile
//     consegnaPropostaMin: number,
//     consegnaPropostaH: "HH:MM",
//     aggregato: bool,              // si unisce a giro esistente same-zone-slot
//     giroEsistente: {hora, count} | null,
//     motivo: string | null,
//     driverLiberoMin: number,      // dopo simulazione ordini esistenti
//     tgNew: number,                // tempoGiro reale calcolato per il nuovo
//     sim: { giri, driverLiberoMin } // dettaglio per debugging
//   }
function proposeForNewOrder(orders, newOrder, options = {}) {
  const toMin = (t) => { if (!t) return null; const [h,m]=String(t).split(":").map(Number); return h*60+(m||0); };
  const toH = (m) => `${String(Math.floor(m/60)%24).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
  const slot10 = (min) => {
    const mArr = Math.round(min / 10) * 10;
    const h = Math.floor(mArr/60)%24, m = mArr % 60;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  };

  const zona = ZONE_DELIVERY.find(z => z.id === newOrder.zona);
  if (!zona) return { ok: true, consegnaPropostaMin: toMin(newOrder.hora), consegnaPropostaH: newOrder.hora, motivo: null, aggregato: false };

  const tgNew = calcolaTempoGiro(newOrder.zona_lat, newOrder.zona_lon, zona);
  const horaNewMin = toMin(newOrder.hora);
  const slotNew = slot10(horaNewMin);

  const sim = simulateDriverSchedule(orders, options);

  // Floor temporale "now": stesso lead (now + 5) usato dallo slot-search più
  // sotto, hoistato qui per poter gateare ANCHE il ramo aggregazione. minPart =
  // primo minuto in cui un driver può ancora partire da pizzeria.
  const nowMin = options.nowMin != null
    ? options.nowMin
    : (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const minPart = nowMin + 5;

  // Aggregazione su giro esistente same-zone-slot, MA solo se quel giro non è
  // già partito / in corso / troppo vicino alla partenza: se partenzaMin <
  // minPart il driver è (quasi) uscito e non possiamo più infilarci una pizza
  // nuova. In quel caso NON aggreghiamo: si cade nello slot-search, che proporrà
  // il prossimo slot realmente futuro (evita "Primera hora disponible = now").
  const giroEsistente = sim.giri.find(g =>
    g.zona === newOrder.zona && g.slot === slotNew && g.count < zona.maxOrdiniPerGiro
    && g.partenzaMin >= minPart
  );

  if (giroEsistente) {
    return {
      ok: true,
      consegnaPropostaMin: giroEsistente.horaMin,
      consegnaPropostaH: toH(giroEsistente.horaMin),
      motivo: `Aggregado al giro ${zona.id} ${toH(giroEsistente.horaMin)} (${giroEsistente.count + 1}/${zona.maxOrdiniPerGiro})`,
      aggregato: true,
      giroEsistente: { hora: toH(giroEsistente.horaMin), count: giroEsistente.count },
      driverLiberoMin: sim.driverLiberoMin,
      tgNew, sim,
    };
  }

  // ── Slot-search (28/05/2026, ex-cascade-conservativa) ─────────────────────
  // Replica 1:1 di src/zones.js frontend. Vedi commento esteso lì.
  // I giri esistenti diventano intervalli occupati LOCALI [partenza,rientro] e
  // cerchiamo il primo buco libero che ospiti il roundtrip del nuovo ordine.
  // Una prenotazione cliente per le 23:00 NON blocca più gli slot tra now e 23:00.
  const occupied = sim.giri.map(g => ({
    start: g.partenzaMin,
    end:   g.rientroMin,
    zona:  g.zona,
    horaStr: toH(g.horaMin),
  }));
  const occSorted = [...occupied].sort((a, b) => a.start - b.start);

  const roundtripNew = tgNew + BUFFER_OPS_DRIVER_MIN + tgNew;

  const collides = (a, b) => occSorted.some(o => a < o.end && o.start < b);

  const findFirstFreeStart = (fromMin, dur) => {
    let cand = fromMin;
    for (const o of occSorted) {
      if (cand + dur <= o.start) return cand;
      if (cand < o.end) cand = o.end;
    }
    return cand;
  };

  const findBlocker = (a, b) => occSorted.find(o => a < o.end && o.start < b);

  let ok, consegnaProposta, motivo = null;

  if (horaNewMin != null) {
    const partTeorica = horaNewMin - tgNew;
    const partFeasible = partTeorica >= minPart;
    const slotFree = !collides(partTeorica, partTeorica + roundtripNew);

    if (partFeasible && slotFree) {
      ok = true;
      consegnaProposta = horaNewMin;
    } else {
      ok = false;
      const fromMin = Math.max(minPart, partTeorica);
      const firstFreePart = findFirstFreeStart(fromMin, roundtripNew);
      consegnaProposta = Math.ceil((firstFreePart + tgNew) / 5) * 5;
      if (!partFeasible) {
        motivo = `Hora pedida muy pronta · mínimo ${toH(minPart + tgNew)} (cocina + andata)`;
      } else {
        const blocker = findBlocker(partTeorica, partTeorica + roundtripNew);
        motivo = blocker
          ? `Driver en ${blocker.zona} ${blocker.horaStr} · vuelve ~${toH(blocker.end)}`
          : `Driver ocupado hasta ~${toH(firstFreePart)}`;
      }
    }
  } else {
    ok = true;
    const firstFreePart = findFirstFreeStart(minPart, roundtripNew);
    consegnaProposta = Math.ceil((firstFreePart + tgNew) / 5) * 5;
  }

  return {
    ok,
    consegnaPropostaMin: consegnaProposta,
    consegnaPropostaH: toH(consegnaProposta),
    motivo,
    aggregato: false,
    giroEsistente: null,
    driverLiberoMin: sim.driverLiberoMin,
    tgNew, sim,
  };
}

module.exports = {
  ZONE_DELIVERY,
  KEYWORDS_ZONA,
  RISTORANTE_LAT,
  RISTORANTE_LON,
  BUFFER_OPS_DRIVER_MIN,
  calcolaFornoOut,
  simulateDriverSchedule,
  computeDriverFields,
  DRIVER_INACTIVE_STATES,
  toServiceDayMin,
  fromServiceDayMin,
  diffServiceDayMinutes,
  haversineKm,
  pointInPolygon,
  assegnaZonaDaCoord,
  assegnaZonaDaKeyword,
  coordInRoquetas,
  limpiaPerGeocode,
  geocodificaEAssegnaZona,
  calcolaTempoGiro,
  simulateDriverSchedule,
  proposeForNewOrder
};
