"use strict";
const { MENU_LISTA, ABBINAMENTI_NOMI } = require("../config");
const { resolveMenuReference } = require("./menuSemanticResolver");

const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const aliases = new Set(ABBINAMENTI_NOMI.split(", ").flatMap((group) => group.slice(0, group.lastIndexOf("=")).split("/").map(normalize)));
const exactMenuNames = new Set(MENU_LISTA.map((line) => normalize(line.replace(/^\d+\.\s*/, "").split(/\s+-\s+|\s+\d+(?:\.\d+)?$/)[0])));

function classifyLegacyMenuReferenceContext(input, canonicalMenu) {
  const normalized = normalize(input);
  const legacyStandalone = aliases.has(normalized) || exactMenuNames.has(normalized);
  if (!legacyStandalone) return Object.freeze({ classification: "NON_REFERENCE_CONTEXT", legacyMatched: false, dynamic: null });
  return Object.freeze({ classification: "REFERENCE", legacyMatched: true, dynamic: canonicalMenu ? resolveMenuReference(input, canonicalMenu) : null });
}

module.exports = { classifyLegacyMenuReferenceContext };
