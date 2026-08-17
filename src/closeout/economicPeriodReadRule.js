"use strict";
// economicPeriodReadRule.js — S-E, the ONE centralized era-aware economic-kind
// language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe what this module classifies, not new vocabulary
// read rule. Every reader that needs "what economic window (PRANZO/SERA) does
// this fact belong to" goes through this, so the fallback logic is never
// reinvented per-file.
//
// Rule (frozen by the S-E task brief):
//   explicit S-C stamp present  -> stamp is authoritative
//   stamp NULL (pre-S-C fact)   -> fall back to the fact's own parent
//                                   service_sessions.service_kind, valid
//                                   because every economic_period_v1-era row
//                                   has a non-null service_kind (S-B's own
//                                   era-aware CHECK guarantees this — an
//                                   operational_service_v1 row's service_kind
//                                   is always NULL by the same constraint, so
//                                   this already degrades correctly without a
//                                   separate lifecycle_semantics branch).
//
// Never re-derives from the current clock/schedule (E1 invariant, S-C). Never
// guesses across a genuine session boundary it cannot see.
const KNOWN_KINDS = new Set(["PRANZO", "SERA"]); // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, the only two known economic-period kinds, not new vocabulary

// resolveEconomicPeriodKind(explicitStamp, session) -> 'PRANZO' | 'SERA' | null
function resolveEconomicPeriodKind(explicitStamp, session) {
  if (KNOWN_KINDS.has(explicitStamp)) return explicitStamp;
  const fallback = session && session.service_kind;
  return KNOWN_KINDS.has(fallback) ? fallback : null;
}

// Given a set of resolved kinds actually observed for one reporting scope
// (e.g. every ticket in a closeout), returns the single kind if exactly one
// distinct known kind was observed, else null — never asserts a single label
// for a scope that genuinely spans both economic windows (Phase 8: identity
// must not lie about being single-kind), while staying byte-identical to
// today's behavior for every scope that has always been single-kind (which,
// as of S-E, is still every real historical scope).
function singleKindOrNull(kinds) {
  const distinct = new Set([...kinds].filter((k) => KNOWN_KINDS.has(k)));
  return distinct.size === 1 ? [...distinct][0] : null;
}

module.exports = { resolveEconomicPeriodKind, singleKindOrNull, KNOWN_KINDS };
