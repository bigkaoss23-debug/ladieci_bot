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
  loadCanonicalMenu,
  emitDiagnostic = () => {},
} = {}) {
  if (!enabled) return { executed: false, diagnostics: [], legacyItems };
  if (typeof loadCanonicalMenu !== "function") return { executed: true, diagnostics: [], legacyItems, error: true };

  try {
    const canonical = await loadCanonicalMenu();
    const source = canonical?.cacheMeta?.source || "unknown";
    const diagnostics = legacyReferences(legacyItems).map((reference) =>
      compareLegacyAndDynamicResolution({ ...reference, canonicalMenu: canonical, menuSource: source }).diagnostic
    );
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
    try { emitDiagnostic(comparison.diagnostic); } catch (_) { /* best effort only */ }
    return { executed: true, diagnostics: [comparison.diagnostic], legacyItems, error: true };
  }
}

module.exports = { legacyReferences, runWhatsappMenuShadow };
