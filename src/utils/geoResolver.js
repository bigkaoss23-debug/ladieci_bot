// ===============================================================
// geoResolver.js — Cascata geocoding edificio-level
// ===============================================================
// Entry point unico per risolvere "testo direccion" → {zona, lat, lon, durata, source}.
//
// Cascata 7-step (D1 in WORKPLAN):
//   1. geo_cache (direccion_key normalizzata)            ← hit → STOP
//   2. clientes (tel) se direccion_confermata_il         ← hit → STOP
//   3. Google Geocoding + Distance Matrix                ← stub in 3.2, impl in 3.3
//   4. Nominatim (OSM)                                   ← lat/lon only, durata=null
//   5. Photon (Komoot)                                   ← lat/lon only, durata=null
//   6. Keyword match (zona only, no lat/lon)
//   7. null → operatore decide
//
// Regole di caching:
//   - Step 3/4/5 trovano lat/lon → upsert geo_cache (source etichettato)
//   - Step 6 (keyword) NON viene cachato (ambiguo, no lat/lon)
//   - Edge case "no numero civico": NON cacha in geo_cache.
//     Il cliente conferma l'indirizzo solo dopo consegna riuscita (vedi 3.5).
//
// Feature flag GEO_PROVIDER (Supabase config):
//   - "google"        → step 3 attivo
//   - "shadow"        → step 3 attivo + log A/B in delivery_logs
//   - "fallback_only" → step 3 saltato (DEFAULT se config manca)
// ===============================================================

const { sbSelect, sbUpsert, sbUpdate } = require("./supabase");
const { direccionToCacheKey } = require("./helpers");
const {
  ZONE_DELIVERY, assegnaZonaDaCoord, assegnaZonaDaKeyword,
  coordInRoquetas, limpiaPerGeocode, haversineKm,
  RISTORANTE_LAT, RISTORANTE_LON, BUFFER_OPS_DRIVER_MIN
} = require("./zones");

// REFACTOR 14/05/2026: rimosso CONSEGNA_BUFFER_MIN locale. Ora `durata_andata_min`
// salvata in DB = GUIDA PURA (Google ETA o Haversine, no buffer). Il buffer operativo
// driver (parcheggio + citofono + scale + handoff) vive in zones.BUFFER_OPS_DRIVER_MIN
// ed è applicato dai consumatori (NuevoPedidoModal per hora promessa, simulateDriverSchedule
// per round-trip driver).
const GEOCODER_TIMEOUT_MS = 4000;

