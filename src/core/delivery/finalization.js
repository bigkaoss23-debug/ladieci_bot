// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY FINALIZATION — regola canonica del passaggio a RETIRADO.
//
// CONTRATTO (frozen 2026-09-22):
//   RETIRADO = il cliente ha ricevuto (DOMICILIO) o ritirato (RITIRO) l'ordine,
//   e l'ordine è operativamente concluso. NON significa "driver rientrato".
//
//   CASO A — ordine NON già pagato:
//     serve un metodo REALE (efectivo | tarjeta | bizum). Assente o invalido
//     (compreso il legacy "manual") → FAIL CLOSED: niente RETIRADO, nessuna
//     scrittura su `ordenes`.
//   CASO B — ordine GIÀ pagato (ya_pagado, oppure cobrado + metodo reale):
//     nessun secondo pagamento, il metodo canonico esistente NON viene
//     sovrascritto. Un metodo valido in ingresso serve solo a colmare un buco
//     (già pagato ma senza metodo registrato).
//
// Questa è l'UNICA autorità sul pagamento finale: il frontend raccoglie
// l'input, il backend decide. Vale identica per driver, operatore e RITIRO.
// ─────────────────────────────────────────────────────────────────────────────

// "manual" NON è un metodo: era il placeholder del vecchio fallback operatore
// e finiva nel bucket `no_especificado` di Economía (incasso contato, metodo perso).
const VALID_PAYMENT_METHODS = Object.freeze(["efectivo", "tarjeta", "bizum"]);

function normalizePaymentMethod(metodo) {
  return String(metodo == null ? "" : metodo).trim().toLowerCase();
}

function isValidPaymentMethod(metodo) {
  return VALID_PAYMENT_METHODS.includes(normalizePaymentMethod(metodo));
}

// Pagamento già acquisito PRIMA della finalizzazione:
//   - ya_pagado = true  → pagato in anticipo alla creazione (NuevoPedidoModal
//     salva insieme ya_pagado + metodo_pago);
//   - cobrado = true con un metodo reale → incasso già registrato.
// `cobrado` da solo, senza metodo reale, NON basta: è lo stato sporco che
// questa release elimina (il vecchio fallback scriveva cobrado=true + "manual").
function isAlreadyPaid(order) {
  if (!order) return false;
  if (order.ya_pagado === true) return true;
  return order.cobrado === true && isValidPaymentMethod(order.metodo_pago);
}

// Decide i campi pagamento della transizione → RETIRADO.
// Ritorna { ok: true, patch, caso } oppure { ok: false, error, ... }.
// `patch` è autorevole: il chiamante scarta metodo_pago/cobrado del payload.
function resolveRetiradoPayment({ order = null, requestedMethod } = {}) {
  const requested = normalizePaymentMethod(requestedMethod);
  const requestedValid = isValidPaymentMethod(requested);

  if (isAlreadyPaid(order)) {
    // CASO B — niente secondo pagamento.
    const patch = { cobrado: true };
    // Buco difensivo: già pagato ma senza metodo canonico → lo colmiamo solo
    // se ne arriva uno valido. Mai sovrascrivere un metodo reale esistente.
    if (!isValidPaymentMethod(order && order.metodo_pago) && requestedValid) {
      patch.metodo_pago = requested;
    }
    return { ok: true, patch, caso: "already_paid" };
  }

  // CASO A — pagamento all'atto della consegna/ritiro.
  if (!requestedValid) {
    return {
      ok: false,
      error: "payment_method_required",
      reason: requested
        ? `metodo_pago no válido: "${requested}"`
        : "metodo_pago ausente",
      metodo_pago_recibido: requested || null,
      metodos_validos: VALID_PAYMENT_METHODS.slice(),
    };
  }

  return {
    ok: true,
    patch: { cobrado: true, metodo_pago: requested },
    caso: "paid_on_delivery",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// [PAYMENT-IDEMPOTENCY 2026-09-23] Due concetti separati, mai più lo stesso path:
//
//   A. FINALIZZAZIONE (→ RETIRADO) — idempotente. Un secondo RETIRADO su un
//      ordine già RETIRADO (doppio click, retry, tab stale, secondo device) è un
//      VERO no-op: nessuna scrittura, nessun log. Non può cambiare il pagamento.
//   B. CORREZIONE DEL METODO — solo con l'azione esplicita `cambiarMetodoPago`,
//      solo su ordini RETIRADO, ATOMICA: la funzione DB payment_method_change_v1
//      aggiorna metodo_pago e scrive l'audit (event_type PAYMENT_METHOD_CHANGED_EVENT)
//      nella stessa transazione. Totale, items, tipo_consegna non si toccano.
// ─────────────────────────────────────────────────────────────────────────────
const PAYMENT_METHOD_CHANGED_EVENT = "payment_method_changed";

module.exports = {
  VALID_PAYMENT_METHODS,
  PAYMENT_METHOD_CHANGED_EVENT,
  normalizePaymentMethod,
  isValidPaymentMethod,
  isAlreadyPaid,
  resolveRetiradoPayment,
};
