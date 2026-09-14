// tests/deliveryChannels.test.js
// ===============================================================
// DELIVERY CHANNELS — pure offline test (Premium Planner fase 1)
// Run: node tests/deliveryChannels.test.js
//
// Boundary:
//   - deliveryChannels.js è config pura: niente DB, fetch, env, wiring.
//   - Questo test è offline: solo fixture e assert sulla shape/decisione.
//   - Sorgente di verità per opportunity.channel (sur|oeste|cross).
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const {
  CHANNELS,
  HUB_ZONE,
  ZONE_CHANNEL,
  getZoneChannel,
  routeChannel,
  isRouteChannelCompatible,
  classifyChannelPair,
  orderZonesByChannel,
} = require("../src/core/delivery/deliveryChannels");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => v === b[i]);

console.log("══ Config shape ══");
check("HUB_ZONE is Q1", HUB_ZONE === "Q1");
check("sur sequence Q1→Q2→Q5", eqArr(CHANNELS.sur.sequence, ["Q1", "Q2", "Q5"]));
check("oeste sequence Q1→Q3→Q4", eqArr(CHANNELS.oeste.sequence, ["Q1", "Q3", "Q4"]));
check("ZONE_CHANNEL covers Q1..Q5", ["Q1", "Q2", "Q3", "Q4", "Q5"].every(z => ZONE_CHANNEL[z]));

console.log("══ getZoneChannel ══");
check("Q1 = hub", getZoneChannel("Q1") === "hub");
check("Q2 = sur", getZoneChannel("Q2") === "sur");
check("Q5 = sur", getZoneChannel("Q5") === "sur");
check("Q3 = oeste", getZoneChannel("Q3") === "oeste");
check("Q4 = oeste", getZoneChannel("Q4") === "oeste");
check("lowercase q2 = sur (normalized)", getZoneChannel("q2") === "sur");
check("unknown zone = null", getZoneChannel("Q9") === null);
check("null zone = null", getZoneChannel(null) === null);

console.log("══ routeChannel ══");
check("[Q2,Q5] = sur", routeChannel(["Q2", "Q5"]) === "sur");
check("[Q3,Q4] = oeste", routeChannel(["Q3", "Q4"]) === "oeste");
check("[Q1,Q2,Q5] = sur (hub neutral)", routeChannel(["Q1", "Q2", "Q5"]) === "sur");
check("[Q1,Q3,Q4] = oeste (hub neutral)", routeChannel(["Q1", "Q3", "Q4"]) === "oeste");
check("[Q5,Q3] = cross", routeChannel(["Q5", "Q3"]) === "cross");
check("[Q5,Q4] = cross", routeChannel(["Q5", "Q4"]) === "cross");
check("[Q2,Q4] = cross", routeChannel(["Q2", "Q4"]) === "cross");
check("[Q1] hub-only = null", routeChannel(["Q1"]) === null);
check("[] empty = null", routeChannel([]) === null);
check("[Q2,Q9] unknown = null", routeChannel(["Q2", "Q9"]) === null);
check("non-array = null", routeChannel("Q2") === null);

console.log("══ isRouteChannelCompatible ══");
check("[Q2,Q5] compatible", isRouteChannelCompatible(["Q2", "Q5"]) === true);
check("[Q1,Q2,Q5] compatible", isRouteChannelCompatible(["Q1", "Q2", "Q5"]) === true);
check("[Q5,Q3] NOT compatible (cross)", isRouteChannelCompatible(["Q5", "Q3"]) === false);
check("[Q1] hub-only NOT compatible (null, prudent)", isRouteChannelCompatible(["Q1"]) === false);

console.log("══ classifyChannelPair ══");
check("Q2+Q5 → sur compatible", (() => { const r = classifyChannelPair("Q2", "Q5"); return r.channel === "sur" && r.compatible === true; })());
check("Q5+Q3 → cross incompatible", (() => { const r = classifyChannelPair("Q5", "Q3"); return r.channel === "cross" && r.compatible === false; })());
check("Q5+Q4 → cross incompatible", (() => { const r = classifyChannelPair("Q5", "Q4"); return r.channel === "cross" && r.compatible === false; })());
check("Q2+Q4 → cross incompatible", (() => { const r = classifyChannelPair("Q2", "Q4"); return r.channel === "cross" && r.compatible === false; })());
check("Q1+Q2 → sur compatible (hub)", (() => { const r = classifyChannelPair("Q1", "Q2"); return r.channel === "sur" && r.compatible === true; })());
check("Q3+Q4 → oeste compatible", (() => { const r = classifyChannelPair("Q3", "Q4"); return r.channel === "oeste" && r.compatible === true; })());

console.log("══ orderZonesByChannel ══");
check("[Q5,Q2] → [Q2,Q5] (sur order)", eqArr(orderZonesByChannel(["Q5", "Q2"]), ["Q2", "Q5"]));
check("[Q5,Q2,Q1] → [Q1,Q2,Q5]", eqArr(orderZonesByChannel(["Q5", "Q2", "Q1"]), ["Q1", "Q2", "Q5"]));
check("[Q4,Q3] → [Q3,Q4] (oeste order)", eqArr(orderZonesByChannel(["Q4", "Q3"]), ["Q3", "Q4"]));
check("cross [Q5,Q3] kept as-is", eqArr(orderZonesByChannel(["Q5", "Q3"]), ["Q5", "Q3"]));
check("hub-only [Q1] kept as-is", eqArr(orderZonesByChannel(["Q1"]), ["Q1"]));
check("orderZonesByChannel returns a copy (no mutation)", (() => {
  const input = ["Q5", "Q2"];
  const out = orderZonesByChannel(input);
  return eqArr(input, ["Q5", "Q2"]) && out !== input;
})());

console.log("══ Purity / decoupling ══");
const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/deliveryChannels.js"), "utf8");
check("no require() of runtime deps", !/require\(/.test(src));
check("no fetch()", !/\bfetch\s*\(/.test(src));
check("no process.env", !/process\.env/.test(src));
check("no supabase/sb usage", !/supabase|sbSelect|sbInsert|sbUpdate/i.test(src));

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
