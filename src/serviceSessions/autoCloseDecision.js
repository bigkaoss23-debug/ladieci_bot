"use strict";
// ===============================================================
// autoCloseDecision.js — S2-7D6D
//
// THE single reconciliation decision shared by every auto-close trigger: the
// periodic cron tick, boot recovery, and the external cron-job.org backup
// (triggerCloseIfNeeded). Given "what session is currently open" and "what
// time is it", decide whether a close attempt is due — never whether to
// force one, and never how to perform it. chiudiServizio() remains the ONE
// close implementation; this module only answers "should we even try", so
// cron/boot/external can no longer diverge on that answer the way boot's old
// SERA-only hour-window heuristic did.
//
// Pure: same (now, session) in, same decision out. No DB, no clock read
// beyond the `now` handed in — provable offline with an injected clock and a
// fabricated session row, exactly like serviceSchedule.js itself.
// ===============================================================

const {
  DEFAULT_SCHEDULE, SERVICE_KIND, resolveSchedule, closeEligibility,
} = require("../schedule/serviceSchedule");

function computeAutoCloseDecision({ now = new Date(), session = null, schedule = DEFAULT_SCHEDULE } = {}) {
  if (!session || !session.id) return { due: false, reason: "no_active_session" };
  if (!["open", "closing"].includes(session.status)) return { due: false, reason: "not_active" };

  const kind = session.service_kind || null;
  const when = resolveSchedule(now, schedule);
  const gate = closeEligibility(kind, now, schedule);
  if (!gate.eligible) return { due: false, reason: gate.reason, kind };

  // 04:00 is an ESCALATION boundary, never a blind destructive close: the
  // caller still only runs the normal protected close, just flags it loudly.
  return {
    due: true,
    kind,
    escalate: !!when.isEscalationBoundary,
    source: kind === SERVICE_KIND.PRANZO ? "cron_lunch" : "cron_dinner",
  };
}

module.exports = { computeAutoCloseDecision };
