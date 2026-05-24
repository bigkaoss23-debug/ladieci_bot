// Guardia unica di chiusura servizio: dopo le 23:00 serve override manuale tracciato.

const CLOSING_TIME_MIN = 23 * 60;
const FUERA_HORARIO_INVALIDA = "HORA_INVALIDA";
const FUERA_HORARIO_REQUIERE_OVERRIDE = "FUERA_HORARIO_REQUIERE_OVERRIDE";
const FUERA_HORARIO_OVERRIDE_MARKER = "FUERA_HORARIO_FORZADO";
const FUERA_HORARIO_REQUIERE_OVERRIDE_MSG = "Pedido fuera de horario. Requiere forzar manualmente.";
const HORA_INVALIDA_MSG = "Hora inválida";

function horaToMinStrict(hora) {
  const m = String(hora || "").trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  return h * 60 + min;
}

function isHoraDentroHorario(hora) {
  const min = horaToMinStrict(hora);
  return min != null && min <= CLOSING_TIME_MIN;
}

function isAfterClosing(hora) {
  const min = horaToMinStrict(hora);
  return min != null && min > CLOSING_TIME_MIN;
}

function hasFueraHorarioMarker(params = {}) {
  const nota = String(params.nota || "");
  const notaCucina = String(params.nota_cucina || "");
  return nota.includes(FUERA_HORARIO_OVERRIDE_MARKER) || notaCucina.includes(FUERA_HORARIO_OVERRIDE_MARKER);
}

function hasValidClosingOverride(params = {}) {
  return params.forzado === true && hasFueraHorarioMarker(params);
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

function requiereOverrideError(hora) {
  return {
    success: false,
    error: FUERA_HORARIO_REQUIERE_OVERRIDE,
    code: FUERA_HORARIO_REQUIERE_OVERRIDE,
    hora: hora || "",
    message: FUERA_HORARIO_REQUIERE_OVERRIDE_MSG,
  };
}

function validateClosingTime(params = {}, hora = params.hora) {
  const min = horaToMinStrict(hora);
  if (min == null) return horaInvalidaError(hora);
  if (min <= CLOSING_TIME_MIN) return { success: true };
  if (hasValidClosingOverride(params)) return { success: true, override: true };
  return requiereOverrideError(hora);
}

module.exports = {
  CLOSING_TIME_MIN,
  FUERA_HORARIO_INVALIDA,
  FUERA_HORARIO_REQUIERE_OVERRIDE,
  FUERA_HORARIO_OVERRIDE_MARKER,
  FUERA_HORARIO_REQUIERE_OVERRIDE_MSG,
  HORA_INVALIDA_MSG,
  horaToMinStrict,
  isHoraDentroHorario,
  isAfterClosing,
  hasFueraHorarioMarker,
  hasValidClosingOverride,
  horaInvalidaError,
  requiereOverrideError,
  validateClosingTime,
};
