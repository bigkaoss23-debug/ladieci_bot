"use strict";
// ===============================================================
// forgottenCloseRecovery.js — F-10.1B (JS SUPPORT — PRODUCTION-REACHABLE)
//
// The stale-Operational-Service recovery executor. It exists so that a
// restaurant which forgot to press Finalizar servicio cannot black out the
// next Business Day, WITHOUT the system pretending an operator closed the
// service.
//
// LIVE SINCE THE RESOLVER CUTOVER. The installed public.
// resolve_order_intake_context_v1 raises the structured FORGOTTEN_CLOSE_
// REQUIRED contract this file consumes (RAISE EXCEPTION ... USING ERRCODE =
// 'P0001', DETAIL = v_period.id::text, guarded on lifecycle_semantics =
// 'operational_service_v1') — re-verified directly against the live
// staging body, 2026-08-23. This file is reachable from both real callers,
// language-guard: allow-legacy agentOrdini.js is the existing module path this line cites, not new vocabulary
// src/tables/mesaService.js and src/agents/agentOrdini.js (N-2 application-
// wide legacy/dead-code purge audit).
//
// AUTHORITY BOUNDARY — this module has NONE of its own:
//   * it never computes a business date (no Madrid 04:00 rule, no
//     CURRENT_DATE, no clock read of any kind);
//   * it never decides WHETHER a service is stale, and never goes looking for
//     one. The canonical DB resolver both makes that verdict AND names the
//     service, structurally, in the exception it raises;
//   * it never creates a Business Day and never opens the successor service
//     (open_operational_service_v1's first_open_of_business_day path does
//     that, on the retried order's own resolver call — F-5 forbids an
//     auto-successor here);
//   * it never touches an order, a table, a rider trip or a payment. Residue
//     stays true; the V3 engine records it as incidents instead.
//   * it never imports the V3 engine directly — it goes through the one
//     canonical authority (serviceCloseAuthority.js), preserving F-8's
//     single-direct-importer invariant.
//
// IDENTITY IS SERVER-SUPPLIED AND STRUCTURAL. The stale service UUID arrives
// in the PostgreSQL exception's DETAIL field, surfaced by PostgREST as
// `details`. It is never taken from an order payload, an HTTP argument, a
// caller option, an environment variable, a message-text regex, or a
// follow-up SELECT of "whatever looks stale now". Anything short of the exact
// structured triple is not an authorized recovery request, and fails closed.
// ===============================================================

const { closeServiceSessionV3 } = require("./serviceCloseAuthority");

// The typed verdict the FUTURE resolver emits. The trigger
// (service_session_assign_order) re-raises the resolver's code as the
// exception MESSAGE with SQLSTATE P0001 and the stale service UUID as DETAIL.
const FORGOTTEN_CLOSE_CODE = "FORGOTTEN_CLOSE_REQUIRED";
const FORGOTTEN_CLOSE_SQLSTATE = "P0001";

// close_source for the abnormal close. Deliberately cause-named, so an
// auditor can never confuse it with an operator Finalizar
// ("operator_finalizar_v3") or with any legacy mechanism value. The column
// constraint is only CHECK (btrim(close_source) <> ''), so this value needs
// no migration.
const FORGOTTEN_CLOSE_SOURCE = "abandoned_forgotten_close";

// WHO closed it. Not a fabricated human. Matches the established system
// attribution already used by service_incidents.detected_by.
const SYSTEM_ACTOR = "system";

// Canonical UUID form. Exact-shape validation, applied to a value that must
// already have arrived in the dedicated DETAIL field — never used to hunt for
// a UUID inside free text.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses the complete structured contract out of a PostgREST error body.
// Returns { staleServiceSessionId } or null. Fails closed on every partial
// match: right code but no detail, right detail but wrong message, a UUID
// hiding in the message text, and so on.
function parseForgottenCloseRequired(error) {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  if (error.code !== FORGOTTEN_CLOSE_SQLSTATE) return null;
  if (error.message !== FORGOTTEN_CLOSE_CODE) return null;
  // PostgreSQL DETAIL, surfaced verbatim by PostgREST as `details`. The
  // transport (src/utils/supabaseTransport.js) returns the parsed body
  // untouched, and creaOrdine already relies on this same mapping to read the // language-guard: allow-legacy creaOrdine is the existing order-creation function name, referenced here only to cite the precedent for this error mapping, not new vocabulary
  // 23505 unique-violation DETAIL.
  const detail = error.details;
  if (typeof detail !== "string") return null;
  const candidate = detail.trim();
  if (!UUID_RE.test(candidate)) return null;
  return { staleServiceSessionId: candidate };
}

function createForgottenCloseRecovery({ closeService = closeServiceSessionV3 } = {}) {
  return async function recoverForgottenService({ staleServiceSessionId } = {}) {
    // Identity must be the exact server-resolved UUID. No fallback, no
    // rediscovery: if the caller cannot supply it, there is nothing this
    // module is authorized to close.
    if (typeof staleServiceSessionId !== "string" || !UUID_RE.test(staleServiceSessionId)) {
      return { success: false, code: "INVALID_STALE_SERVICE_IDENTITY" };
    }

    let v3;
    try {
      v3 = await closeService({
        serviceSessionId: staleServiceSessionId,
        source: FORGOTTEN_CLOSE_SOURCE,
        actor: SYSTEM_ACTOR,
      });
    } catch (e) {
      return { success: false, code: "V3_CLOSE_THREW", detail: String((e && e.message) || e) };
    }

    if (!v3 || v3.success !== true) {
      return {
        success: false,
        code: "V3_CLOSE_FAILED",
        v3Code: (v3 && v3.code) || null,
        serviceSessionId: staleServiceSessionId,
      };
    }

    // success===true covers both a fresh close and the engine's own
    // already-closed retry lineage (it returns idempotent:true there). Both
    // are convergence; neither creates a second closeout.
    return {
      success: true,
      code: "FORGOTTEN_CLOSE_RECOVERED",
      converged: true,
      idempotent: v3.idempotent === true,
      serviceSessionId: staleServiceSessionId,
      closeoutCorrelationId: v3.closeoutCorrelationId || null,
    };
  };
}

const recoverForgottenService = createForgottenCloseRecovery();

module.exports = {
  FORGOTTEN_CLOSE_CODE,
  FORGOTTEN_CLOSE_SQLSTATE,
  FORGOTTEN_CLOSE_SOURCE,
  SYSTEM_ACTOR,
  parseForgottenCloseRequired,
  createForgottenCloseRecovery,
  recoverForgottenService,
};