// ─── Util: fetch con timeout ──────────────────────────────────
async function fetchTimeout(url, opts = {}, ms = GEOCODER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── Step 1: cache lookup ─────────────────────────────────────
// Cache hit = riga completa (zona + lat + lon + durata). Se durata manca,
// trattiamo come cache miss → il flusso prosegue verso Google, che salverà
// il valore corretto (guida pura).
async function loadFromCache(direccion) {
  const key = direccionToCacheKey(direccion);
  if (!key || key.length < 5) return null;
  try {
    const rows = await sbSelect("geo_cache", `direccion_key=eq.${encodeURIComponent(key)}&limit=1`);
    const row = rows?.[0];
    if (!row || row.lat == null || row.lon == null || !row.zona) return null;
    if (row.durata_andata_min == null) return null; // cache incompleta → miss
    // Bump hit_count best-effort, non blocca.
    // PATCH, non upsert: `zona` è NOT NULL → INSERT-on-conflict fallirebbe sul path INSERT.
    sbUpdate("geo_cache",
      `direccion_key=eq.${encodeURIComponent(key)}`,
      { hit_count: (row.hit_count || 0) + 1 }
    ).catch(e => console.warn("[geoResolver] hit_count bump:", e?.message || e));
    // "Blindata" = almeno 1 ordine consegnato a questo indirizzo → autorità sopra Google.
    // n_ordini_consegnati viene incrementato in chiudiServizio (servizio.js) sugli ordini archiviati.
    const blindata = (row.n_ordini_consegnati || 0) >= 1;
    return {
      zona: row.zona, lat: row.lat, lon: row.lon,
      durataAndataMin: row.durata_andata_min ?? null,
      source: row.source || "nominatim",
      cached: true,
      blindata
    };
  } catch (e) {
    console.warn("[geoResolver] cache lookup error:", e?.message || e);
    return null;
  }
}

// ─── Step 2: cliente hit (solo se direccion confermata e key match) ─
// Hit valido = cliente con direccion confermata + lat/lon + durata. Se durata
// manca, trattiamo come miss → flusso prosegue verso Google.
async function loadFromCliente(tel, direccion) {
  if (!tel) return null;
  try {
    const rows = await sbSelect("clientes", `tel=eq.${encodeURIComponent(tel)}&limit=1`);
    const cli = rows?.[0];
    if (!cli) return null;
    if (!cli.direccion || !cli.direccion_confermata_il) return null;
    if (cli.zona_lat == null || cli.zona_lon == null || !cli.zona) return null;
    // L'indirizzo attuale deve corrispondere a quello confermato (cache-key match)
    if (direccionToCacheKey(cli.direccion) !== direccionToCacheKey(direccion)) return null;
    if (cli.durata_andata_min == null) return null; // dato incompleto → miss
    return {
      zona: cli.zona, lat: cli.zona_lat, lon: cli.zona_lon,
      durataAndataMin: cli.durata_andata_min,
      source: "cliente",
      cached: true
    };
  } catch (e) {
    console.warn("[geoResolver] cliente lookup error:", e?.message || e);
    return null;
  }
}

// ─── Step 3a: Google Geocoding API ────────────────────────────
// Restituisce {ok, lat, lon, locationType, error?}.
// Accetta SOLO location_type ROOFTOP o RANGE_INTERPOLATED.
// GEOMETRIC_CENTER (centro via) / APPROXIMATE (livello città) → rifiutati,
// cascata cade a Nominatim/Photon.
async function googleGeocode(direccion) {
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return { ok: false, error: "google_disabled" };

  const url = "https://maps.googleapis.com/maps/api/geocode/json"
    + "?address=" + encodeURIComponent(direccion)
    + "&components=" + encodeURIComponent("country:ES|locality:Roquetas de Mar")
    + "&region=es"
    + "&key=" + KEY;

  let res, data;
  try {
    res = await fetchTimeout(url);
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, error: "google_timeout" };
    return { ok: false, error: "google_error" };
  }
  if (!res.ok) return { ok: false, error: "google_error" };
  try { data = await res.json(); } catch (_) { return { ok: false, error: "google_error" }; }

  const status = data?.status;
  if (status === "OVER_QUERY_LIMIT" || status === "RESOURCE_EXHAUSTED") return { ok: false, error: "google_quota" };
  if (status === "REQUEST_DENIED")  return { ok: false, error: "google_disabled" };
  if (status === "ZERO_RESULTS")    return { ok: false, error: "google_zero_results" };
  if (status !== "OK")              return { ok: false, error: "google_error" };

  const r = data.results?.[0];
  const loc = r?.geometry?.location;
  const locationType = r?.geometry?.location_type;
  if (!loc || loc.lat == null || loc.lng == null) return { ok: false, error: "google_error" };

  // Filtro qualità: solo ROOFTOP / RANGE_INTERPOLATED sono affidabili per tempo
  if (locationType !== "ROOFTOP" && locationType !== "RANGE_INTERPOLATED") {
    return { ok: false, error: "google_low_quality" };
  }

  // partial_match=true significa che Google ha interpolato l'indirizzo (es. via inesistente
  // → match su via simile). Risultato non affidabile: scarta e lascia fare a Nominatim/Photon
  // o keyword. Senza questo check, "Calle Poseidón 3" finto può finire nel centro città.
  if (r.partial_match === true) {
    console.log(`[geoResolver] google partial_match scartato: "${direccion}" → ${r.formatted_address}`);
    return { ok: false, error: "google_partial_match" };
  }

  const lat = loc.lat, lon = loc.lng;
  if (!coordInRoquetas(lat, lon)) return { ok: false, error: "google_low_quality" };

  // Se la direccion contiene una locality esplicita (es. "Aguadulce"), verifica
  // che compaia nel formatted_address. Evita che il constraint locality:Roquetas
  // forzi un match su una via omonima dentro Roquetas ignorando la località reale.
  const localityInQuery = (() => {
    const cleaned = limpiaPerGeocode(direccion);
    if (!cleaned.includes(',')) return null;
    const after = cleaned.split(',').slice(1).join(',').trim();
    return (after.length >= 5 && /^[a-záéíóúüñ\s]+$/i.test(after)) ? after.toLowerCase() : null;
  })();
  if (localityInQuery) {
    const fa = (r.formatted_address || "").toLowerCase();
    if (!fa.includes(localityInQuery)) return { ok: false, error: "google_locality_mismatch" };
  }

  return { ok: true, lat, lon, locationType };
}

