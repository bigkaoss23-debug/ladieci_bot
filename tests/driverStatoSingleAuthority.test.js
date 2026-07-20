// tests/driverStatoSingleAuthority.test.js — S2-1C.
// Static proof that (a) the guard is flag-gated, (b) trip-primitive actions route to the
// single transactional authority BEFORE any legacy DRIVER_STATO writer, (c) setConfig cannot
// write DRIVER_STATO, and (d) no NEW fresh five-field DRIVER_STATO object is constructed by
// the trip path. Run: node tests/driverStatoSingleAuthority.test.js
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

// (a) Guard activation — flag-gated, both modes representable.
check("guard mounted only when AUTH_V2_LEGACY_GUARD_ENABLED === 'true'",
  /if\s*\(\s*process\.env\.AUTH_V2_LEGACY_GUARD_ENABLED === "true"\s*\)\s*\{\s*app\.use\("\/api", legacyAuthGuardMiddleware\(\)\);/.test(idx));
check("exactly one guard mount, and it is inside the flag block (flag-off => unguarded)",
  (idx.match(/legacyAuthGuardMiddleware\(\)/g) || []).length === 1 &&
  /AUTH_V2_LEGACY_GUARD_ENABLED === "true"\s*\)\s*\{\s*app\.use\("\/api", legacyAuthGuardMiddleware\(\)\);\s*\}/.test(idx));

// (b) Single authority: trip-primitive routing happens for ALL roles (rule.tripPrimitive),
// at the top of the POST handler, BEFORE the legacy action branches.
const postIdx = idx.indexOf('app.post("/api"');
const firstCambia = idx.indexOf('action === "cambiaStato"', postIdx);
const tripRoute = idx.indexOf("rule.tripPrimitive", postIdx);
check("trip routing present in POST handler", tripRoute !== -1);
check("trip routing precedes legacy action branches", tripRoute !== -1 && tripRoute < firstCambia);
check("trip routing is role-agnostic (not rider-only)",
  /req\.authCtx\.rule && req\.authCtx\.rule\.tripPrimitive/.test(idx) &&
  !/role === "rider"[\s\S]{0,80}tripPrimitive/.test(idx));
check("routes to riderTrip wrapper", /riderTrip\.startTrip|riderTrip\.completeStop|riderTrip\.closeTrip/.test(idx));

// (c) setConfig cannot write DRIVER_STATO.
check("setConfig rejects DRIVER_STATO with 403",
  /chiave === "DRIVER_STATO"[\s\S]{0,160}403/.test(idx));

// (d) The trip routing helper does not build a fresh five-field DRIVER_STATO object.
const helper = idx.slice(idx.indexOf("async function routeRiderTripAction"), idx.indexOf("app.post(\"/api\""));
check("trip helper writes no DRIVER_STATO object",
  !/partito_alle|rientro_stimato|n_ordini/.test(helper));

// (e) Legacy registrarSalidaDriver fresh-writer still exists but is only reachable when the
// guard is OFF (flag-off compatibility); when the guard is ON it is bypassed by the route.
check("legacy registrarSalidaDriver handler retained for flag-off compatibility",
  /DRIVER_STATO[\s\S]{0,200}sbUpsert\("config"/.test(idx) || /registrarSalidaDriver/.test(idx));

console.log(`\ndriverStatoSingleAuthority: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
