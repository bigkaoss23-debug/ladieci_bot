// ===============================================================
// resolveDeliveryFieldsReadOnly.js — geo resolver READ-ONLY / NO-CACHE
// ===============================================================
// Gemello read-only di previewTiming.resolveDeliveryFields, pensato per la
// PREVIEW/planner (previewOrderPlanner). Risolve zona/durata/coords riusando
// SOLO le primitive di lettura del resolver live, senza MAI persistere su
// geo_cache.
//
// Differenze rispetto al resolver live (risolviIndirizzo):
//   - Nessun persist su cache: niente upsert su geo_cache.
//   - NON incrementa hit_count (nessun update geo_cache su cache hit).
//   - NON usa il path Google: in live ogni hit Google fresco PERSISTE in cache
//     (geoResolver.js:605) → incompatibile con la garanzia zero-write. La
//     precisione Google in preview resta un'estensione futura (esporre i due
//     helper Google + iniettarli), non un write nascosto qui.
//   - Cascade read-only: geo_cache (solo lettura) → clientes (solo lettura)
//     → Nominatim → Photon → keyword → unresolved.
//
// Output: stessa shape di resolveDeliveryFields + `confidence`. Mai PII
// (nessun nome/tel/indirizzo completo) né stacktrace nei warning.
// ===============================================================
"use strict";

const supa = require("../utils/supabase");
const { direccionToCacheKey } = require("../utils/helpers");
// Primitive di SOLA LETTURA riusate dal resolver live. Volutamente NON
// importiamo risolviIndirizzo / loadFromCache / saveToCache / enrichDurataFromGoogle:
// quei path scrivono geo_cache.
const geoLive = require("../utils/geoResolver");
const { ZONE_DELIVERY, assegnaZonaDaCoord, assegnaZonaDaKeyword } = require("../utils/zones");

// Allineato a geoResolver.LOCALITA_FUORI_ZONA (costante, non logica live).
const LOCALITA_FUORI_ZONA = [
  "aguadulce", "almería", "almeria", "vícar", "vicar", "la mojonera",
  "mojonera", "el ejido", "ejido", "adra", "berja", "dalías", "dalias",
];

// ─── Lettura geo_cache SENZA side-effect ──────────────────────────────────
// Stesso match esatto di loadFromCache (direccion_key=eq), ma SENZA il bump
// hit_count: nessuna scrittura. Solo sbSelect (read).
async function readCacheReadOnly(sbSelect, direccion) {
  const key = direccionToCacheKey(direccion);
  if (!key || key.length < 5) return null;
  let rows;
  try {
    rows = await sbSelect("geo_cache", `direccion_key=eq.${encodeURIComponent(key)}&limit=1`);
  } catch (_) {
    return null;
  }
  const row = rows && rows[0];
  if (row && row.lat != null && row.lon != null && row.zona) {
    const blindata = (row.n_ordini_consegnati || 0) >= 1;
    return {
      zona: row.zona,
      lat: row.lat,
      lon: row.lon,
      durataAndataMin: row.durata_andata_min != null ? row.durata_andata_min : null,
      source: row.source || "nominatim",
      cached: true,
      blindata,
      fuoriZona: false,
    };
  }
  return null;
}

// ─── Zona da coordinate (read-only, mirror di classifyByCoord live) ───────
function classifyByCoord(lat, lon, direccion) {
  if (lat == null || lon == null) return { zona: null, fuoriZona: false };
  const z = assegnaZonaDaCoord(lat, lon);
  if (z) return { zona: z.id, fuoriZona: false };
  const kw = assegnaZonaDaKeyword(direccion);
  return { zona: kw ? kw.id : null, fuoriZona: !kw };
}

// ─── Cascade di SOLA LETTURA ──────────────────────────────────────────────
async function resolveReadOnly({ sbSelect, deps, direccion, tel }) {
  // 1. geo_cache (read-only, no hit_count bump, no fallback writes)
  const fromCache = await readCacheReadOnly(sbSelect, direccion);
  if (fromCache) return fromCache;

  // 2. clientes (loadFromCliente è read-only: solo sbSelect)
  const loadFromCliente = deps.loadFromCliente || geoLive.loadFromCliente;
  try {
    const fromCliente = await loadFromCliente(tel || null, direccion);
    if (fromCliente) return { ...fromCliente, fuoriZona: false };
  } catch (_) { /* read-only safe */ }

  // 3. Nominatim (geocoder esterno, nessuna scrittura DB)
  const nominatimGeocode = deps.nominatimGeocode || geoLive.nominatimGeocode;
  try {
    const nom = await nominatimGeocode(direccion);
    if (nom) {
      const { zona, fuoriZona } = classifyByCoord(nom.lat, nom.lon, direccion);
      return { zona, lat: nom.lat, lon: nom.lon, durataAndataMin: null, source: "nominatim", cached: false, fuoriZona };
    }
  } catch (_) { /* continua cascade */ }

  // 4. Photon (geocoder esterno, nessuna scrittura DB)
  const photonGeocode = deps.photonGeocode || geoLive.photonGeocode;
  try {
    const ph = await photonGeocode(direccion);
    if (ph) {
      const { zona, fuoriZona } = classifyByCoord(ph.lat, ph.lon, direccion);
      return { zona, lat: ph.lat, lon: ph.lon, durataAndataMin: null, source: "photon", cached: false, fuoriZona };
    }
  } catch (_) { /* continua cascade */ }

  // 5. Keyword (zona only, no coords)
  const kw = assegnaZonaDaKeyword(direccion);
  if (kw) return { zona: kw.id, lat: null, lon: null, durataAndataMin: null, source: "keyword", cached: false, fuoriZona: false };

  return null;
}

