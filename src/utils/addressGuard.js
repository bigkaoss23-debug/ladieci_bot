// WA-ADDRESS-GUARD-01 — Address quality guard per delivery WhatsApp.
//
// Verifica che la `direccion` estratta dall'IA sia abbastanza concreta da
// essere geocodata in sicurezza. Se è qualitativa/vaga ("cerca del puerto",
// "hotel cerca de la playa", "mi casa") il chiamante DEVE saltare il
// resolver e chiedere indirizzo completo, per evitare:
//  - hit imprecisi da Nominatim/Photon su query libere
//  - geo_cache contaminata con voci pericolose
//  - ordini delivery automatici su descrizioni non postali
//
// Il guard è pensato per il flusso WhatsApp automatico. L'operatore
// manuale può sempre forzare (zona_manuale=true) bypassando questo check.

// Pattern qualitativi sempre bloccanti, indipendentemente dal resto.
const VAGUE_PHRASE_RE = /\b(cerca\s+(?:de|del|de\s+la|de\s+los|de\s+las)|al\s+lado\s+(?:de|del|de\s+la)|junto\s+(?:a|al|a\s+la)|enfrente\s+(?:de|del|de\s+la)|detr[áa]s\s+(?:de|del|de\s+la)|donde\s+siempre|por\s+aqu[íi]|por\s+ah[íi]|por\s+el\s+centro|por\s+la\s+zona)\b/i;

// Riferimenti personali ("mi casa", "mi piso") senza valore postale.
const PERSONAL_REF_RE = /\b(mi\s+casa|mi\s+piso|mi\s+domicilio|mi\s+direcci[óo]n|mi\s+sitio)\b/i;

// Prefissi via riconosciuti come ancoraggio postale.
const STREET_PREFIX_RE = /^\s*(calle|c\/|c\.|avenida|avda\.?|av\.?|paseo|pso\.?|camino|cmno\.?|plaza|pza\.?|pl\.?|carretera|ctra\.?|travesi[áa]|glorieta|ronda|bulevar|boulevard|urbanizaci[óo]n|urb\.?)\b/i;

// Località/POI generici che, da soli, non identificano un indirizzo.
const LOCALITY_POI_RE = /\b(puerto|playa|hotel|centro|mercadona|carrefour|lidl|aguadulce|roquetas|el\s+parador|zona|barrio|urbanizaci[óo]n)\b/i;

// Numero civico: cifra "libera" nel testo (la presenza di una cifra
// è condizione necessaria-ma-non-sufficiente per dire "concreto").
const NUMBER_RE = /\d/;

/**
 * @param {string|null|undefined} direccion
 * @returns {{ ok: boolean, motivo?: string }}
 *   ok=true se l'indirizzo è abbastanza concreto da passare al geocoder.
 *   ok=false + motivo descrittivo altrimenti.
 */
function isDireccionConcretaParaDelivery(direccion) {
  if (direccion == null) return { ok: false, motivo: "vacia" };
  const raw = String(direccion).trim();
  if (!raw) return { ok: false, motivo: "vacia" };

  // 1) Frasi qualitative — bloccano sempre, anche se c'è un nome via.
  //    Es. "Calle Mayor cerca del puerto" → vaga.
  if (VAGUE_PHRASE_RE.test(raw)) return { ok: false, motivo: "frase_vaga" };
  if (PERSONAL_REF_RE.test(raw)) return { ok: false, motivo: "referencia_personal" };

  const hasStreetPrefix = STREET_PREFIX_RE.test(raw);
  const hasNumber = NUMBER_RE.test(raw);

  // 2) Indirizzi che hanno sia prefisso via sia numero passano,
  //    anche se contengono parole tipo "playa" (es. "Avenida Playa Serena 12").
  if (hasStreetPrefix && hasNumber) return { ok: true };

  // 3) Prefisso via senza numero — borderline ma accettabile (street-level
  //    cache è prevista come fallback dal resolver).
  if (hasStreetPrefix) return { ok: true };

  // 4) Numero senza prefisso esplicito — comune in ES, es. "Antonio Machado 69".
  //    Accettabile se non è solo una località + numero di cose
  //    ("Roquetas 10000 habitantes" è patologico ma non realistico via WA).
  if (hasNumber) {
    // Se l'unico contenuto rilevante è località/POI + numero, comunque concreto?
    // Esempio "puerto 10" non identifica un indirizzo. Solo se NON c'è
    // alcun token "via-like" e c'è solo POI generico, blocchiamo.
    if (LOCALITY_POI_RE.test(raw) && raw.split(/\s+/).length <= 3) {
      return { ok: false, motivo: "solo_localidad_o_poi_con_numero" };
    }
    return { ok: true };
  }

  // 5) Né prefisso né numero — quasi sempre vago.
  if (LOCALITY_POI_RE.test(raw)) return { ok: false, motivo: "solo_localidad_o_poi" };
  return { ok: false, motivo: "sin_via_y_numero" };
}

module.exports = { isDireccionConcretaParaDelivery };
