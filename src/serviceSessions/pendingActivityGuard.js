"use strict";
// ===============================================================
// pendingActivityGuard.js — S2-7D6D
//
// THE shared "does this session still have operational work in flight"
// check, used ONLY by the AUTOMATIC close triggers (cron tick, boot
// recovery, external trigger) on top of computeAutoCloseDecision's time
// gate. A session past its close boundary with a non-terminal order still
// moving (POR_CONFIRMAR/NUEVO/EN_COCINA/LISTO/EN_ENTREGA/...) must not be
// force-closed by a timer — only chiudiServizio's own active-rider-trip gate
// existed for this before; this adds the order-level half of the same
// protection, per the approved contract (any pending order OR an active
// trip blocks an automatic close).
//
// Deliberately additive and narrow: it never touches chiudiServizio itself,
// never touches the manual operator close (ServicioPage's scan-then-confirm
// flow already gives a human full visibility and an explicit deleteAttivi
// choice — a different, pre-existing, already-correct design this does not
// change), and uses the exact same terminal-state list chiudiServizio's own
// PASSO 3 archive step already uses, so "pending" here means precisely what
// a force-close would otherwise have swept up.
// ===============================================================

const { sbSelect } = require("../utils/supabase");

const TERMINAL_STATES = ["RETIRADO", "COMPLETADO", "COMPLETATO"];

async function hasPendingOperationalActivity({ sessionId, select = sbSelect } = {}) {
  if (!sessionId) return { pending: false };
  const rows = await select(
    "ordenes",
    `service_session_id=eq.${encodeURIComponent(sessionId)}&estado=not.in.(${TERMINAL_STATES.join(",")})&limit=1`,
  );
  return { pending: Array.isArray(rows) && rows.length > 0 };
}

module.exports = { hasPendingOperationalActivity, TERMINAL_STATES };
