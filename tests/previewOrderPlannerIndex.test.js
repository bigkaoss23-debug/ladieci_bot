// tests/previewOrderPlannerIndex.test.js
// ===============================================================
// Static guard: index.js wires the previewOrderPlanner action correctly.
// Run: node tests/previewOrderPlannerIndex.test.js
//
// Pure source inspection — does NOT start the server and does NOT touch a DB.
// Verifies the read-only wiring contract:
//   - imports previewOrderPlanner + createReadOnlyRestDb
//   - dispatches action "previewOrderPlanner"
//   - passes db: createReadOnlyRestDb({ sbSelect }) and no live resolver/writer
//   - leaves previewOrderTiming untouched
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

console.log("\n── index.js previewOrderPlanner wiring ──");

// Imports
check("imports previewOrderPlanner",
  /require\(["']\.\/src\/agents\/previewOrderPlanner["']\)/.test(src));
check("imports createReadOnlyRestDb",
  /require\(["']\.\/src\/core\/delivery\/readOnlyRestDb["']\)/.test(src));

// Action present
check('dispatches action "previewOrderPlanner"',
  /action === ["']previewOrderPlanner["']/.test(src));

// Calls previewOrderPlanner with read-only REST db
check("calls previewOrderPlanner(req.body, { db: createReadOnlyRestDb({ sbSelect }) })",
  /previewOrderPlanner\(\s*req\.body[^)]*\{[\s\S]*?db:\s*createReadOnlyRestDb\(\{\s*sbSelect\s*\}\)[\s\S]*?\}\s*\)/.test(src));

// Does NOT pass a live geo resolver through index.js
check("does NOT pass resolveDeliveryFields from index.js",
  !/resolveDeliveryFields/.test(src));

// Does NOT pass any writer into previewOrderPlanner deps
const plannerCall = (src.match(/previewOrderPlanner\(req\.body[^;]*\}\s*\);/) || [""])[0];
check("planner deps do not include sbInsert/sbUpdate/sbUpsert/sbDelete",
  !/sb(Insert|Update|Upsert|Delete)/.test(plannerCall), plannerCall);

// previewOrderTiming preserved (string + call still present, unchanged)
check("previewOrderTiming action still present",
  /action === ["']previewOrderTiming["']/.test(src));
check("previewOrderTiming still invoked",
  /await previewOrderTiming\(req\.body \|\| \{\}\)/.test(src));

// No banned planner
check("no proposeForNewOrder in index.js", !/proposeForNewOrder/.test(src));

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
