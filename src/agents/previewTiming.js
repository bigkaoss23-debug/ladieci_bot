// ===============================================================
// previewTiming.js — Step 1 anti-cerotto (2026-06-01)
// ===============================================================
// Endpoint autoritativo `previewOrderTiming`: fonte UNICA per timing
// delivery destinata alla dashboard/operatore.
//
// Principio (decisione architetturale audit anti-cerotto):
//   - Il backend è la fonte della verità. Il frontend raccoglie input
//     e mostra; NON calcola hora/durata/zona/forno_out/slot.
//   - Questo modulo NON si fida di valori delivery calcolati dal client:
//     risolve l'indirizzo via risolviIndirizzo (stesso engine del bot),
//     ricava durata/zona/source server-side, calcola forno_out server-side,
//     legge ordenes activas live da Supabase e i giro facts dalla Projection
//     canonica (Planner W4 — giroProjectionReader/giroProjectionPort, MAI
//     ordenes.manual_giro_id / manual_giros raw).
//
// Regole prodotto (FASE 4):
//   - Ordine manuale: `hora` richiesta dall'operatore è una PREFERENZA.
//     Il backend NON la riscrive mai silenziosamente. `hora_proposta`
//     resta SEMPRE = `hora_richiesta`.
//   - forno_out = hora − durata_andata_min (DOMICILIO), = hora (RITIRO).
//     Nessun pavimento driver: gli ordini manuali non slittano (coerente
//     con backend commit 7ead83e).
//   - Se lo schedule driver è in conflitto, l'eventuale orario alternativo
//     compare come `suggested_hora` (NON sostituisce hora_proposta) e il
//     conflitto è esposto in `driver.has_conflict` + warnings.
//
// READ-ONLY: nessuna scrittura su DB. (risolviIndirizzo può fare backfill
// best-effort sulla geo_cache, ma è parte del suo contratto autoritativo.)
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const { risolviIndirizzo } = require("../utils/geoResolver");
const {
  calcolaFornoOut,
  proposeForNewOrder,
  assegnaZonaDaKeyword,
  ZONE_DELIVERY,
} = require("../utils/zones");
// W4 — canonical read boundary (Planner W3 giro_projection_v1). previewOrderTiming's
// giro-compatibility advisory now sources from the Giro Authority projection, never
// from ordenes.manual_giro_id / manual_giros / salida_ref / dissolved_at directly.
const { readGiroProjection } = require("../core/delivery/giroProjectionReader");
const { findCompatibleGiroFromProjection } = require("../core/delivery/giroProjectionPort");

// ── Helpers tempo (wrap 24h: mai "24:08"/"25:..") ────────────────
const toH = (m) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Ora di Madrid in minuti dalla mezzanotte. Serve a proposeForNewOrder per
// il pavimento "minPart" dello slot-search: senza, ricade su new Date() del
// server (TZ Railway = UTC) → buchi calcolati con sfasamento. Stessa logica
// di agentOrdini.nowMadridMinutes. Null se Intl non disponibile.
function nowMadridMinutes() {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  } catch (_) {
    return null;
  }
}

// Shape di output stabile — il frontend (Step 2) leggerà questi campi as-is.
function buildResult(over = {}) {
  return {
    ok: true,
    tipo_consegna: "DOMICILIO",
    direccion: null,
    zona: null,
    zona_lat: null,
    zona_lon: null,
    durata_andata_min: null,
    durata_google_min: null,
    durata_haversine_min: null,
    geo_source: null,
    hora_richiesta: null,
    hora_proposta: null,
    suggested_hora: null,
    forno_out: null,
    warnings: [],
    driver: { has_conflict: false, message: null },
    giro: { suggested: false, manual_giro_id: null, orders: [] },
    ...over,
  };
}

