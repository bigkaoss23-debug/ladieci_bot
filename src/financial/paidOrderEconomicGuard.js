'use strict';
// N-5 — the application-layer face of the DB's paid-order economic guard.
//
// THE DB IS THE AUTHORITY. migrations/2026-08-24_n5_paid_order_economic_mutation_guard.sql
// installs a BEFORE UPDATE trigger on `ordenes` that refuses any UPDATE which MOVES the
// economic basis (totale / delivery_fee / descuento_tipo / descuento_valor /
// descuento_importe) once payment evidence exists for that order in its own service
// session. Nothing in this file can weaken or substitute for that. This module exists for
// two narrower reasons, both of which are real defects if left unhandled:
//
//   1. THE REFUSAL WOULD OTHERWISE BE INVISIBLE. `sbUpdate` never throws on a non-2xx: it
//      returns the parsed PostgREST error body ({code, message, details, hint}), and the
//      three order writers ignore the return value entirely and report `{success:true}`
//      unconditionally. Without `isEconomicMutationRefusal`, the DB would correctly refuse
//      the edit while the operator was told "Pedido actualizado" and nothing had changed.
//      That is the same class of silent-success defect S2-7D6E fixed for collections.
//
//   2. ONE REQUEST MUST NOT TAKE MONEY AND THEN GET REFUSED. index.js's updateEstado /
//      marcarEntregado register the payment FIRST and transition SECOND (deliberately --
//      "money first, state second", so a failed collection never produces a false
//      "retired & paid"). When that same request also carries a discount, the sequence is:
//      collect on the CURRENT total, then rewrite the total downward. Today that silently
//      records the UNDISCOUNTED amount and then reduces what was owed -- collected >
//      obligation, exactly the N-5 hazard. With the DB guard installed the second step is
//      refused, which without an early check would leave the money recorded and the order
//      stuck. `collectionWouldMutateEconomicBasis` refuses that combination BEFORE any
//      money is taken, so nothing is recorded and nothing is stuck.
//
// NOT A SECOND AUTHORITY. This module answers only "did the DB refuse?" and "would this
// specific request combine a collection with an economic change?". It never decides
// whether an order is paid, never reads the evidence tables, and never computes money.

// The contract string the DB guard raises. Also the caller-facing code, deliberately
// identical so a log line, an HTTP body and the SQL exception all name the same thing.
const PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN = 'PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN';

// Operator-facing Spanish copy. One sentence, no jargon, no raw code echoed at a human.
const OPERATOR_MESSAGE =
  'No se puede modificar el importe de un pedido que ya tiene pagos registrados.';

// PostgREST surfaces a PL/pgSQL RAISE as { code:'P0001', message, details, hint }. The
// message is our contract string. `details`/`hint` are checked too because a future
// PostgREST version could relocate the RAISE message, and this must fail closed: a refusal
// we cannot recognise would be reported to the operator as a success.
function isEconomicMutationRefusal(sbResult) {
  if (!sbResult || typeof sbResult !== 'object' || Array.isArray(sbResult)) return false;
  for (const key of ['message', 'details', 'detail', 'hint']) {
    const v = sbResult[key];
    if (typeof v === 'string' && v.includes(PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN)) return true;
  }
  return false;
}

// The uniform failure every writer returns instead of a fabricated `{success:true}`.
function economicMutationRefusal(orderId) {
  return {
    success: false,
    error: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
    code: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
    id: typeof orderId === 'string' ? orderId : undefined,
    message: OPERATOR_MESSAGE,
  };
}

// Would THIS request both collect money and move the economic basis?
//
// `extras` is the same object index.js hands to cambiaStato. Only a REAL discount moves
// the basis: aplicarDescuento (src/utils/helpers.js) returns the base unchanged when tipo
// is falsy or valor <= 0, so those recompute to the identical total.
//
// THE ZERO CASE IS LOAD-BEARING, NOT PEDANTRY. TabListos' per-order discount state
// defaults to `{tipo: null, valor: 0}`, and api.updateEstado forwards `descuento_valor`
// whenever it is non-null -- so a plain "🛍 Retirado + efectivo" with no discount at all
// can carry `descuento_valor: 0` on the wire. A blunt "any descuento key present" rule
// would therefore refuse ordinary collections. Hence the value test, which mirrors
// aplicarDescuento's own precondition rather than inventing a second one.
//
// Deliberately syntactic, not arithmetic: it does not re-derive the total. Re-deriving it
// here would create a second money authority beside the order writers' own, which is the mistake
// N-2 spent a whole migration header refusing.
//
// KNOWN RESIDUAL, stated rather than hidden: an explicit discount REMOVAL (tipo sent as
// null on an order that has one) also moves the basis upward and is NOT caught early --
// it is refused by the DB after the payment is recorded. No current frontend path can
// produce it: TabListos sends `null` (no keys at all) when no discount is chosen and a
// truthy tipo otherwise, and api.marcarEntregado sends no discount fields whatsoever.
function collectionWouldMutateEconomicBasis(extras) {
  if (!extras || typeof extras !== 'object') return false;
  const tipo = extras.descuento_tipo;
  if (typeof tipo === 'string' && tipo.trim() !== '') return true;
  const valor = Number(extras.descuento_valor);
  return Number.isFinite(valor) && valor > 0;
}

