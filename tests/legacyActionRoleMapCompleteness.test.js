// tests/legacyActionRoleMapCompleteness.test.js — S2-1B.
// Proves the canonical role map covers every action in the index.js legacy dispatcher,
// has no orphan mapped actions (except the documented special "shadowPreview"), enforces
// deny-by-default, and encodes the accepted role rules. Run: node tests/....test.js
// Pure/offline: reads index.js as text, no network/DB.

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const map = require("../src/auth/legacyActionRoles");

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label); } }

const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const dispatcherActions = [...new Set(
  [...idx.matchAll(/action === "([a-zA-Z]+)"/g)].map((m) => m[1])
)].sort();

// Every dispatcher action exists in the canonical map.
for (const a of dispatcherActions) {
  check("map covers dispatcher action: " + a, map.isKnownAction(a));
}

// No mapped action lacks a dispatcher case, except the documented "shadowPreview"
// (special REST path, not an action=== case).
for (const a of map.ALL_ACTIONS) {
  if (a === "shadowPreview") continue;
  check("mapped action has dispatcher case: " + a, dispatcherActions.includes(a));
}

// Deny-by-default for unknown.
check("unknown action -> not known", map.isKnownAction("nope") === false);
check("unknown action -> null rule", map.getActionRule("nope") === null);
check("unknown action -> isAllowed false for every role",
  !map.isAllowed("admin", "nope") && !map.isAllowed("operator", "nope") && !map.isAllowed("rider", "nope"));

// Admin may perform every known action.
check("admin allowed for all known actions",
  map.ALL_ACTIONS.every((a) => map.isAllowed("admin", a)));

// Rider allow-list is exactly the accepted set.
const RIDER_EXPECTED = ["getOrdenes","getManualGiros","getDriverStatus","marcarEnEntrega","registrarSalidaDriver","marcarEntregado","chiudiGiro"].sort();
const riderActual = map.ALL_ACTIONS.filter((a) => map.isAllowed("rider", a)).sort();
check("rider allow-list is exactly the accepted set", JSON.stringify(riderActual) === JSON.stringify(RIDER_EXPECTED));
check("rider denied generic updateEstado", !map.isAllowed("rider", "updateEstado"));
check("rider denied read-only menu catalogue", !map.isAllowed("rider", "getMenu"));
check("admin/operator allowed read-only menu catalogue", map.isAllowed("admin", "getMenu") && map.isAllowed("operator", "getMenu"));

// Operator denied admin-only config/dev actions, allowed normal ops.
for (const a of ["setConfig","debugInterpreta","parseOrdineDaRisposta"]) check("operator denied admin-only: " + a, !map.isAllowed("operator", a));
for (const a of ["createOrden","updateOrden","cambiaStato","updateEstado","createManualGiro","dissolveManualGiro","previewOrderTiming","chiudiServizio","upsertCliente"]) check("operator allowed normal op: " + a, map.isAllowed("operator", a));

// Every rule requires a fresh session.
check("every action requires fresh session", map.ALL_ACTIONS.every((a) => map.getActionRule(a).fresh === true));

// tripPrimitive set is exactly the four routed rider write actions.
const tp = map.ALL_ACTIONS.filter((a) => map.getActionRule(a).tripPrimitive).sort();
check("tripPrimitive set exact", JSON.stringify(tp) === JSON.stringify(["chiudiGiro","marcarEnEntrega","marcarEntregado","registrarSalidaDriver"].sort()));

console.log(`\nlegacyActionRoleMapCompleteness: ${pass} passed, ${fail} failed (dispatcher actions: ${dispatcherActions.length})`);
process.exit(fail === 0 ? 0 : 1);
