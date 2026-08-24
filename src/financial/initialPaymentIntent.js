'use strict';
// N-3 — the application half of canonical initial payment for Nuevo Pedido.
//
// WHAT THIS IS NOT. It is not a payment writer. It writes nothing, derives no amount and
// records no money. The canonical writer is `public.order_mark_paid` -> `_ledger_write_payment`
// -- the same authority the operator collection path reaches through registerOperatorPayment --
// and it is invoked by the DB trigger `ordenes_paid_at_creation_payment_v1` on the order's own
// INSERT, so order + obligation + payment are one atomic operation. This module only turns a
// verified request context into the ephemeral intent that trigger consumes, and turns the
// trigger's refusals back into truthful operator sentences.
//
// WHY THE INTENT AND NOT `ya_pagado`. Before N-3 the operator's "☑ Pagado" arrived as
// `ya_pagado=true` + `metodo_pago` written straight into the INSERT, with zero rows in
// order_financial_events -- money declared by a boolean. The canonical writer REFUSES to
// record a payment for an order that already carries those flags (AUTH_LEGACY_IMPORT_REQUIRED),
// and that guard protects historical ambiguous money, so it must not be weakened. Hence the
// inversion: the flags stop being an INPUT and become an OUTPUT, set by the payment writer
// itself as compatibility mirrors. The intent is what carries the operator's declaration in.
//
// TRUST. `actor` and `sv` come from req.authCtx -- the DB-verified session identity the legacy
// auth guard builds -- and never from the request body, exactly as registerOperatorPayment
// does. `ip_hash` comes from the same ipHash(trustedClientIp(req)) helper. Only service_role
// can INSERT into `ordenes` (anon/authenticated hold SELECT only), so a browser can never
// forge an intent even if it invented the field.
//
// FAIL CLOSED. If the verified context is unavailable, this refuses the PAID creation rather
// than silently creating an unpaid order or falling back to the legacy flag. Losing the money
// record is the failure N-3 exists to prevent; a clear refusal the operator can retry is not.

// Canonical payment vocabulary. Same three the SQL layer accepts -- no aliases invented here.
const PAYMENT_METHODS = Object.freeze(['efectivo', 'tarjeta', 'bizum']);
const PAYMENT_METHOD_SET = new Set(PAYMENT_METHODS);

// Caller-facing codes. Deliberately distinct from the SQL domain codes so a call site can tell
// "we could not even build the intent" from "the ledger refused it".
const CONTEXT_UNAVAILABLE = 'INITIAL_PAYMENT_CONTEXT_UNAVAILABLE';
const METHOD_INVALID = 'INITIAL_PAYMENT_METHOD_INVALID';
const NOT_FOR_TABLE_ORDER = 'INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER';

// Operator-facing Spanish. One sentence each, no raw codes, and each one says what to do next.
const MESSAGES = Object.freeze({
  [CONTEXT_UNAVAILABLE]:
    'No se pudo verificar tu sesión para registrar el cobro. Vuelve a entrar y crea el pedido otra vez.',
  [METHOD_INVALID]:
    'Método de pago no válido. Elige efectivo, tarjeta o bizum.',
  [NOT_FOR_TABLE_ORDER]:
    'Las comandas de mesa se cobran desde la pantalla de la mesa, no al crear el pedido.',
  INITIAL_PAYMENT_LEGACY_FLAG_PRESENT:
    'No se pudo registrar el cobro del pedido nuevo. Inténtalo de nuevo.',
  INITIAL_PAYMENT_CONTEXT_INVALID:
    'No se pudo verificar tu sesión para registrar el cobro. Vuelve a entrar y crea el pedido otra vez.',
  // SQL domain codes that can reach the operator through the canonical writer.
  AUTH_ACTOR_NOT_FOUND:
    'Tu usuario ya no existe. Vuelve a entrar para poder cobrar.',
  AUTH_INITIATOR_INACTIVE:
    'Tu usuario está desactivado y no puede registrar cobros.',
  AUTH_SESSION_STALE:
    'Tu sesión ha caducado. Vuelve a entrar y crea el pedido otra vez.',
  AUTH_FORBIDDEN_ROLE:
    'Tu rol no puede registrar cobros. Crea el pedido sin marcar Pagado y que lo cobre un responsable.',
  AUTH_METHOD_INVALID:
    'Método de pago no válido. Elige efectivo, tarjeta o bizum.',
  AUTH_AMOUNT_INVALID:
    'No se puede cobrar un pedido con importe cero. Revisa los productos.',
  AUTH_BASIS_EXISTS:
    'Este pedido ya tiene un cobro registrado.',
  AUTH_IDEMPOTENCY_CONFLICT:
    'Ya hay un cobro distinto registrado para este pedido. Revísalo antes de reintentar.',
  AUTH_LEGACY_IMPORT_REQUIRED:
    'Este pedido ya figura como pagado por el sistema antiguo. No se puede volver a cobrar.',
  ORDER_WITHOUT_SERVICE_SESSION:
    'El pedido no está asociado a ningún servicio abierto. No se puede cobrar.',
});