// ── Economic Writer Hardening V1 (E-1, migration 126) — the sibling guard. ────────────
//
// The DB IS THE AUTHORITY here too. migrations/2026-09-11_economic_writer_hardening_v1_
// migration_126.sql installs order_economic_basis_lock_v1, a BEFORE UPDATE trigger on
// `ordenes` that refuses a genuine value change to totale/items/delivery_fee/descuento_*
// when the order is Mesa-owned, already carries a commercial-adjustment/cancellation
// revision, or is already CANCELADO/CANCELLED/ANULADO. `isEconomicBasisLockRefusal` /
// `economicBasisLockRefusal` give the three writers that already check
// language-guard: allow-legacy modificaOrdine/cambiaStato/aggiungiItems are the three existing exported writer function names this guard module documents, not new vocabulary
// `isEconomicMutationRefusal` (modificaOrdine, cambiaStato, aggiungiItems) the same
// recognition for THIS DB refusal, so it is reported instead of silently mishandled.
//
// `orderHasCommercialAdjustmentRevision` is the ANTICIPATED half: a best-effort read so
// those same three writers can refuse BEFORE even attempting the write, avoiding a
// round-trip guaranteed to fail. It is fail-OPEN on a lookup failure (returns false) --
// the DB trigger remains the real, fail-closed authority regardless of what this helper
// language-guard: allow-legacy modificaOrdine is the existing writer function name whose estado guard this sentence compares against, not new vocabulary
// returns, exactly like the top-of-function estado guard in modificaOrdine it sits beside.
const ORDER_ECONOMIC_BASIS_LOCKED = 'ORDER_ECONOMIC_BASIS_LOCKED';

const BASIS_LOCKED_MESSAGE =
  'No se puede modificar el importe de un pedido de Mesa, ya ajustado, o cancelado/anulado.';

function isEconomicBasisLockRefusal(sbResult) {
  if (!sbResult || typeof sbResult !== 'object' || Array.isArray(sbResult)) return false;
  for (const key of ['message', 'details', 'detail', 'hint']) {
    const v = sbResult[key];
    if (typeof v === 'string' && v.includes(ORDER_ECONOMIC_BASIS_LOCKED)) return true;
  }
  return false;
}

function economicBasisLockRefusal(orderId) {
  return {
    success: false,
    error: ORDER_ECONOMIC_BASIS_LOCKED,
    code: ORDER_ECONOMIC_BASIS_LOCKED,
    id: typeof orderId === 'string' ? orderId : undefined,
    message: BASIS_LOCKED_MESSAGE,
  };
}

// FINAL CONCURRENCY FIX (migration 151) -- a FOURTH DB refusal of an economic order write, sibling of the two above.
// Every obligation revision (a totale edit through the ordenes trigger, a cancellation, a commercial adjustment) now takes
// the close gate and is refused -- nothing written -- when the order's service is no longer open: its closeout is frozen.
// Recognised here so the three totale writers of this file's callers report it instead of a false success.
const ORDER_ECONOMIC_SERVICE_CLOSED = 'ORDER_ECONOMIC_SERVICE_CLOSED';

const SERVICE_CLOSED_MESSAGE =
  'El servicio de este pedido ya está cerrado: su importe no se puede modificar. No se guardó nada.';

function isEconomicServiceClosedRefusal(sbResult) {
  if (!sbResult || typeof sbResult !== 'object' || Array.isArray(sbResult)) return false;
  for (const key of ['message', 'details', 'detail', 'hint', 'code']) {
    const v = sbResult[key];
    if (typeof v === 'string' && v.includes(ORDER_ECONOMIC_SERVICE_CLOSED)) return true;
  }
  return false;
}

function economicServiceClosedRefusal(orderId) {
  return {
    success: false,
    error: ORDER_ECONOMIC_SERVICE_CLOSED,
    code: ORDER_ECONOMIC_SERVICE_CLOSED,
    id: typeof orderId === 'string' ? orderId : undefined,
    message: SERVICE_CLOSED_MESSAGE,
  };
}