// ── Risoluzione delivery autoritativa (server-side) ──────────────
// FONTE UNICA usata sia da previewOrderTiming sia da creaOrdine/modificaOrdine.
// Risolve l'indirizzo via risolviIndirizzo (stesso engine del bot, include
// l'enrich Google) e ricava zona/durata/source. NON si fida di valori geo
// calcolati dal client. Ritorna anche `warnings` (advisory) e l'oggetto
// `resolved` grezzo per chi ne avesse bisogno.
//
// params: { direccion, tel, zona_manuale, zona, force_refresh }
async function resolveDeliveryFields(params = {}) {
  const warnings = [];
  const out = {
    zona: null,
    zona_lat: null,
    zona_lon: null,
    durata_andata_min: null,
    durata_google_min: null,
    durata_haversine_min: null,
    geo_source: null,
    warnings,
    resolved: null,
  };

  let resolved = null;
  if (params.direccion) {
    try {
      resolved = await risolviIndirizzo({
        direccion: params.direccion,
        tel: params.tel || null,
        tipoConsegna: "DOMICILIO",
        forceRefresh: !!params.force_refresh,
      });
    } catch (e) {
      warnings.push({ code: "resolve_error", message: "No se pudo resolver la dirección" });
    }
  } else {
    warnings.push({ code: "no_direccion", message: "Falta dirección para DOMICILIO" });
  }
  out.resolved = resolved;

  // Zona: resolver autoritativo; override manuale solo se esplicito.
  let zona = resolved?.zona || null;
  let zonaLat = resolved?.lat ?? null;
  let zonaLon = resolved?.lon ?? null;
  if (params.zona_manuale === true && params.zona) {
    if (params.zona !== zona) {
      warnings.push({
        code: "zona_override_manual",
        message: `Zona forzada por operador: ${params.zona}`,
      });
      // Coords del resolver appartengono a un'altra zona → scartate per non
      // falsare l'haversine sul fallback durata.
      zonaLat = null;
      zonaLon = null;
    }
    zona = params.zona;
  } else if (!zona && params.direccion) {
    const kw = assegnaZonaDaKeyword(params.direccion);
    if (kw) {
      zona = kw.id;
      warnings.push({ code: "zona_keyword", message: `Zona por keyword (sin geocode): ${kw.id}` });
    } else {
      warnings.push({ code: "zona_desconocida", message: "No se pudo asignar zona" });
    }
  }

  const zonaObj = ZONE_DELIVERY.find((z) => z.id === zona) || null;

  // Durate: solo server-side.
  out.durata_google_min = resolved?.googleMin ?? null;
  out.durata_haversine_min = resolved?.haversineMin ?? null;
  let geoSource = resolved?.source || null;

  // durata scelta: resolver (Google/cache) → haversine → fallback zona.
  let durataAndataMin = resolved?.durataAndataMin ?? null;
  if (durataAndataMin == null) {
    if (out.durata_haversine_min != null) {
      durataAndataMin = out.durata_haversine_min;
      if (!geoSource) geoSource = "haversine";
      warnings.push({
        code: "durata_estimada",
        message: "Duración estimada (haversine): Google no disponible",
      });
    } else if (zonaObj) {
      durataAndataMin = zonaObj.tempoGiro;
      if (!geoSource) geoSource = "zona_fallback";
      warnings.push({
        code: "durata_fallback_zona",
        message: `Duración por defecto de zona ${zona} (${zonaObj.tempoGiro} min)`,
      });
    }
  }

  out.zona = zona;
  out.zona_lat = zonaLat;
  out.zona_lon = zonaLon;
  out.durata_andata_min = durataAndataMin;
  out.geo_source = geoSource;
  return out;
}

