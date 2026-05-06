// ===============================================================
// zones.js — Zone delivery La Dieci (Roquetas de Mar)
// Porting CJS del modulo frontend src/zones.js
// ===============================================================

const ZONE_DELIVERY = [
  {
    id: "Q1", nome: "CENTRO + BUENAVISTA", tempoGiro: 10, maxOrdiniPerGiro: 4, costo: 2.50,
    polygon: [
      [-2.6097482, 36.7789269],[-2.6190179, 36.762426],[-2.6156705, 36.7561685],
      [-2.6106065, 36.753968],[-2.617988,  36.7456465],[-2.6243394, 36.7360173],
      [-2.6163144, 36.7311512],[-2.6070016, 36.7520424],[-2.5979894, 36.7772082],
      [-2.6097482, 36.7789269]
    ]
  },
  {
    id: "Q2", nome: "LAS MARINAS", tempoGiro: 32, maxOrdiniPerGiro: 2, costo: 2.50,
    polygon: [
      [-2.6248974, 36.7359663],[-2.6411628, 36.7309134],[-2.6387595, 36.7270611],
      [-2.6432227, 36.7200095],[-2.6351976, 36.7132669],[-2.6163144, 36.7311512],
      [-2.6248974, 36.7359663]
    ]
  },
  {
    id: "Q3", nome: "IES", tempoGiro: 22, maxOrdiniPerGiro: 5, costo: 2.50,
    polygon: [
      [-2.6397746, 36.7623799],[-2.6379721, 36.7578415],[-2.6313632, 36.755641],
      [-2.6333373, 36.751171],[-2.6292174, 36.7493829],[-2.6166861, 36.7572226],
      [-2.6190179, 36.762426],[-2.6159995, 36.7680868],[-2.6233809, 36.7685681],
      [-2.6397746, 36.7623799]
    ]
  },
  {
    id: "Q4", nome: "CORTIJOS", tempoGiro: 26, maxOrdiniPerGiro: 2, costo: 2.50,
    polygon: [
      [-2.6618172, 36.7590341],[-2.6593281, 36.7563178],[-2.6405741, 36.7566273],
      [-2.6390292, 36.7573493],[-2.6404883, 36.7621284],[-2.6584269, 36.7615439],
      [-2.6618172, 36.7590341]
    ]
  }
];

// ── Calcolo tempoGiro dinamico da distanza reale ──────────────────
const RISTORANTE_LAT = 36.7639; // Plaza Italica 8, Roquetas de Mar
const RISTORANTE_LON = -2.6108;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Calcola tempoGiro (minuti) dalla distanza reale del cliente dal ristorante.
// La formula può SOLO ridurre il tempoGiro rispetto al valore fisso della zona —
// mai aumentarlo (evita sovra-blocco per zone ampie come Q2/Q4).
// Se le coordinate non sono disponibili, ritorna zonaFallback.tempoGiro (comportamento precedente).
function calcolaTempoGiro(lat, lon, zonaFallback = null) {
  if (!lat || !lon) return zonaFallback?.tempoGiro ?? 20;
  const ROAD_FACTOR  = 1.70;  // fattore strade urbane (calibrato su misurazioni reali Q3)
  const SCOOTER_KMH  = 25;    // velocità media scooter città (con soste, semafori)
  const BUFFER_MIN   = 3;     // buffer sicurezza
  const MIN_GIRO     = 10;    // minimo fisico: suonare, aspettare, consegnare, tornare
  const distKm = haversineKm(RISTORANTE_LAT, RISTORANTE_LON, lat, lon);
  const tempoAndata = (distKm * ROAD_FACTOR / SCOOTER_KMH) * 60; // minuti
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

const KEYWORDS_ZONA = {
  Q1: ["centro", "buenavista", "plaza", "italica", "itálica"],
  Q2: ["las marinas", "marinas", "playa serena", "minarete", "residencial"],
  Q3: ["ies", "instituto", "cervantes", "colón", "colon", "poeta"],
  Q4: ["cortijo", "cortijos", "salinas", "camino"]
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