const GENERIC_FAILURE =
  'No se pudo registrar el cobro del pedido nuevo. El pedido NO se ha creado. Inténtalo de nuevo.';

// Every code above, plus the two the trigger raises before delegating. Used to recognise a
// refusal in a PostgREST error body.
const INITIAL_PAYMENT_CODES = Object.freeze(Object.keys(MESSAGES));

const fail = (code) => Object.freeze({ ok: false, code, message: MESSAGES[code] || GENERIC_FAILURE });

// Mirrors the SQL layer's normalization so a method is judged the same way on both sides.
function normalizeMethod(method) {
  return typeof method === 'string' ? method.trim().toLowerCase() : '';
}

// Did the operator ask for "paid at creation"? Read from the SAME two legacy fields the
// frontend already sends -- the wire contract is unchanged, only its meaning moves: they are
// now a REQUEST for a canonical payment, never the payment itself.
function requestsInitialPayment(body) {
  if (!body || typeof body !== 'object') return false;
  return body.ya_pagado === true || body.ya_pagado === 'true';
}

// Build the ephemeral intent the DB trigger consumes.
//
// Returns:
//   { ok: true, intent: null }        — nothing requested; ordinary unpaid creation
//   { ok: true, intent: {...} }       — attach this to the order INSERT
//   { ok: false, code, message }      — refuse the whole creation; nothing was written
function buildInitialPaymentIntent({ body, authCtx, ipHash, trustedClientIp } = {}) {
  if (!requestsInitialPayment(body)) return Object.freeze({ ok: true, intent: null });

  // Mesa comandas settle through the table's own payment hub. The modal already forces this,
  // but a table order arriving with a paid flag is refused rather than paid twice.
  if (body && body.table_session_id) return fail(NOT_FOR_TABLE_ORDER);

  const method = normalizeMethod(body && body.metodo_pago);
  if (!PAYMENT_METHOD_SET.has(method)) return fail(METHOD_INVALID);

  // Fail closed. Without a verified actor + session_version the ledger cannot record who took
  // the money, and falling back to the legacy boolean is exactly the defect being retired.
  const actor = authCtx && typeof authCtx.actor === 'string' ? authCtx.actor.trim() : '';
  const sv = authCtx ? authCtx.sv : null;
  if (actor.length === 0 || !Number.isInteger(sv) || sv < 1) return fail(CONTEXT_UNAVAILABLE);

  // The SQL layer requires a non-blank ip_hash; without IP_SECRET the hash is null and the
  // payment cannot be recorded at all, so refuse here rather than at the trigger.
  const hash = typeof ipHash === 'function' ? ipHash(trustedClientIp) : null;
  if (typeof hash !== 'string' || hash.trim().length === 0) return fail(CONTEXT_UNAVAILABLE);

  return Object.freeze({
    ok: true,
    intent: Object.freeze({ method, actor, sv, ip_hash: hash.trim() }),
  });
}

// Recognise the trigger's (or the canonical writer's) refusal in whatever sbInsert returned.
// sbInsert never throws on a non-2xx: it hands back the parsed PostgREST error body, so the
// caller MUST inspect it or a refused creation would be reported as a success.
function describeInitialPaymentFailure(sbResult) {
  if (!sbResult || typeof sbResult !== 'object') return null;
  const haystack = ['message', 'details', 'detail', 'hint']
    .map((k) => (typeof sbResult[k] === 'string' ? sbResult[k] : ''))
    .join(' | ');
  if (haystack.length === 0) return null;
  const code = INITIAL_PAYMENT_CODES.find((c) => haystack.includes(c));
  if (!code) return null;
  return Object.freeze({ code, message: MESSAGES[code] || GENERIC_FAILURE });
}

module.exports = {
  PAYMENT_METHODS,
  INITIAL_PAYMENT_CODES,
  CONTEXT_UNAVAILABLE,
  METHOD_INVALID,
  NOT_FOR_TABLE_ORDER,
  GENERIC_FAILURE,
  MESSAGES,
  requestsInitialPayment,
  buildInitialPaymentIntent,
  describeInitialPaymentFailure,
};
