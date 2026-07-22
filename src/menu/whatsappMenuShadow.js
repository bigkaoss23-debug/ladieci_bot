"use strict";

const { compareLegacyAndDynamicResolution } = require("./menuShadowComparison");

function legacyReferences(items) {
  const refs = [];
  for (const item of (Array.isArray(items) ? items : [])) {
    if (item && item.n) {
      refs.push({
        input: String(item.n),
        legacyResult: { matched: true, kind: "product", canonicalId: item.productId || item.databaseId || null, canonicalName: String(item.n) },
      });
    }
    const parts = String(item?.sub || "").split(",").map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const removal = part.match(/^(sin|senza|quitar|quita|togliere|togli)\s+(.+)$/i);
      if (removal) {
        refs.push({ input: part, legacyResult: { matched: true, kind: "ingredient_removal", canonicalId: null, canonicalName: removal[2] } });
        continue;
      }
      const extra = part.match(/^(?:extra|con|\+)\s*(.+)$/i);
      if (extra) refs.push({ input: extra[1], legacyResult: { matched: true, kind: "extra", canonicalId: null, canonicalName: extra[1] } });
    }
  }
  return refs;
}

async function runWhatsappMenuShadow({
  enabled = false,
  legacyItems,
  references,
  loadCanonicalMenu,
  emitDiagnostic = () => {},
  now = () => Date.now(),
} = {}) {
  if (!enabled) return { executed: false, diagnostics: [], legacyItems };
  if (typeof loadCanonicalMenu !== "function") return { executed: true, diagnostics: [], legacyItems, error: true };

  try {
    const startedAt = now();
    const canonical = await loadCanonicalMenu();
    const source = canonical?.cacheMeta?.source || "unknown";
    const resolvedReferences = Array.isArray(references) ? references : legacyReferences(legacyItems);
    const diagnostics = resolvedReferences.map((reference) => ({
      ...compareLegacyAndDynamicResolution({ ...reference, canonicalMenu: canonical, menuSource: source }).diagnostic,
      event: "dynamic_menu_shadow",
      durationMs: Math.max(0, now() - startedAt),
      errorCode: null,
    }));
    for (const diagnostic of diagnostics) {
      try { emitDiagnostic(diagnostic); } catch (_) { /* diagnostics never affect operations */ }
    }
    return { executed: true, diagnostics, legacyItems };
  } catch (_) {
    const comparison = compareLegacyAndDynamicResolution({
      input: "",
      legacyResult: { matched: false },
      canonicalMenu: null,
      menuSource: "error",
    });
    const diagnostic = {
      ...comparison.diagnostic,
      event: "dynamic_menu_shadow",
      durationMs: 0,
      errorCode: "MENU_LOAD_FAILED",
    };
    try { emitDiagnostic(diagnostic); } catch (_) { /* best effort only */ }
    return { executed: true, diagnostics: [diagnostic], legacyItems, error: true };
  }
}

module.exports = { legacyReferences, runWhatsappMenuShadow };
