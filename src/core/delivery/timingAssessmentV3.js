// src/core/delivery/timingAssessmentV3.js
// ===============================================================
// TIMING ASSESSMENT V3 — canonical, read-only core (TB-2 / W2).
//
// Pure function, no DB, no fetch, no Date.now(). Every clock value the
// engine reasons about is injected by the caller as a service-day-minute
// integer (see zones.js toServiceDayMin/fromServiceDayMin: hours 00-03
// are treated as belonging to the PREVIOUS service day, so "23:50" and
// "00:20" compare correctly without a false midnight wraparound).
//
// Contract (TB-2, frozen):
//   The Planner SUGGESTS, it never COMMANDS. No estimate/warning produced
//   here may disable order confirmation — that stays entirely a FE/order
//   concern (CONFIRMAR_GATING_01 and friends), untouched by this module.
//   severity ladder: NONE < INFO < ADVISORY < WARNING (no HARD level).
//   `degraded` is an ORTHOGONAL quality signal, not a 5th severity rung:
//   the top-level `severity` is the max severity among the reasons whose
//   catalog entry is NOT degraded-type; `degraded` is true iff ANY fired
//   reason IS degraded-type. A degraded-only result (e.g. only
//   SCOPE_UNAVAILABLE fired) legitimately reports severity NONE + degraded
//   true — that combination is the whole point: it is never a *silent*
//   NONE, because `degraded` still tells the caller not to trust it.
// ===============================================================
"use strict";

const { TERMINAL_ORDER_STATES } = require("../../serviceSessions/rolloverClassifier");
const { simulateDriverSchedule, computeDriverFields, toServiceDayMin, fromServiceDayMin } = require("../../utils/zones");

const SEVERITY_RANK = Object.freeze({ NONE: 0, INFO: 1, ADVISORY: 2, WARNING: 3 });

// code -> { severity, degraded }. `degraded: true` marks a reason as a
// data-quality/trust signal: it sets the top-level `degraded` flag but is
// excluded from the top-level `severity` max (see header).
const REASON_CATALOG = Object.freeze({
  RIDER_OUT_RETURN_ESTIMATED: { severity: "INFO", degraded: false },
  RIDER_RETURN_AFTER_SALIDA_ESTIMATED: { severity: "WARNING", degraded: false },
  SCHEDULE_OVERLAP_ESTIMATED: { severity: "WARNING", degraded: false },
  DRIVER_STATE_UNKNOWN: { severity: "ADVISORY", degraded: true },
  DRIVER_TRIP_FROM_PREVIOUS_SERVICE: { severity: "ADVISORY", degraded: true },
  RIDER_RETURN_UNKNOWN: { severity: "ADVISORY", degraded: true },
  GEO_DURATION_ESTIMATED: { severity: "ADVISORY", degraded: true },
  SCOPE_UNAVAILABLE: { severity: "ADVISORY", degraded: true },
  GIRO_AVAILABLE: { severity: "INFO", degraded: false },
  GIRO_ABSORBS_OVERLAP: { severity: "INFO", degraded: false },
  INTENT_TARGET_DEPARTED: { severity: "WARNING", degraded: false },
  INTENT_TARGET_CHANGED: { severity: "WARNING", degraded: false },
  INTENT_TARGET_GONE: { severity: "WARNING", degraded: false },
  RECOMMENDED_HORA: { severity: "INFO", degraded: false },
  HORA_BEFORE_EARLIEST: { severity: "WARNING", degraded: false },
});

function makeReason(code, source, facts) {
  const entry = REASON_CATALOG[code];
  if (!entry) throw new Error(`timingAssessmentV3: unknown reason code "${code}"`);
  return { code, severity: entry.severity, source, facts: facts || {} };
}

function overallSeverity(reasons) {
  let rank = SEVERITY_RANK.NONE;
  for (const r of reasons) {
    if (REASON_CATALOG[r.code].degraded) continue;
    rank = Math.max(rank, SEVERITY_RANK[r.severity]);
  }
  return Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === rank);
}

function overallDegraded(reasons) {
  return reasons.some((r) => REASON_CATALOG[r.code].degraded);
}

function resolveDriverState(driver) {
  if (driver && (driver.state === "FREE" || driver.state === "IN_TRIP")) return driver.state;
  return "UNKNOWN"; // never a silent FREE fallback
}