// ─── Step 3b: Google Distance Matrix ──────────────────────────
// Restituisce {ok, durataMin, error?}.
// durataMin = ceil(duration_in_traffic / 60) — GUIDA PURA.
// Il buffer ops (parcheggio/citofono/scale) vive in zones.BUFFER_OPS_DRIVER_MIN
// e viene aggiunto dai consumatori (NuevoPedidoModal, simulateDriverSchedule).
async function googleDistanceMatrix(lat, lon) {
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return { ok: false, error: "google_disabled" };

  const origin = `${RISTORANTE_LAT},${RISTORANTE_LON}`;
  const dest = `${lat},${lon}`;
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json"
    + "?origins=" + encodeURIComponent(origin)
    + "&destinations=" + encodeURIComponent(dest)
    + "&mode=driving"
    + "&departure_time=now"
    + "&traffic_model=best_guess"
    + "&region=es"
    + "&key=" + KEY;

  let res, data;
  try {
    res = await fetchTimeout(url);
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, error: "google_timeout" };
    return { ok: false, error: "google_error" };
  }
  if (!res.ok) return { ok: false, error: "google_error" };
  try { data = await res.json(); } catch (_) { return { ok: false, error: "google_error" }; }

  const status = data?.status;
  if (status === "OVER_QUERY_LIMIT") return { ok: false, error: "google_quota" };
  if (status === "REQUEST_DENIED")   return { ok: false, error: "google_disabled" };
  if (status !== "OK")               return { ok: false, error: "google_error" };

  const el = data.rows?.[0]?.elements?.[0];
  const elStatus = el?.status;
  if (elStatus === "ZERO_RESULTS" || elStatus === "NOT_FOUND") return { ok: false, error: "google_zero_results" };
  if (elStatus !== "OK") return { ok: false, error: "google_error" };

  // Preferiamo duration_in_traffic (live traffic) — fallback a duration se assente
  const secs = el.duration_in_traffic?.value ?? el.duration?.value;
  if (secs == null) return { ok: false, error: "google_error" };

  // Guida pura — il buffer ops vive in zones.BUFFER_OPS_DRIVER_MIN
  const durataMin = Math.ceil(secs / 60);
  return { ok: true, durataMin };
}

