"use strict";

const crypto = require("crypto");
const { resolveMenuReference } = require("./menuSemanticResolver");

const CLASSIFICATIONS = Object.freeze([
  "MATCH",
  "DYNAMIC_AMBIGUOUS",
  "DYNAMIC_UNMATCHED",
  "KIND_MISMATCH",
  "TARGET_MISMATCH",
  "LEGACY_UNMATCHED_DYNAMIC_MATCH",
  "ERROR",
]);

function normalizeForComparison(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function safeId(value) {
  return value == null || value === "" ? null : String(value);
}

function classify(legacy, dynamic) {
  if (dynamic.ambiguous) return "DYNAMIC_AMBIGUOUS";
  if (!legacy.matched && dynamic.matched) return "LEGACY_UNMATCHED_DYNAMIC_MATCH";
  if (legacy.matched && !dynamic.matched) return "DYNAMIC_UNMATCHED";
  if (!legacy.matched && !dynamic.matched) return "MATCH";
  if (legacy.kind !== dynamic.kind) return "KIND_MISMATCH";

  const legacyId = safeId(legacy.canonicalId);
  const dynamicId = safeId(dynamic.canonicalId);
  const sameTarget = legacyId && dynamicId
    ? legacyId === dynamicId
    : normalizeForComparison(legacy.canonicalName) === normalizeForComparison(dynamic.canonicalName);
  return sameTarget ? "MATCH" : "TARGET_MISMATCH";
}

function diagnosticFor({ input, legacy, dynamic, classification, menuSource }) {
  const normalized = normalizeForComparison(input);
  return Object.freeze({
    inputHash: crypto.createHash("sha256").update(normalized, "utf8").digest("hex"),
    classification,
    legacyKind: legacy.kind || null,
    legacyCanonicalId: safeId(legacy.canonicalId),
    dynamicKind: dynamic.kind || null,
    dynamicCanonicalId: safeId(dynamic.canonicalId),
    menuSource: menuSource || "unknown",
    counters: Object.freeze({ [classification]: 1 }),
  });
}

function compareLegacyAndDynamicResolution({ input, legacyResult, canonicalMenu, menuSource } = {}) {
  const legacy = legacyResult && typeof legacyResult === "object"
    ? legacyResult
    : { matched: false, kind: null, canonicalId: null, canonicalName: null };
  try {
    const dynamic = resolveMenuReference(input, canonicalMenu);
    const classification = classify(legacy, dynamic);
    return Object.freeze({
      classification,
      diagnostic: diagnosticFor({ input, legacy, dynamic, classification, menuSource }),
    });
  } catch (_) {
    const classification = "ERROR";
    const dynamic = { kind: null, canonicalId: null };
    return Object.freeze({
      classification,
      diagnostic: diagnosticFor({ input, legacy, dynamic, classification, menuSource }),
    });
  }
}

module.exports = { CLASSIFICATIONS, compareLegacyAndDynamicResolution };