// ── Standalone schedule facts (terminal-filtered, service-day-aware) ───────
// Reuses the existing pure zones.js cascade math end-to-end (no reimplemented
// interval algebra here) by folding the draft order into the SAME simulation
// as a synthetic member, then reading back its own computed fields. The only
// new behavior is the pre-filter: legacy simulateDriverSchedule's own
// exclusion list is `["RETIRADO","COMPLETADO","COMPLETATO","POR_CONFIRMAR"]`
// and does NOT include CANCELADO/CANCELLED/ANULADO/CHIUSO_FORZATO — feeding
// it a cancelled/force-closed order would count it as live driver work. This
// pre-filter uses the ONE canonical terminal set (rolloverClassifier) instead
// of inventing a second list.
const DRAFT_SYNTHETIC_ID = "__timingAssessmentV3_draft__";

function buildStandaloneScheduleFacts(existingOrders, draftOrder) {
  if (!draftOrder || draftOrder.tipo_consegna !== "DOMICILIO" || !draftOrder.zona || !draftOrder.hora) {
    return { retrasoEstimadoMin: null, conflictoDriver: false };
  }
  const live = (existingOrders || []).filter(
    (o) => o && o.id != null && !TERMINAL_ORDER_STATES.has(String(o.estado || "").toUpperCase())
  );
  const combined = [...live, { ...draftOrder, id: DRAFT_SYNTHETIC_ID, estado: draftOrder.estado || "EN_COCINA" }];
  const fieldsById = computeDriverFields(combined, {});
  const draftFields = fieldsById.get(DRAFT_SYNTHETIC_ID);
  if (!draftFields) return { retrasoEstimadoMin: null, conflictoDriver: false };
  return {
    retrasoEstimadoMin: draftFields.retraso_estimado_min,
    conflictoDriver: !!draftFields.conflicto_driver,
  };
}

