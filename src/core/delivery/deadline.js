"use strict";
// ===============================================================
// PROTOTYPE — validation only, NOT committed. Frozen Delivery V1.
// deadline.js: delivery_deadline_at = created + N min (N default 55).
// Pure functions, Europe/Madrid via Intl, independent of process TZ.
// ===============================================================

const DELIVERY_DEADLINE_DEFAULT_MIN = 55;
const TZ = "Europe/Madrid";

const hhmmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ymdFmt  = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const wallFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

const part = (parts, t) => parts.find(p => p.type === t).value;

function formatMadridHHMM(ms) {
  const p = hhmmFmt.formatToParts(new Date(ms));
  return `${part(p, "hour")}:${part(p, "minute")}`;
}
function madridYMD(ms) {
  const p = ymdFmt.formatToParts(new Date(ms));
  return { y: +part(p, "year"), m: +part(p, "month"), d: +part(p, "day") };
}
function madridOffsetMs(ms) {
  const p = wallFmt.formatToParts(new Date(ms));
  const asUtc = Date.UTC(+part(p, "year"), +part(p, "month") - 1, +part(p, "day"),
    +part(p, "hour"), +part(p, "minute"), +part(p, "second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}
function madridWallToInstant(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let inst = guess - madridOffsetMs(guess);
  inst = guess - madridOffsetMs(inst); // second pass: DST edges
  return inst;
}

function resolveDeadlineMin(cfg) {
  const n = Number(cfg && cfg.DELIVERY_DEADLINE_MIN);
  return Number.isInteger(n) && n >= 15 && n <= 180 ? n : DELIVERY_DEADLINE_DEFAULT_MIN;
}

// creation instant + N minutes. Also returns the HH:MM mirror kept in `hora`.
function computeAutoDeadline(createdMs, minutes = DELIVERY_DEADLINE_DEFAULT_MIN) {
  const deadlineMs = createdMs + minutes * 60000;
  return { deadlineMs, deadlineIso: new Date(deadlineMs).toISOString(), hora: formatMadridHHMM(deadlineMs) };
}

// LEGACY rows (bot orders, pre-patch rows): `hora` is HH:MM without a date.
// Resolve to the instant closest to the row's own creation time (±1 Madrid day).
function legacyDeadlineFromHora(hora, refTs) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || "").trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  const ref = Number.isFinite(refTs) ? refTs : Date.now();
  const { y, m: mo, d } = madridYMD(ref);
  let best = null;
  for (const off of [-1, 0, 1]) {
    const inst = madridWallToInstant(y, mo, d + off, h, mi);
    if (best === null || Math.abs(inst - ref) < Math.abs(best - ref)) best = inst;
  }
  return best;
}

// ── [DEADLINE-HORA 2026-09-22] CANONICAL WRITER ───────────────────────────────
// delivery_deadline_at = max(createdMs + N min, absolute instant of `hora`).
//
// Product decision, explicit: FDV1 modelled ONE kind of order, ASAP, so the
// deadline ignored `hora` entirely. A scheduled order (created 18:00, promised
// 21:30) therefore went TARDE almost three hours early, climbed to the top of
// the kitchen ordering, zeroed its own priority `+` window and got grouped with
// giri three hours away. `hora` is the operator's promise to the customer and it
// now binds the deadline — bounded BELOW by createdMs + N, which stays the floor:
// the kitchen never gets less than N minutes of runway, whatever `hora` says.
//
// `hora` is HH:MM with no date: legacyDeadlineFromHora resolves it against the
// order's OWN creation instant (±1 Madrid day, DST-safe). It is the same reader
// already used for pre-FDV1 rows — one resolution rule, not two.
//
// Callers must pass the `hora` that is actually persisted on the row (for bot
// orders `horaFinale`, not the requested one: slot-search may shift it).
// Returns the same shape as computeAutoDeadline. Deterministic: same input,
// same output, no `Date.now()` inside.
function effectiveDeadline(createdMs, hora, minutes = DELIVERY_DEADLINE_DEFAULT_MIN) {
  const auto = computeAutoDeadline(createdMs, minutes);
  const promised = legacyDeadlineFromHora(hora, createdMs);
  if (!Number.isFinite(promised) || promised <= auto.deadlineMs) return auto;
  return { deadlineMs: promised, deadlineIso: new Date(promised).toISOString(), hora: formatMadridHHMM(promised) };
}

// One reader for every consumer. RITIRO has no deadline (pickup time stays `hora`).
function getOrderDeadlineMs(o) {
  if (!o || o.tipo_consegna !== "DOMICILIO") return null;
  if (o.delivery_deadline_at) {
    const t = Date.parse(o.delivery_deadline_at);
    if (Number.isFinite(t)) return t;
  }
  const ref = Number(o.ts) || (o.created_at ? Date.parse(o.created_at) : NaN);
  return legacyDeadlineFromHora(o.hora, ref);
}

const minuteFloor = (ms) => Math.floor(ms / 60000);

module.exports = {
  DELIVERY_DEADLINE_DEFAULT_MIN, resolveDeadlineMin, computeAutoDeadline, effectiveDeadline, formatMadridHHMM,
  legacyDeadlineFromHora, getOrderDeadlineMs, minuteFloor, madridWallToInstant, madridYMD,
};
