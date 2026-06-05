// WA-ADDRESS-GUARD-01 — Address quality guard per delivery WhatsApp.
// Hardened in WHATSAPP-ADDRESS-GUARD-HARDENING-51 (2026-06-05).
//
// Verifica che la `direccion` estratta dall'IA sia abbastanza concreta da
// essere geocodata e consegnata in AUTOMATICO in sicurezza. Se è
// qualitativa/vaga ("cerca del puerto", "hotel sol y playa 5", "bloque 5")
// il chiamante DEVE saltare il resolver e mandare l'ordine a operatore
// (Preguntas), per evitare:
//  - hit imprecisi da Nominatim/Photon su query libere
//  - geo_cache contaminata con voci pericolose
//  - rider mandato nel posto sbagliato su descrizioni non postali
//
// FILOSOFIA: prudenza. In dubbio si preferisce un FALSO NEGATIVO (chiedere
// conferma indirizzo) piuttosto che accettare un delivery ambiguo. Per
// passare in automatico serve di norma un ANCORAGGIO VIA esplicito
// (calle/avenida/plaza/...) + un NUMERO civico. L'unica eccezione è il
// classico "Nombre Apellido <numero>" spagnolo, accettato solo se corto e
// privo di parole-POI vaghe.
//
// Il guard è pensato per il flusso WhatsApp automatico. L'operatore
// manuale può sempre forzare (zona_manuale=true) bypassando questo check.

// Pattern qualitativi sempre bloccanti, indipendentemente dal resto.
const VAGUE_PHRASE_RE = /\b(cerca\s+(?:de|del|de\s+la|de\s+los|de\s+las)|al\s+lado\s+(?:de|del|de\s+la)|junto\s+(?:a|al|a\s+la)|enfrente\s+(?:de|del|de\s+la)|detr[áa]s\s+(?:de|del|de\s+la)|donde\s+siempre|por\s+aqu[íi]|por\s+ah[íi]|por\s+el\s+centro|por\s+la\s+zona)\b/i;

// Riferimenti personali ("mi casa", "mi piso") senza valore postale.
const PERSONAL_REF_RE = /\b(mi\s+casa|mi\s+piso|mi\s+domicilio|mi\s+direcci[óo]n|mi\s+sitio)\b/i;

// Prefissi via riconosciuti come ancoraggio postale (devono aprire la stringa).
const STREET_PREFIX_RE = /^\s*(?:calle|c\/|c\.|avenida|avda\.?|av\.?|paseo|pso\.?|camino|cmno\.?|plaza|pza\.?|pl\.?|carretera|ctra\.?|travesi[áa]|glorieta|ronda|bulevar|boulevard|urbanizaci[óo]n|urb\.?)(?=$|[\s,.\d])/i;

// Località / POI generici che, in assenza di un prefisso via esplicito, NON
// identificano un indirizzo postale sicuro. La loro presenza (con o senza
// numero) manda a operatore.
const LOCALITY_POI_RE = /\b(puerto|playa|hotel|hostal|bar|restaurante|cafeter[íi]a|centro|mercadona|carrefour|lidl|supermercado|aguadulce|roquetas|el\s+parador|zona|barrio|residencia|residencial|edificio|bloque|portal|piso|apartamento|apto|marina|evershine)\b/i;

// Presenza di una qualsiasi cifra (necessaria-ma-non-sufficiente).
const NUMBER_RE = /\d/;

// Token "numero civico" plausibile: 1-4 cifre con eventuale lettera (12, 110, 8B).
const CIVIC_NUMBER_TOKEN_RE = /^\d{1,4}[a-z]?$/i;

// Token "nome" alfabetico (≥3 lettere), per riconoscere "Antonio Machado 69".
const NAME_WORD_RE = /^[a-záéíóúñ.]{3,}$/i;

/**
 * @param {string|null|undefined} direccion
 * @returns {{ ok: boolean, motivo?: string }}
 *   ok=true se l'indirizzo è abbastanza concreto da passare al geocoder in
 *   automatico. ok=false + motivo descrittivo altrimenti (→ operatore).
 */
function isDireccionConcretaParaDelivery(direccion) {
  if (direccion == null) return { ok: false, motivo: "vacia" };
  const raw = String(direccion).trim();
  if (!raw) return { ok: false, motivo: "vacia" };

  // 1) Frasi qualitative / riferimenti personali — bloccano sempre, anche se
  //    contengono un nome via. Es. "Calle Mayor cerca del puerto" → vaga.
  if (VAGUE_PHRASE_RE.test(raw)) return { ok: false, motivo: "frase_vaga" };
  if (PERSONAL_REF_RE.test(raw)) return { ok: false, motivo: "referencia_personal" };

  const hasStreetPrefix = STREET_PREFIX_RE.test(raw);
  const hasNumber = NUMBER_RE.test(raw);

  // 2) Percorso sicuro principale: prefisso via esplicito + numero civico.
  //    Le parole-POI ("playa", "portal") sono tollerate qui perché il prefisso
  //    via ancora l'indirizzo: "Avenida Playa Serena 12", "Calle Real 8 portal 2".
  if (hasStreetPrefix && hasNumber) return { ok: true };

  // 3) Prefisso via SENZA numero — non basta per l'automatico.
  //    Es. "calle", "avenida sin numero". → operatore.
  if (hasStreetPrefix) return { ok: false, motivo: "sin_numero" };

  // 4) Nessun prefisso via + parola POI/località → blocco prudente.
  //    Copre "hotel sol y playa 5", "bloque 5", "portal 3", "piso 2",
  //    "roquetas 12", "marina 4", "evershine 7", "playa serena 5", "puerto 10".
  if (LOCALITY_POI_RE.test(raw)) return { ok: false, motivo: "poi_sin_via" };

  // 5) Nessun prefisso, nessun POI. Si accetta SOLO il classico
  //    "Nombre Apellido <numero>" spagnolo, e in modo conservativo:
  //      - deve esserci un token numero civico plausibile;
  //      - almeno 2 parole-nome (≥3 lettere);
  //      - frase corta (≤4 token) per escludere descrizioni lunghe con una cifra.
  if (hasNumber) {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const hasCivic = tokens.some((t) => CIVIC_NUMBER_TOKEN_RE.test(t));
    const nameWords = tokens.filter((t) => NAME_WORD_RE.test(t));
    if (hasCivic && nameWords.length >= 2 && tokens.length <= 4) {
      return { ok: true };
    }
    return { ok: false, motivo: "numero_sin_via_clara" };
  }

  // 6) Né prefisso, né numero, né POI → vago.
  return { ok: false, motivo: "sin_via_y_numero" };
}

module.exports = { isDireccionConcretaParaDelivery };