// ── Core assessment ─────────────────────────────────────────────────────
//
// facts:
//   asOfMin              service-day minutes for "now" (display only)
//   newOrder             { horaMin, zona }  — draft order timing facts
//   standaloneRetrasoMin number|null — precomputed standalone overlap delay
//                        (see buildStandaloneScheduleFacts); ignored while an
//                        absorbing intended giro is in play (never simulated
//                        as a second, separate trip — TB-2 §8).
//   driver               { state: 'FREE'|'IN_TRIP'|'UNKNOWN', returnEstimateMin,
//                          fromPreviousService }
//   newOrderSalidaMin    number|null — when the draft order needs the driver
//                        to depart (from newOrder.hora - durata, or from an
//                        absorbing giro's hora_ref); compared against the
//                        current trip's returnEstimateMin.
//   intendedGiro         null | { status: 'VALID'|'DEPARTED'|'CHANGED'|'GONE',
//                          absorbsOverlap, estimatedSalidaMin }
//   compatibleGiroAvailable boolean — standalone advisory (no intendedGiro set)
//   scopeAvailable        boolean (default true)
//   geoDurationAvailable   boolean (default true)
//   earliestHoraMin        number|null — advisory floor
//   recommendedHoraMin     number|null — advisory alternative, if computed
//                          upstream (no slot-search happens in this module)
//
// `facts.horaOwnership` (operator vs planner-applied), if present, is
// deliberately never read anywhere below — TB-2 §13: identical facts must
// produce an identical assessment regardless of who set `hora`.
function computeTimingAssessmentV3(facts = {}) {
  const reasons = [];
  const push = (code, source, f) => reasons.push(makeReason(code, source, f));

  const driverState = resolveDriverState(facts.driver);
  if (driverState === "UNKNOWN") {
    push("DRIVER_STATE_UNKNOWN", "driverFactsPort", {});
  }
  if (facts.driver && facts.driver.fromPreviousService === true) {
    push("DRIVER_TRIP_FROM_PREVIOUS_SERVICE", "driverFactsPort", {});
  }

  let riderReturnEstimateMin = null;
  if (driverState === "IN_TRIP") {
    riderReturnEstimateMin = facts.driver.returnEstimateMin != null ? facts.driver.returnEstimateMin : null;
    if (riderReturnEstimateMin == null) {
      push("RIDER_RETURN_UNKNOWN", "driverFactsPort", {});
    } else {
      // "salida" here is the DRAFT order's own required departure instant
      // (when the driver would need to leave to serve it), not a property of
      // whatever trip the driver is already on. The caller/adapter derives it
      // from newOrder.hora - durata, or from an absorbing giro's hora_ref.
      const salidaRef = facts.newOrderSalidaMin != null ? facts.newOrderSalidaMin : null;
      if (salidaRef != null && riderReturnEstimateMin > salidaRef) {
        push("RIDER_RETURN_AFTER_SALIDA_ESTIMATED", "giroFactsPort", {
          rider_return_min: riderReturnEstimateMin,
          salida_min: salidaRef,
        });
      } else {
        push("RIDER_OUT_RETURN_ESTIMATED", "driverFactsPort", {
          rider_return_min: riderReturnEstimateMin,
          salida_min: salidaRef,
        });
      }
    }
  }

  if (facts.geoDurationAvailable === false) {
    push("GEO_DURATION_ESTIMATED", "geoResolver", {});
  }
  if (facts.scopeAvailable === false) {
    push("SCOPE_UNAVAILABLE", "operationalScopePort", {});
  }

  // ── Giro-aware overlap: a valid, absorbing intended giro means the draft
  // order is simulated AS PART OF that trip, never as a second separate one.
  let intendedGiroOut = null;
  let runStandaloneOverlap = true;
  if (facts.intendedGiro) {
    const ig = facts.intendedGiro;
    if (ig.status === "VALID") {
      const absorbs = !!ig.absorbsOverlap;
      intendedGiroOut = { status: "VALID", can_apply: true, absorbs_overlap: absorbs };
      if (absorbs) {
        push("GIRO_ABSORBS_OVERLAP", "giroFactsPort", { giro_status: "VALID" });
        runStandaloneOverlap = false;
      }
      // VALID-but-not-absorbing is left silent here: real headroom facts for
      // that branch belong to the canonical projection (W4), not invented here.
    } else if (ig.status === "DEPARTED") {
      intendedGiroOut = { status: "DEPARTED", can_apply: false, absorbs_overlap: false };
      push("INTENT_TARGET_DEPARTED", "giroFactsPort", { giro_status: "DEPARTED" });
    } else if (ig.status === "CHANGED") {
      intendedGiroOut = { status: "CHANGED", can_apply: false, absorbs_overlap: false };
      push("INTENT_TARGET_CHANGED", "giroFactsPort", { giro_status: "CHANGED" });
    } else if (ig.status === "GONE") {
      intendedGiroOut = { status: "GONE", can_apply: false, absorbs_overlap: false };
      push("INTENT_TARGET_GONE", "giroFactsPort", { giro_status: "GONE" });
    }
  } else if (facts.compatibleGiroAvailable === true) {
    push("GIRO_AVAILABLE", "giroFactsPort", {});
  }

  if (runStandaloneOverlap) {
    const retraso = facts.standaloneRetrasoMin;
    if (typeof retraso === "number" && retraso > 0) {
      push("SCHEDULE_OVERLAP_ESTIMATED", "driverScheduleFacts", { retraso_estimado_min: retraso });
    }
  }

  if (
    facts.earliestHoraMin != null &&
    facts.newOrder &&
    facts.newOrder.horaMin != null &&
    facts.newOrder.horaMin < facts.earliestHoraMin
  ) {
    push("HORA_BEFORE_EARLIEST", "plannerAdvisory", {
      hora_min: facts.newOrder.horaMin,
      earliest_hora_min: facts.earliestHoraMin,
    });
  }

  if (
    facts.recommendedHoraMin != null &&
    facts.newOrder &&
    facts.newOrder.horaMin != null &&
    facts.recommendedHoraMin !== facts.newOrder.horaMin
  ) {
    push("RECOMMENDED_HORA", "plannerAdvisory", { recommended_hora_min: facts.recommendedHoraMin });
  }

  return {
    as_of: facts.asOfMin != null ? fromServiceDayMin(facts.asOfMin) : null,
    severity: overallSeverity(reasons),
    degraded: overallDegraded(reasons),
    reasons,
    driver_state: driverState,
    rider_return_estimate: riderReturnEstimateMin != null ? fromServiceDayMin(riderReturnEstimateMin) : null,
    intended_giro: intendedGiroOut,
    recommended_hora: facts.recommendedHoraMin != null ? fromServiceDayMin(facts.recommendedHoraMin) : null,
    earliest_hora: facts.earliestHoraMin != null ? fromServiceDayMin(facts.earliestHoraMin) : null,
  };
}

module.exports = {
  SEVERITY_RANK,
  REASON_CATALOG,
  computeTimingAssessmentV3,
  buildStandaloneScheduleFacts,
  _internal: { simulateDriverSchedule, toServiceDayMin, fromServiceDayMin, DRAFT_SYNTHETIC_ID },
};
