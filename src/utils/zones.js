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
function calcolaTempoGiro(lat, lon, zonaFallback = null) {
  if (!lat || !lon) return zonaFallback?.tempoGiro ?? 20;
  const ROAD_FACTOR  = 1.70;  // fattore strade urbane (calibrato su misurazioni reali)
  const CAR_KMH      = 20;    // velocità media MACCHINA in città (con soste, semafori, parcheggio)
  const BUFFER_MIN   = 3;     // buffer sicurezza
  const MIN_GIRO     = 10;    // minimo fisico: suonare, aspettare, consegnare, tornare
  const distKm = haversineKm(RISTORANTE_LAT, RISTORANTE_LON, lat, lon);
  const tempoAndata = (distKm * ROAD_FACTOR / CAR_KMH) * 60; // minuti
  const tgCalcolato = Math.max(MIN_GIRO, Math.ceil(tempoAndata * 2 + BUFFER_MIN));
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
  // Se c'è una virgola prendi solo la prima parte (es. "Calle Real 15, 3ºB" → "Calle Real 15")
  if (s.includes(',')) s = s.split(',')[0];
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

module.exports = {
  ZONE_DELIVERY,
  KEYWORDS_ZONA,
  pointInPolygon,
  assegnaZonaDaCoord,
  assegnaZonaDaKeyword,
  geocodificaEAssegnaZona,
  calcolaTempoGiro
};