// ─── Step 4: Nominatim ────────────────────────────────────────
async function nominatimGeocode(direccion) {
  const headers = { "Accept-Language": "es", "User-Agent": "LaDieciBot/1.0 (pizzeria-orders)" };
  const cleaned = limpiaPerGeocode(direccion);
  const base = cleaned.replace(/\s+\d+\s*$/, "").trim();

  // Se la direccion contiene una locality esplicita (testo dopo virgola che non è
  // un codice appartamento, es. "Aguadulce"), la estraiamo per verificare che
  // Nominatim abbia effettivamente geocodificato QUELLA zona e non una via
  // omonima dentro Roquetas de Mar.
  let localityCheck = null;
  if (cleaned.includes(',')) {
    const afterComma = cleaned.split(',').slice(1).join(',').trim();
    // Usiamo come locality solo se è un nome proprio (alpha, ≥5 char, non solo numeri)
    if (afterComma.length >= 5 && /^[a-záéíóúüñ\s]+$/i.test(afterComma)) {
      localityCheck = afterComma.toLowerCase().trim();
    }
  }

  async function tryQuery(q) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
    try {
      const r = await fetchTimeout(url, { headers });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d?.length) return null;
      // Se abbiamo una locality esplicita, verifica che il display_name la contenga.
      // Evita che "paseo marítimo, Aguadulce" geocodifichi il Paseo Marítimo di Roquetas.
      if (localityCheck) {
        const dn = (d[0].display_name || "").toLowerCase();
        if (!dn.includes(localityCheck)) return null;
      }
      const lat = parseFloat(d[0].lat), lon = parseFloat(d[0].lon);
      if (!coordInRoquetas(lat, lon)) return null;
      return { lat, lon };
    } catch (_) { return null; }
  }

  // Tentativo 1: con numero civico
  let hit = await tryQuery(cleaned + ", Roquetas de Mar");
  // Tentativo 2: senza numero civico (se diverso)
  if (!hit && base !== cleaned && base.length >= 4) {
    hit = await tryQuery(base + ", Roquetas de Mar");
  }
  return hit;
}