// POST-ASTRA F5 -- the canonical editor writer (migration 153, order_apply_editor_patch_v1) refuses a write whose economic basis
// changed after it was read: an explicit conflict, never a silent stale overwrite.
const ORDER_EDIT_CONFLICT = 'ORDER_EDIT_CONFLICT';
const EDIT_CONFLICT_MESSAGE =
  'El pedido cambió mientras lo editabas. Recárgalo y vuelve a aplicar el cambio. No se guardó nada.';

function isOrderEditConflict(sbResult) {
  if (!sbResult || typeof sbResult !== 'object' || Array.isArray(sbResult)) return false;
  for (const key of ['message', 'details', 'detail', 'hint', 'code']) {
    const v = sbResult[key];
    if (typeof v === 'string' && v.includes(ORDER_EDIT_CONFLICT)) return true;
  }
  return false;
}

function orderEditConflictRefusal(orderId) {
  return {
    success: false,
    error: ORDER_EDIT_CONFLICT,
    code: ORDER_EDIT_CONFLICT,
    id: typeof orderId === 'string' ? orderId : undefined,
    message: EDIT_CONFLICT_MESSAGE,
  };
}

// POST-ASTRA F7 -- a write the database did not perform is NEVER reported as a success. The known refusals keep their typed
// codes; ANY other error body (a deadlock, a timeout, an unknown trigger refusal, a transport error page) is a typed failure.
const ORDER_WRITE_FAILED = 'ORDER_WRITE_FAILED';
const WRITE_FAILED_MESSAGE = 'No se pudo guardar el pedido. No se guardó nada: recarga e inténtalo de nuevo.';

function isDbWriteFailure(result) {
  if (result === null || result === undefined) return false;
  if (typeof result === 'string') return result.trim() !== '';
  if (Array.isArray(result)) return false;
  if (typeof result === 'object') return typeof result.message === 'string' || typeof result.code === 'string';
  return false;
}

function orderWriteFailure(orderId) {
  return {
    success: false,
    error: ORDER_WRITE_FAILED,
    code: ORDER_WRITE_FAILED,
    id: typeof orderId === 'string' ? orderId : undefined,
    message: WRITE_FAILED_MESSAGE,
  };
}

// The ONE mapping of an ordenes write result: null = written; otherwise the typed refusal to return as is.
function classifyOrderWriteResult(orderId, result) {
  if (!isDbWriteFailure(result)) return null;
  if (isEconomicMutationRefusal(result)) return economicMutationRefusal(orderId);
  if (isEconomicBasisLockRefusal(result)) return economicBasisLockRefusal(orderId);
  if (isEconomicServiceClosedRefusal(result)) return economicServiceClosedRefusal(orderId);
  if (isOrderEditConflict(result)) return orderEditConflictRefusal(orderId);
  return orderWriteFailure(orderId);
}

// Best-effort: does this order_uid already carry a commercial-adjustment or cancellation
// revision (order_obligations.source = 'order_commercial_adjustment_v1')? Mirrors E-1's own
// predicate (b) exactly. Returns false (never throws) on a missing uid or a lookup failure
// -- the DB trigger is the fail-closed authority, this is only the early-exit optimisation.
async function orderHasCommercialAdjustmentRevision(orderUid, deps = {}) {
  if (!orderUid || typeof orderUid !== 'string') return false;
  const sbSelect = deps.sbSelect || require('../utils/supabase').sbSelect;
  try {
    const rows = await sbSelect(
      'order_obligations',
      `order_uid=eq.${encodeURIComponent(orderUid)}&source=eq.order_commercial_adjustment_v1&select=id&limit=1`
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn('[orderEconomicBasisLock] adjustment-evidence lookup failed:', e?.message || e);
    return false;
  }
}

module.exports = {
  ORDER_EDIT_CONFLICT,
  EDIT_CONFLICT_MESSAGE,
  isOrderEditConflict,
  orderEditConflictRefusal,
  ORDER_WRITE_FAILED,
  WRITE_FAILED_MESSAGE,
  isDbWriteFailure,
  orderWriteFailure,
  classifyOrderWriteResult,
  PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
  OPERATOR_MESSAGE,
  isEconomicMutationRefusal,
  economicMutationRefusal,
  collectionWouldMutateEconomicBasis,
  ORDER_ECONOMIC_BASIS_LOCKED,
  BASIS_LOCKED_MESSAGE,
  isEconomicBasisLockRefusal,
  economicBasisLockRefusal,
  ORDER_ECONOMIC_SERVICE_CLOSED,
  SERVICE_CLOSED_MESSAGE,
  isEconomicServiceClosedRefusal,
  economicServiceClosedRefusal,
  orderHasCommercialAdjustmentRevision,
};