// ─── Confidence derivata dalla provenienza ────────────────────────────────
function deriveConfidence(geoSource, resolved) {
  if (!resolved || !geoSource) return "none";
  if (resolved.blindata) return "high";
  const s = String(geoSource);
  if (s.includes("google") || s === "cliente") return "high";
  if (s === "nominatim" || s === "photon" || s.includes("cache")) return "medium";
  if (s === "haversine") return "low";
  if (s === "keyword" || s === "zona_fallback") return "low";
  return "low";
}

// PII-free snapshot del resolved (mai nome/tel/indirizzo).
function safeResolved(resolved) {
  if (!resolved) return null;
  return {
    zona: resolved.zona ?? null,
    lat: resolved.lat ?? null,
    lon: resolved.lon ?? null,
    durata_andata_min: resolved.durataAndataMin ?? null,
    source: resolved.source ?? null,
    cached: !!resolved.cached,
    blindata: !!resolved.blindata,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN: resolveDeliveryFieldsReadOnly(params, deps)
// params: { direccion, tel, zona_manuale, zona }
// deps  : { sbSelect?, loadFromCliente?, nominatimGeocode?, photonGeocode? }
// ═══════════════════════════════════════════════════════════════════════════
async function resolveDeliveryFieldsReadOnly(params = {}, deps = {}) {
  const warnings = [];
  const out = {
    zona: null,
    zona_lat: null,
    zona_lon: null,
    durata_andata_min: null,
    durata_google_min: null,
    durata_haversine_min: null,
    geo_source: null,
    confidence: "none",
    warnings,
    resolved: null,
  };

  const sbSelect = deps.sbSelect || supa.sbSelect;
  const direccion = params.direccion;

  if (!direccion || String(direccion).trim().length < 5) {
    warnings.push({ code: "no_direccion", message: "Falta direccion para domicilio" });
    return out;
  }

  // Pre-flight località fuori zona: niente geocoder, niente eco dell'indirizzo.
  const dirLower = String(direccion).toLowerCase();
  if (LOCALITA_FUORI_ZONA.some((loc) => dirLower.includes(loc))) {
    warnings.push({ code: "fuori_zona_localita", message: "Direccion fuera de zona de reparto" });
    return out;
  }

  let resolved = null;
  try {
    resolved = await resolveReadOnly({ sbSelect, deps, direccion, tel: params.tel });
  } catch (_) {
    warnings.push({ code: "resolve_error", message: "No se pudo resolver la direccion" });
  }
  out.resolved = safeResolved(resolved);

  // ── Zona: resolver autoritativo; override manuale solo se esplicito. ──
  let zona = resolved?.zona || null;
  let zonaLat = resolved?.lat ?? null;
  let zonaLon = resolved?.lon ?? null;
  if (params.zona_manuale === true && params.zona) {
    if (params.zona !== zona) {
      warnings.push({ code: "zona_override_manual", message: `Zona forzada por operador: ${params.zona}` });
      zonaLat = null;
      zonaLon = null;
    }
    zona = params.zona;
  } else if (!zona) {
    const kw = assegnaZonaDaKeyword(direccion);
    if (kw) {
      zona = kw.id;
      warnings.push({ code: "zona_keyword", message: `Zona por keyword (sin geocode): ${kw.id}` });
    } else {
      warnings.push({ code: "zona_desconocida", message: "No se pudo asignar zona" });
    }
  }

  const zonaObj = ZONE_DELIVERY.find((z) => z.id === zona) || null;

  // ── Durate: solo lettura/calcolo, nessuna persistenza. ──
  const haversineMin = (zonaLat != null && zonaLon != null)
    ? geoLive.haversineDurataAndata(zonaLat, zonaLon)
    : null;
  out.durata_haversine_min = haversineMin;

  let geoSource = resolved?.source || null;
  const srcHasGoogle = typeof geoSource === "string" && geoSource.includes("google");
  out.durata_google_min = (srcHasGoogle && resolved?.durataAndataMin != null) ? resolved.durataAndataMin : null;

  // durata scelta: resolver/cache → haversine → fallback zona.
  let durataAndataMin = resolved?.durataAndataMin ?? null;
  if (durataAndataMin == null) {
    if (haversineMin != null) {
      durataAndataMin = haversineMin;
      if (!geoSource) geoSource = "haversine";
      warnings.push({ code: "durata_estimada", message: "Duración estimada (haversine): Google no disponible" });
    } else if (zonaObj) {
      durataAndataMin = zonaObj.tempoGiro;
      if (!geoSource) geoSource = "zona_fallback";
      warnings.push({ code: "durata_fallback_zona", message: `Duración por defecto de zona ${zona} (${zonaObj.tempoGiro} min)` });
    }
  }

  out.zona = zona;
  out.zona_lat = zonaLat;
  out.zona_lon = zonaLon;
  out.durata_andata_min = durataAndataMin;
  out.geo_source = geoSource;
  out.confidence = deriveConfidence(geoSource, resolved);
  return out;
}

module.exports = { resolveDeliveryFieldsReadOnly };