// ── Endpoint principale ──────────────────────────────────────────
// params: { tipo_consegna, direccion, tel, hora, items, zona_manuale, zona, force_refresh }
async function previewOrderTiming(params = {}) {
  const tipoConsegna = params.tipo_consegna || "DOMICILIO";
  const horaRichiesta = params.hora || null;
  const warnings = [];

  // ── RITIRO: nessuna risoluzione delivery. forno_out = hora. ──────
  if (tipoConsegna !== "DOMICILIO") {
    const fo = calcolaFornoOut({ tipoConsegna, hora: horaRichiesta, durataAndataMin: null });
    return buildResult({
      tipo_consegna: tipoConsegna,
      direccion: params.direccion || null,
      hora_richiesta: horaRichiesta,
      hora_proposta: horaRichiesta,
      forno_out: fo.forno_out,
    });
  }

  // ── DOMICILIO: risoluzione indirizzo autoritativa (server-side). ──
  // NON usiamo durata/zona dal client come verità. Fonte unica condivisa
  // con creaOrdine/modificaOrdine: resolveDeliveryFields.
  const geo = await resolveDeliveryFields(params);
  warnings.push(...geo.warnings);
  const zona = geo.zona;
  const zonaLat = geo.zona_lat;
  const zonaLon = geo.zona_lon;
  const durataAndataMin = geo.durata_andata_min;
  const durataGoogleMin = geo.durata_google_min;
  const durataHaversineMin = geo.durata_haversine_min;
  const geoSource = geo.geo_source;

  // ── forno_out server-side. Regola manuale: hora − durata, sin slittamento. ──
  const fo = calcolaFornoOut({
    tipoConsegna: "DOMICILIO",
    hora: horaRichiesta,
    durataAndataMin,
    driverLiberoMin: 0,
  });

  // ── Ordenes activas (server-side) + Giro Authority projection (W4 canonical). ──
  let activeOrders = [];
  try {
    activeOrders =
      (await sbSelect(
        "ordenes",
        "tipo_consegna=eq.DOMICILIO&estado=not.in.(RETIRADO,COMPLETADO,COMPLETATO)"
      )) || [];
  } catch (e) {
    console.warn("[previewOrderTiming] read ordenes failed:", e?.message || e);
  }
  // W4: the ONLY source of giro facts. readGiroProjection() fails closed to null
  // on any scope/RPC/transport failure; findCompatibleGiroFromProjection then
  // treats that as PROJECTION_MISSING (no compatible giro), never a raw fallback.
  let giroProjection = null;
  try {
    giroProjection = await readGiroProjection();
  } catch (e) {
    console.warn("[previewOrderTiming] read giro projection failed:", e?.message || e);
  }

  // ── Conflitto driver / orario alternativo (advisory, non sposta hora). ──
  let driverConflict = false;
  let driverMessage = null;
  let suggestedHora = null;

  if (zona && horaRichiesta) {
    const nowMin = nowMadridMinutes();
    let propose = null;
    try {
      propose = proposeForNewOrder(
        activeOrders,
        {
          hora: horaRichiesta,
          zona,
          zona_lat: zonaLat,
          zona_lon: zonaLon,
          durata_andata_min: durataAndataMin,
        },
        nowMin != null ? { nowMin } : {}
      );
    } catch (e) {
      console.warn("[previewOrderTiming] proposeForNewOrder failed:", e?.message || e);
    }

    if (propose) {
      if (propose.outOfServiceWindow) {
        // Ordine manuale dopo l'orario di servizio: permesso (1be135b), solo avviso soft.
        warnings.push({
          code: "after_hours",
          message: propose.motivo || "Fuera del horario de servicio habitual",
        });
      } else if (propose.ok === false) {
        driverConflict = true;
        driverMessage = propose.motivo || "Driver ocupado en la hora pedida";
        if (Number.isFinite(propose.consegnaPropostaMin)) {
          suggestedHora = toH(propose.consegnaPropostaMin);
        }
        warnings.push({ code: "driver_conflict", message: driverMessage });
      }
    }
  }

  // ── Giro compatibile (advisory) — canonical Projection, never raw manual_giro_id. ──
  const ordersById = new Map((activeOrders || []).map((o) => [o.id, o]));
  const compatible = findCompatibleGiroFromProjection(giroProjection, zona, ordersById);

  return buildResult({
    tipo_consegna: "DOMICILIO",
    direccion: params.direccion || null,
    zona,
    zona_lat: zonaLat,
    zona_lon: zonaLon,
    durata_andata_min: durataAndataMin,
    durata_google_min: durataGoogleMin,
    durata_haversine_min: durataHaversineMin,
    geo_source: geoSource,
    hora_richiesta: horaRichiesta,
    hora_proposta: horaRichiesta, // MAI riscritta silenziosamente
    suggested_hora: suggestedHora,
    forno_out: fo.forno_out,
    warnings,
    driver: { has_conflict: driverConflict, message: driverMessage },
    // W4 compat alias: manual_giro_id is the giro's EFFECTIVE id from the canonical
    // Projection (TB-1/TB-1A). Never the raw ordenes.manual_giro_id column — this
    // reader doesn't touch it. Removal wave: W7 (see MIGRATION_MANIFEST.md row 130).
    giro: {
      suggested: !!compatible,
      manual_giro_id: compatible?.giro_id || null,
      orders: (compatible?.effective_members || []).map((m) => m.order_id),
    },
  });
}

module.exports = { previewOrderTiming, resolveDeliveryFields, nowMadridMinutes };