// ─── Step 5: Photon ───────────────────────────────────────────
async function photonGeocode(direccion) {
  const cleaned = limpiaPerGeocode(direccion);
  const base = cleaned.replace(/\s+\d+\s*$/, "").trim();
  const bbox = "-2.67,36.72,-2.59,36.79";
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(base)}&limit=5&bbox=${bbox}`;

  const localityInQuery = (() => {
    if (!cleaned.includes(',')) return null;
    const after = cleaned.split(',').slice(1).join(',').trim();
    return (after.length >= 5 && /^[a-záéíóúüñ\s]+$/i.test(after)) ? after.toLowerCase() : null;
  })();

  try {
    const r = await fetchTimeout(url);
    if (!r.ok) return null;
    const d = await r.json();
    const hit = (d?.features || []).find(f => {
      if (!(f.properties?.city || "").toLowerCase().includes("roquetas")) return false;
      if (localityInQuery) {
        // Verifica che la locality esplicita compaia in almeno una proprietà Photon
        const props = Object.values(f.properties || {}).join(" ").toLowerCase();
        if (!props.includes(localityInQuery)) return false;
      }
      return true;
    });
    if (!hit?.geometry?.coordinates) return null;
    const [lon, lat] = hit.geometry.coordinates;
    if (!coordInRoquetas(lat, lon)) return null;
    return { lat, lon };
  } catch (_) { return null; }
}

// ─── Step 6: Keyword match (zona only) ────────────────────────
function keywordZona(direccion) {
  const z = assegnaZonaDaKeyword(direccion);
  return z ? z.id : null;
}

// ─── Persist post-resolve in geo_cache ────────────────────────
async function saveToCache(direccion, payload) {
  // payload: {zona, lat, lon, durataAndataMin, source}
  // Salviamo solo se abbiamo lat/lon E zona E direccion ha un numero civico.
  // "Calle Cuba" senza numero non va in cache (edge case C): il match per quel
  // cliente vive su clientes.direccion_confermata_il, non in geo_cache.
  if (!payload.lat || !payload.lon || !payload.zona) return;
  const hasNumber = /\d/.test(direccionToCacheKey(direccion));
  if (!hasNumber) return;
  const key = direccionToCacheKey(direccion);
  if (!key || key.length < 5) return;
  try {
    await sbUpsert("geo_cache", {
      direccion_key: key,
      direccion_orig: direccion,
      zona: payload.zona,
      lat: payload.lat,
      lon: payload.lon,
      durata_andata_min: payload.durataAndataMin ?? null,
      source: payload.source,
      updated_at: new Date().toISOString()
    }, "direccion_key");
  } catch (e) {
    console.warn("[geoResolver] saveToCache failed:", e?.message || e);
  }
}

// ─── Helper: zona + fuoriZona da lat/lon ──────────────────────
function classifyByCoord(lat, lon, direccion) {
  if (lat == null || lon == null) return { zona: null, fuoriZona: false };
  const zonaObj = assegnaZonaDaCoord(lat, lon);
  if (zonaObj) return { zona: zonaObj.id, fuoriZona: false };
  // lat/lon valido ma fuori da ogni poligono → tenta keyword come hint
  const kw = keywordZona(direccion);
  return { zona: kw, fuoriZona: !kw };
}

// ─── Helper: Haversine durata ANDATA pura (fallback se source != google) ─
function haversineDurataAndata(lat, lon) {
  if (lat == null || lon == null) return null;
  const ROAD_FACTOR = 1.70;
  const CAR_KMH = 20;
  const MIN_GIRO = 8;
  const distKm = haversineKm(RISTORANTE_LAT, RISTORANTE_LON, Number(lat), Number(lon));
  const tempoAndata = (distKm * ROAD_FACTOR / CAR_KMH) * 60;
  // Guida pura. Il buffer ops vive in zones.BUFFER_OPS_DRIVER_MIN
  return Math.max(MIN_GIRO, Math.ceil(tempoAndata));
}

// ─── Output shape ─────────────────────────────────────────────
function emptyResult(error = null) {
  return {
    zona: null, lat: null, lon: null,
    durataAndataMin: null, durataRitornoMin: null,
    source: null, cached: false, fuoriZona: false,
    googleMin: null, haversineMin: null,
    error
  };
}

function buildResult({ zona, lat, lon, durataAndataMin, source, cached, fuoriZona }) {
  // Ritorno = guida simmetrica all'andata (entrambe pure, no buffer).
  // Il BUFFER_OPS_DRIVER_MIN sta TRA andata e ritorno (tempo al cliente),
  // non dentro l'una o l'altra. Modellato in simulateDriverSchedule.
  // Se durataAndataMin = null (es. keyword), il ritorno è anche null.
  const ritorno = durataAndataMin ?? null;
  // Shadow A/B: registriamo sempre entrambe le stime quando possibile.
  // - haversineMin: sempre calcolata se abbiamo lat/lon (raw, no cap zona)
  // - googleMin:   popolato solo se la riga è di origine Google (anche via cache)
  const haversineMin = (lat != null && lon != null) ? haversineDurataAndata(lat, lon) : null;
  const googleMin = (source === "google" && durataAndataMin != null) ? durataAndataMin : null;
  return {
    zona: zona || null,
    lat: lat ?? null, lon: lon ?? null,
    durataAndataMin: durataAndataMin ?? null,
    durataRitornoMin: ritorno,
    source: source || null,
    cached: !!cached,
    fuoriZona: !!fuoriZona,
    googleMin, haversineMin,
    error: null
  };
}

// ─── Provider flag ────────────────────────────────────────────
async function getGeoProvider() {
  try {
    const rows = await sbSelect("config", "chiave=eq.GEO_PROVIDER&limit=1");
    const v = rows?.[0]?.valore;
    if (v === "google" || v === "shadow" || v === "fallback_only") return v;
  } catch (_) {}
  return "fallback_only"; // default sicuro
}

// ═══════════════════════════════════════════════════════════════
// MAIN: risolviIndirizzo
// ═══════════════════════════════════════════════════════════════
// Localities che non fanno parte delle nostre zone di consegna.
// Se il testo dell'indirizzo le contiene esplicitamente, blocchiamo il geocoding
// prima ancora di chiamare qualsiasi API — evita false positive da geocoder con
// dati misti (es. Photon etichetta "Paseo Marítimo, Roquetas" come Aguadulce).
const LOCALITA_FUORI_ZONA = ["aguadulce", "almería", "almeria", "vícar", "vicar",
  "la mojonera", "mojonera", "el ejido", "ejido", "adra", "berja", "dalías", "dalias"];

async function risolviIndirizzo({ direccion, tel = null, tipoConsegna = "DOMICILIO", forceRefresh = false } = {}) {
  if (tipoConsegna !== "DOMICILIO") return emptyResult();
  if (!direccion || String(direccion).trim().length < 5) return emptyResult("no_address");

  // Pre-flight: se l'indirizzo contiene una locality esplicitamente fuori zona → stop subito.
  // Più affidabile di qualsiasi geocoder, che può avere dati misti tra comuni limitrofi.
  const dirLower = String(direccion).toLowerCase();
  if (LOCALITA_FUORI_ZONA.some(loc => dirLower.includes(loc))) {
    console.log(`[geoResolver] pre-flight fuori zona: "${direccion}"`);
    return emptyResult("fuori_zona_localita");
  }

  const provider = await getGeoProvider();
  const googleEnabled = (provider === "google" || provider === "shadow");

  // ── Step 1: cache ─────────────────────────────────────────
  // Se cache "blindata" (>=1 ordine consegnato) → autorità assoluta, bypassa anche shadow.
  // forceRefresh su blindata è loggato come warn ma esegue lo stesso (escape hatch operatore).
  if (!forceRefresh) {
    const fromCache = await loadFromCache(direccion);
    if (fromCache) {
      return buildResult(fromCache);
    }
  } else {
    const peek = await loadFromCache(direccion);
    if (peek?.blindata) {
      console.warn("[geo_cache] WARN forceRefresh su cache blindata, direccion=", direccion);
    }
  }

  // ── Step 2: cliente ───────────────────────────────────────
  if (!forceRefresh) {
    const fromCliente = await loadFromCliente(tel, direccion);
    if (fromCliente) {
      return buildResult(fromCliente);
    }
  }

  // ── Step 3: Google (se attivo) ────────────────────────────
  if (googleEnabled) {
    const g = await googleGeocode(direccion);
    if (g.ok) {
      const { zona, fuoriZona } = classifyByCoord(g.lat, g.lon, direccion);
      const dm = await googleDistanceMatrix(g.lat, g.lon);
      const durataAndata = dm.ok ? dm.durataMin : haversineDurataAndata(g.lat, g.lon);
      const payload = { zona, lat: g.lat, lon: g.lon, durataAndataMin: durataAndata, source: "google" };
      if (zona && !fuoriZona) await saveToCache(direccion, payload);
      return buildResult({ ...payload, cached: false, fuoriZona });
    }
    // Google fallito → cascata continua su Nominatim
  }

  // ── Step 4: Nominatim ─────────────────────────────────────
  const nom = await nominatimGeocode(direccion);
  if (nom) {
    const { zona, fuoriZona } = classifyByCoord(nom.lat, nom.lon, direccion);
    const payload = {
      zona, lat: nom.lat, lon: nom.lon,
      durataAndataMin: null,   // Nominatim non dà tempo → Haversine ricalcola al consumo
      source: "nominatim"
    };
    if (zona && !fuoriZona) await saveToCache(direccion, payload);
    return buildResult({ ...payload, cached: false, fuoriZona });
  }

  // ── Step 5: Photon ────────────────────────────────────────
  const ph = await photonGeocode(direccion);
  if (ph) {
    const { zona, fuoriZona } = classifyByCoord(ph.lat, ph.lon, direccion);
    const payload = {
      zona, lat: ph.lat, lon: ph.lon,
      durataAndataMin: null,
      source: "photon"
    };
    if (zona && !fuoriZona) await saveToCache(direccion, payload);
    return buildResult({ ...payload, cached: false, fuoriZona });
  }

  // ── Step 6: Keyword (zona only, no lat/lon, no cache) ─────
  const kwZona = keywordZona(direccion);
  if (kwZona) {
    return buildResult({
      zona: kwZona, lat: null, lon: null,
      durataAndataMin: null, source: "keyword", cached: false, fuoriZona: false
    });
  }

  // ── Step 7: null ──────────────────────────────────────────
  return emptyResult();
}

module.exports = {
  risolviIndirizzo,
  // esposte per orchestrator/test
  loadFromCache, loadFromCliente, saveToCache,
  nominatimGeocode, photonGeocode, keywordZona,
  haversineDurataAndata,
  getGeoProvider
};
