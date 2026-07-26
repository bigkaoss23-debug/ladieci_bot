"use strict";
// S2-7D6B3 — this module used to ALSO be a second, competing intake cutoff: it
// capped every requested hora at a hardcoded 23:00 and required a tracked manual
// override past it (bot-only in creaOrdine, but unconditionally in
// modificaOrdine — an asymmetry in its own right). That cap had no corresponding
// concept in the approved service-window policy and silently contradicted it: a
// 23:50 order is a normal SERA_WINDOW order per serviceSchedule.js /
// orderIntakePolicy.js, yet this module rejected its own requested hora and
// orchestrator.js told the customer "no aceptamos pedidos después de las 23:00".
//
// The ONE authoritative "may a brand-new order be created right now" decision
// lives in orderIntakePolicy.js, fed by serviceSchedule.js. This module keeps
// only what neither of those own and what still applies regardless of channel
// or clock: is the requested hora string even a well-formed HH:MM? That is a
// format check, not a business-hours cutoff.

const FUERA_HORARIO_INVALIDA = "HORA_INVALIDA";
const HORA_INVALIDA_MSG = "Hora inválida";

function horaToMinStrict(hora) {
  const m = String(hora || "").trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  return h * 60 + min;
}

function horaInvalidaError(hora) {
  return {
    success: false,
    error: FUERA_HORARIO_INVALIDA,
    code: FUERA_HORARIO_INVALIDA,
    hora: hora || "",
    message: HORA_INVALIDA_MSG,
  };
}

// Format-only. Whether a brand-new order may be created right now is
// orderIntakePolicy.js's job, not this function's — there is no ceiling here.
function validateHoraFormat(hora) {
  const min = horaToMinStrict(hora);
  if (min == null) return horaInvalidaError(hora);
  return { success: true };
}

module.exports = {
  FUERA_HORARIO_INVALIDA,
  HORA_INVALIDA_MSG,
  horaToMinStrict,
  horaInvalidaError,
  validateHoraFormat,
};
