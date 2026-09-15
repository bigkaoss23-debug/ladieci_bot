'use strict';
// W5 INTENT ACTIVATION V1 — bounded, best-effort Giro intent reconciler.
//
// WHY THIS EXISTS. cambiaStato()'s EN_COCINA hook (agentOrdini.js) attempts an
// immediate consume the moment an order enters the kitchen — the common case.
// But that hook can only fire once, on a genuine transition: if the process
// dies between the estado UPDATE committing and the consume RPC completing,
// nothing retries it automatically from there. This module is that retry:
// wired into the existing getOrdenes polling read (index.js, the same
// endpoint Cocina/Entregas/Repartidor/Manual-Giro already poll ≤10s), it
// re-checks a small, indexed, session-scoped slice of still-PENDING intents
// on every poll and gives each one another chance to resolve. The RECONCILE_
// TERMINAL_STATES hook in cambiaStato() is a second, independent backstop for
// the same failure window (fires on RETIRADO/COMPLETADO/CANCELADO/ANULADO).
//
// BOUNDS. Every call is scoped to the caller's own current operational
// session ids (never a historical/unbounded scan) and to a small server-side-
// clamped batch (giro_authority_list_pending_intents_v1 clamps p_limit to
// [1,200] regardless of what is passed here). giro_authority_consume_intent_v1
// is idempotent and NO_INTENT/terminal-replay are safe no-ops, so calling it
// on a candidate that resolved a moment ago (by the EN_COCINA hook, or by a
// concurrent reconciler run) costs nothing beyond one more RPC round-trip.
//
// FAIL OPEN, ALWAYS. This module NEVER throws and NEVER blocks its caller.
// A failure at any step (the list call, one consume call, a malformed
// response) is swallowed; the caller (index.js's getOrdenes handler) must
// keep working identically whether this succeeds, partially succeeds, or
// fails outright. This module never performs a raw giro_members/manual_giros/
// ordenes.manual_giro_id write — giro_authority_consume_intent_v1 remains the
// only mutation path.
//
// ACTOR. A fixed, surface-identifying constant, the same pattern as
// manualGiros.js's DEFAULT_CREATED_BY ("pin_dashboard") — never the polling
// request's own req.authCtx.actor, since attributing an automatic
// consume attempt to whichever operator's tablet happened to trigger it
// would be misleading audit data. Shared (imported, not duplicated) by
// agentOrdini.js's cambiaStato() hooks below, which are the same kind of
// automatic, non-interactive consume attempt as this module's own.

const { sbRpc } = require("../utils/supabase");

// Shared by every automatic (non-interactive) consume call site: this
// reconciler's own batch AND cambiaStato()'s EN_COCINA / RECONCILE_TERMINAL_
// STATES hooks (agentOrdini.js) — one actor identity for "the automatic Giro
// intent consumption system", not three different ones.
const GIRO_INTENT_AUTO_CONSUME_ACTOR = "giro_intent_auto_consume";
const DEFAULT_BATCH_LIMIT = 20;

// `rpc` is injectable (defaults to the real sbRpc), the same dependency-injection
// convention already used elsewhere in this codebase (e.g. currentOperationalSession.js's
// getCurrentOperationalSession({ currentCloseout = lifecycle.currentCloseout })) — lets
// tests exercise the real control flow (bounds, fail-open, per-candidate isolation)
// against a fake transport with no network and no DB.
// Returns { attempted, consumed } for observability/tests; never throws.
async function reconcilePendingGiroIntents({ operationalSessionIds, limit = DEFAULT_BATCH_LIMIT, rpc = sbRpc } = {}) {
  const outcome = { attempted: 0, consumed: 0 };
  try {
    if (!Array.isArray(operationalSessionIds) || operationalSessionIds.length === 0) return outcome;

    const listResp = await rpc("giro_authority_list_pending_intents_v1", {
      p_operational_session_ids: operationalSessionIds,
      p_limit: limit,
    });
    if (!listResp || !listResp.ok || !Array.isArray(listResp.body)) return outcome;

    for (const row of listResp.body) {
      const orderUid = row && typeof row.order_uid === "string" ? row.order_uid : null;
      if (!orderUid) continue;
      outcome.attempted += 1;
      try {
        const consumeResp = await rpc("giro_authority_consume_intent_v1", {
          p_order_uid: orderUid,
          p_actor: GIRO_INTENT_AUTO_CONSUME_ACTOR,
          p_operational_session_ids: operationalSessionIds,
        });
        if (consumeResp && consumeResp.ok && consumeResp.body && consumeResp.body.status === "CONSUMED"
            && consumeResp.body.replay === false) {
          outcome.consumed += 1;
        }
      } catch (_) {
        // One candidate's failure must never abort the rest of the batch.
      }
    }
  } catch (_) {
    // Never throw into the caller — the primary read this rides on must
    // succeed regardless of this module's outcome.
  }
  return outcome;
}

module.exports = { reconcilePendingGiroIntents, GIRO_INTENT_AUTO_CONSUME_ACTOR, DEFAULT_BATCH_LIMIT };
