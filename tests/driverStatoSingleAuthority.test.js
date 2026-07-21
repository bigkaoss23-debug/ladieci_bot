// tests/driverStatoSingleAuthority.test.js — S2-1D.
// Static proof (comments stripped) that DRIVER_STATO/trip state has ONE mutation authority:
// the Supabase rider-trip RPC migration. No JS production path writes a fresh five-field
// object, replaces DRIVER_STATO, sets rientro_stimato, snapshots, or inserts a delivery log
// independently. Run: node tests/driverStatoSingleAuthority.test.js
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const strip = (s) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));

const idx = read("index.js");
const tele = read("src/utils/driverTelemetry.js");
const ordini = read("src/agents/agentOrdini.js");
const rpc = read("migrations/2026-07-20_rider_trip_rpcs.sql");
const servizio = read("src/utils/servizio.js");

// (1) Only the RPC migration writes extended trip state (config UPDATE + snapshot + one log).
check("RPC writes DRIVER_STATO config", /UPDATE public\.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO'/.test(rpc));
check("RPC writes exactly one delivery_logs insert on close", (rpc.match(/INSERT INTO public\.delivery_logs/g) || []).length === 1);

// Extract a single async-function body: from "async function NAME" up to the next
// "async function" or "module.exports".
function funcBody(src, name) {
  const start = src.indexOf("async function " + name);
  if (start === -1) return "";
  const rest = src.slice(start + 10);
  const nextFn = rest.indexOf("async function ");
  const nextExp = rest.indexOf("module.exports");
  let end = rest.length;
  if (nextFn !== -1) end = Math.min(end, nextFn);
  if (nextExp !== -1) end = Math.min(end, nextExp);
  return rest.slice(0, end);
}

// (2) No JS module constructs a WRITABLE five-field DRIVER_STATO object. driverTelemetry
// makes NO sbUpsert/sbInsert calls at all (writeDriverStato is a disabled no-op, and it
// has no callers).
check("driverTelemetry makes no sbUpsert/sbInsert calls", !/sbUpsert\(/.test(tele) && !/sbInsert\(/.test(tele));
check("no active writeDriverStato caller (definition only)",
  !/writeDriverStato\(/.test(tele.replace(/async function writeDriverStato\(_obj\)/, "")));

// (3) S2-1E — NO JS module writes DRIVER_STATO at all now (not even the service reset).
check("index legacy has no DRIVER_STATO sbUpsert", !/sbUpsert\("config", \{ chiave: "DRIVER_STATO"/.test(idx));
check("servizio no longer writes DRIVER_STATO directly", !/sbUpsert\("config", \{ chiave: "DRIVER_STATO"/.test(servizio));
check("servizio end-of-service reset routes through reset_rider_state_if_idle RPC",
  /resetIfIdle\(\)/.test(servizio));

// (4) recordRiderOut — obsolete, no write.
const rroBody = funcBody(tele, "recordRiderOut");
check("recordRiderOut is an inert stub (no write)",
  /obsolete_use_start_rider_trip/.test(rroBody) && !/writeDriverStato|sbUpsert|sbInsert/.test(rroBody));

// (5) closeGiroInternal — thin RPC wrapper; no direct write / log / idempotency calc.
const cgiBody = funcBody(tele, "closeGiroInternal");
check("closeGiroInternal delegates to riderTrip.closeTrip", /riderTrip\.closeTrip\(/.test(cgiBody));
check("closeGiroInternal has no direct writeDriverStato / delivery_logs insert",
  !/writeDriverStato|sbInsert\("delivery_logs"|sbUpsert/.test(cgiBody));

// (6) recordDeliveryAndMaybeReturn — only requests close via closeGiroInternal.
const rdBody = funcBody(tele, "recordDeliveryAndMaybeReturn");
check("recordDeliveryAndMaybeReturn routes to closeGiroInternal only",
  /closeGiroInternal\(/.test(rdBody) && !/writeDriverStato|sbInsert|sbUpsert|countActiveDeliveries/.test(rdBody));

// (7) agentOrdini reconciliation calls only close reconciliation, no recordRiderOut.
check("agentOrdini hook no longer calls recordRiderOut", !/await recordRiderOut\(/.test(ordini));
check("agentOrdini reconciliation uses recordDeliveryAndMaybeReturn", /await recordDeliveryAndMaybeReturn\(/.test(ordini));

// (8) setConfig rejects DRIVER_STATO.
check("setConfig rejects DRIVER_STATO with 403", /chiave === "DRIVER_STATO"[\s\S]{0,160}403/.test(idx));

// (9) Guard flag-gated; trip routing precedes legacy branches; all roles use wrapper.
check("guard mounted only under flag",
  /AUTH_V2_LEGACY_GUARD_ENABLED === "true"\s*\)\s*\{\s*app\.use\("\/api", legacyAuthGuardMiddleware\(\)\);\s*\}/.test(idx));
const postIdx = idx.indexOf('app.post("/api"');
check("trip routing precedes legacy branches",
  idx.indexOf("rule.tripPrimitive", postIdx) !== -1 &&
  idx.indexOf("rule.tripPrimitive", postIdx) < idx.indexOf('action === "cambiaStato"', postIdx));
check("trip routing role-agnostic (rule.tripPrimitive, not rider-only)",
  /req\.authCtx\.rule && req\.authCtx\.rule\.tripPrimitive/.test(idx));
check("legacy registrarSalidaDriver is an inert no-op (no DRIVER_STATO write)",
  /action === "registrarSalidaDriver"[\s\S]{0,260}managed_by_trip_rpc/.test(idx) &&
  !/action === "registrarSalidaDriver"[\s\S]{0,260}sbUpsert/.test(idx));

// (10) S2-1E global invariant — NO JavaScript writer anywhere in src/index mutates
// DRIVER_STATO. Scan every .js file (comments stripped) for a config write carrying
// DRIVER_STATO. The only DRIVER_STATO mutations must live in the SQL RPCs.
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...walk(fp)); }
    else if (e.name.endsWith(".js")) out.push(fp);
  }
  return out;
}
const root = path.join(__dirname, "..");
const jsFiles = [path.join(root, "index.js"), ...walk(path.join(root, "src"))];
let offenders = [];
for (const f of jsFiles) {
  const s = strip(fs.readFileSync(f, "utf8"));
  // A config write (sbUpsert/sbUpdate/sbInsert) whose statement mentions DRIVER_STATO.
  const re = /(sbUpsert|sbUpdate|sbInsert)\([^;]*DRIVER_STATO/g;
  if (re.test(s)) offenders.push(path.relative(root, f));
}
check("no JS writer mutates DRIVER_STATO (whole src/index scan)", offenders.length === 0);
if (offenders.length) console.log("    offenders:", offenders.join(", "));

console.log(`\ndriverStatoSingleAuthority: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
