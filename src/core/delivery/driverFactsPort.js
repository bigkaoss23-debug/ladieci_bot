// src/core/delivery/driverFactsPort.js
// ===============================================================
// DriverFactsPort — read-only boundary between timingAssessmentV3's
// canonical driver_state (FREE | IN_TRIP | UNKNOWN) and the legacy
// DRIVER_STATO telemetry blob (TB-2 §7).
//
// Reuses driverTelemetry.readDriverStato (already read-only, best-effort,
// never throws) — no new raw reader is introduced. The one rule this port
// exists to enforce: an unavailable/malformed/unrecognized source is
// UNKNOWN, never a silently-assumed FREE.
// ===============================================================
"use strict";

const { toServiceDayMin } = require("../../utils/zones");
const { madridParts } = require("../../schedule/serviceSchedule");

// DRIVER_STATO's `rientro_stimato`/`partito_alle` are stored as full
// timestamps (migrations/2026-07-20_rider_trip_rpcs.sql inserts `to_jsonb(now())`
// shapes), not "HH:MM" — convert via the same Madrid-wall-clock authority
// every other planner module uses, then hand off to the service-day helper.
function isoToServiceDayMin(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p = madridParts(new Date(ms));
  if (!p || p.hour == null || p.minute == null) return null;
  return toServiceDayMin(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
}

// `currentSessionOpenedAt` (ISO string, optional): the operational session's
// own opened_at, when the caller has it. A trip whose partito_alle predates
// it started under a PRIOR service session — still real telemetry, just a
// quality caveat for the operator, never a reason to treat it as untrue.
async function resolveDriverFacts({ readDriverStato, currentSessionOpenedAt = null } = {}) {
  if (typeof readDriverStato !== "function") {
    return { state: "UNKNOWN", returnEstimateMin: null, fromPreviousService: false };
  }

  let ds;
  try {
    ds = await readDriverStato();
  } catch (_) {
    return { state: "UNKNOWN", returnEstimateMin: null, fromPreviousService: false };
  }

  if (!ds || typeof ds !== "object" || typeof ds.stato !== "string") {
    return { state: "UNKNOWN", returnEstimateMin: null, fromPreviousService: false };
  }

  if (ds.stato === "LIBERO") {
    return { state: "FREE", returnEstimateMin: null, fromPreviousService: false };
  }

  if (ds.stato === "IN_GIRO") {
    const returnEstimateMin = ds.rientro_stimato != null ? isoToServiceDayMin(ds.rientro_stimato) : null;
    let fromPreviousService = false;
    if (currentSessionOpenedAt && ds.partito_alle) {
      const opened = Date.parse(currentSessionOpenedAt);
      const started = Date.parse(ds.partito_alle);
      if (Number.isFinite(opened) && Number.isFinite(started)) fromPreviousService = started < opened;
    }
    return { state: "IN_TRIP", returnEstimateMin, fromPreviousService };
  }

  // Any other/unrecognized `stato` string: fail to UNKNOWN, not FREE.
  return { state: "UNKNOWN", returnEstimateMin: null, fromPreviousService: false };
}

module.exports = { resolveDriverFacts };
