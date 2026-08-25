"use strict";
// ===============================================================
// economicWindow.js — I-1 ECONOMIC SNAPSHOT V1
//
// THE window resolver. Turns an operator preset (or an explicit pair of
// instants) into ONE half-open timestamp interval [from, to).
//
// WHY THIS EXISTS AT ALL. Every economic reader in this repo before I-1 was
// shaped by the Operational Service: getEconomiaLedgerAggregate iterates
// service_sessions filtered by business_date, and currentServiceCloseout
// filters every row by service_session_id. That makes the SERVICE the
// economic boundary. It is not. Economic facts are timestamped durable facts;
// the service is an operational identity that happens to be running when they
// occur. A snapshot answers "what happened between these two instants", and
// must keep answering it across a business day that contained two, three or
// zero Operational Services.
//
// So: service_session_id is never the window here. It is available as an
// OPTIONAL provenance filter (and as the "servicio" convenience preset, which
// resolves that session's own opened_at/closed_at into — again — a plain
// timestamp interval), never as the authority.
//
// TIMEZONE / SCHEDULE. Nothing here invents a calendar. Every boundary comes
// from src/schedule/serviceSchedule.js, the module that already owns the
// restaurant's clock: DEFAULT_SCHEDULE.rolloverMin (04:00 Madrid, where the
// business day turns over) and DEFAULT_SCHEDULE.lunchBoundaryMin (17:30, the
// single midday/evening cutoff). resolveEconomicPeriod() in that same file
// already states the partition this module reuses verbatim — midday owns
// [04:00, 17:30), evening owns [17:30, next 04:00) — so the two presets below
// are gapless by construction and `mediodia + noche === hoy` always holds.
// This slice does NOT redesign schedule configuration (GAP-09 stays out of
// scope); it only reads what serviceSchedule already declares.
//
// HALF-OPEN. Every interval is [from, to): `from` inclusive, `to` exclusive.
// One convention, no double counting when two windows are laid end to end.
// ===============================================================

const {
  TIMEZONE,
  DEFAULT_SCHEDULE,
  madridParts,
  businessDateFor,
} = require("../schedule/serviceSchedule");

const MS_PER_MINUTE = 60000;
// A snapshot is an operator report, not a data export. The cap exists so a
// malformed or hostile range cannot ask the reader to walk years of rows.
const MAX_WINDOW_DAYS = 400;

const PRESET = Object.freeze({
  HOY: "hoy",
  AYER: "ayer",
  // Spanish preset vocabulary, matching the frontend's existing
  // closeoutServiceKind presentation ("SERVICIO · MEDIODÍA" / "SERVICIO ·
  // NOCHE"), which is explicit that the raw service_kind token is an internal
  // discriminant and is never rendered. These two names are the window; the
  // stamped economic era is reported separately by the snapshot itself.
  MEDIODIA: "mediodia",
  NOCHE: "noche",
  PERSONALIZADO: "personalizado",
  // Convenience only: resolved against the named session's own timestamps by
  // the snapshot reader, which then treats the result as an ordinary window.
  SERVICIO: "servicio",
});

const PRESET_VALUES = Object.freeze(Object.values(PRESET));

const PRESET_LABEL = Object.freeze({
  [PRESET.HOY]: "Hoy",
  [PRESET.AYER]: "Ayer",
  [PRESET.MEDIODIA]: "Mediodía",
  [PRESET.NOCHE]: "Noche",
  [PRESET.PERSONALIZADO]: "Personalizado",
  [PRESET.SERVICIO]: "Servicio",
});

class EconomicWindowError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "EconomicWindowError";
    this.code = code;
    this.status = status;
  }
}

// ── Madrid wall clock → UTC instant, DST-correct ────────────────────────────
// serviceSchedule.madridParts goes instant → wall clock; this is the inverse.
// Solved by iteration rather than a fixed offset: t = target - offset(t),
// converging in one step outside a DST transition and in two across one. Both
// boundaries this module ever asks for (04:00 and 17:30) sit far away from
// Madrid's 02:00-03:00 spring-forward gap, so the ambiguous-hour case cannot
// arise from any preset — an explicit `personalizado` range is supplied as
// real instants and never goes through here at all.
function madridInstant(dateStr, minutesOfDay, timezone = TIMEZONE) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new EconomicWindowError("ECONOMY_BUSINESS_DATE_INVALID");
  }
  const target = Date.UTC(year, month - 1, day) + minutesOfDay * MS_PER_MINUTE;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = madridParts(new Date(guess), timezone);
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const next = target - (observed - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

// Calendar-date arithmetic on the business date string. Deliberately NOT
// "+24h on the instant": across a DST change the business day is 23 or 25
// hours long, and its end is the NEXT date's 04:00, not 24h after its start.
function shiftBusinessDate(dateStr, days) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function businessDayStart(dateStr, schedule = DEFAULT_SCHEDULE) {
  return madridInstant(dateStr, schedule.rolloverMin, schedule.timezone);
}

function middayBoundary(dateStr, schedule = DEFAULT_SCHEDULE) {
  return madridInstant(dateStr, schedule.lunchBoundaryMin, schedule.timezone);
}

function parseInstant(value, code) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" || !value.trim()) throw new EconomicWindowError(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new EconomicWindowError(code);
  return parsed;
}

