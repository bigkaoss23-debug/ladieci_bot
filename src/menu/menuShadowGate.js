"use strict";

const BLOCKING = Object.freeze(["TARGET_MISMATCH", "KIND_MISMATCH", "DYNAMIC_UNMATCHED", "ERROR"]);

function evaluateShadowGate({ counts = {}, ambiguities = [], documentedAmbiguities = [] } = {}) {
  const documented = new Set(documentedAmbiguities.map(String));
  const undocumentedAmbiguities = ambiguities.map(String).filter((item) => !documented.has(item)).sort();
  const blocking = BLOCKING.filter((classification) => Number(counts[classification] || 0) > 0);
  return Object.freeze({
    green: blocking.length === 0 && undocumentedAmbiguities.length === 0,
    blocking: Object.freeze(blocking),
    undocumentedAmbiguities: Object.freeze(undocumentedAmbiguities),
    expansions: Number(counts.DYNAMIC_EXPANSION || 0),
  });
}

module.exports = { BLOCKING, evaluateShadowGate };