function freezeWindow({ preset, from, to, businessDate = null, timezone, serviceSessionId = null }) {
  if (!(from instanceof Date) || !(to instanceof Date)) {
    throw new EconomicWindowError("ECONOMY_WINDOW_INVALID");
  }
  if (to.getTime() <= from.getTime()) throw new EconomicWindowError("ECONOMY_WINDOW_NOT_ORDERED");
  const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * MS_PER_MINUTE);
  if (spanDays > MAX_WINDOW_DAYS) throw new EconomicWindowError("ECONOMY_WINDOW_TOO_WIDE");
  return Object.freeze({
    preset,
    label: PRESET_LABEL[preset] || PRESET_LABEL[PRESET.PERSONALIZADO],
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    businessDate,
    serviceSessionId,
    // Stated on the wire so no consumer has to guess the boundary convention.
    bounds: "[from,to)",
  });
}

// resolveEconomicWindow({ preset, from, to, businessDate, now, schedule })
//   -> frozen { preset, label, from, to, timezone, businessDate, bounds }
//
// Pure: reads no clock beyond the `now` handed in, touches no database. The
// "servicio" preset is deliberately NOT resolvable here (it needs the session
// row) — the snapshot reader resolves it and then calls back in with a plain
// explicit window, so this module never grows a data dependency.
function resolveEconomicWindow({
  preset = PRESET.HOY,
  from,
  to,
  businessDate,
  now = new Date(),
  schedule = DEFAULT_SCHEDULE,
} = {}) {
  const key = String(preset || "").trim().toLowerCase();
  if (!PRESET_VALUES.includes(key)) throw new EconomicWindowError("ECONOMY_PRESET_UNKNOWN");
  if (key === PRESET.SERVICIO) throw new EconomicWindowError("ECONOMY_PRESET_NEEDS_SESSION");

  const timezone = schedule.timezone || TIMEZONE;

  if (key === PRESET.PERSONALIZADO) {
    return freezeWindow({
      preset: key,
      from: parseInstant(from, "ECONOMY_WINDOW_FROM_INVALID"),
      to: parseInstant(to, "ECONOMY_WINDOW_TO_INVALID"),
      timezone,
    });
  }

  const today = businessDateFor(now, schedule);
  const day = businessDate
    ? String(businessDate).trim()
    : key === PRESET.AYER ? shiftBusinessDate(today, -1) : today;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new EconomicWindowError("ECONOMY_BUSINESS_DATE_INVALID");

  const dayStart = businessDayStart(day, schedule);
  const nextDayStart = businessDayStart(shiftBusinessDate(day, 1), schedule);

  if (key === PRESET.HOY || key === PRESET.AYER) {
    return freezeWindow({ preset: key, from: dayStart, to: nextDayStart, businessDate: day, timezone });
  }
  const boundary = middayBoundary(day, schedule);
  if (key === PRESET.MEDIODIA) {
    return freezeWindow({ preset: key, from: dayStart, to: boundary, businessDate: day, timezone });
  }
  return freezeWindow({ preset: key, from: boundary, to: nextDayStart, businessDate: day, timezone });
}

// Used by the snapshot reader once it has read the session row. A service
// that is still open has no closed_at; its window runs to `asOf`, which is
// the reading instant — never "now inside the DB", and never a lifecycle read.
function windowForServiceSession(session, { asOf = new Date(), schedule = DEFAULT_SCHEDULE } = {}) {
  if (!session || !session.id || !session.opened_at) {
    throw new EconomicWindowError("ECONOMY_SERVICE_SESSION_NOT_FOUND", 404);
  }
  const from = parseInstant(session.opened_at, "ECONOMY_WINDOW_FROM_INVALID");
  const rawTo = session.closed_at ? parseInstant(session.closed_at, "ECONOMY_WINDOW_TO_INVALID") : asOf;
  // Half-open [from, to) would drop a receipt recorded in the very same
  // millisecond as the close. A closed service's own last event is routinely
  // written inside the close transaction, so the end is nudged by 1ms to keep
  // the interval honest for the one boundary the operator did not choose.
  const to = session.closed_at ? new Date(rawTo.getTime() + 1) : rawTo;
  return freezeWindow({
    preset: PRESET.SERVICIO,
    from,
    to,
    businessDate: session.business_date || null,
    timezone: schedule.timezone || TIMEZONE,
    serviceSessionId: String(session.id),
  });
}

// ── N-9: the ledger reader's window ────────────────────────────────────────
// getEconomiaLedger is a BUSINESS-DATE-scoped, service-scoped reader (it walks
// service_sessions by business_date), not a timestamp-window reader, and that
// is deliberate -- see the module header above and N-8. What it lacked was any
// statement of WHICH calendar those `business_date` keys belong to, so the
// frontend filled the gap with the operator's browser clock.
//
// This resolves the inclusive business-date pair the action was asked for into
// the same half-open [from, to) instants every other window here uses: `to` is
// the NEXT business day's 04:00 Madrid, never 23:59:59.999, and both boundaries
// go through the DST-correct madridInstant().
function resolveEconomiaLedgerWindow({ desde, hasta, now = new Date(), schedule = DEFAULT_SCHEDULE } = {}) {
  const timezone = schedule.timezone || TIMEZONE;
  const window = Object.freeze({
    timezone,
    businessDateFrom: desde || null,
    businessDateTo: hasta || null,
    businessDateToday: businessDateFor(now, schedule),
    from: desde ? businessDayStart(desde, schedule).toISOString() : null,
    to: hasta ? businessDayStart(shiftBusinessDate(hasta, 1), schedule).toISOString() : null,
    bounds: "[from,to)",
  });
  return { window, generatedAt: now.toISOString() };
}

module.exports = {
  PRESET,
  PRESET_VALUES,
  PRESET_LABEL,
  MAX_WINDOW_DAYS,
  EconomicWindowError,
  resolveEconomicWindow,
  resolveEconomiaLedgerWindow,
  windowForServiceSession,
  madridInstant,
  shiftBusinessDate,
  businessDayStart,
  middayBoundary,
};
