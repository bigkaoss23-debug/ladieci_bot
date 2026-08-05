"use strict";
// ONDA 0B — proves the Railway build enforcement mechanism by parsing
// versioned configuration only. No network calls, no live Railway state.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

test("the Railway build command runs the language guard (Railpack detects package.json > scripts > build)", () => {
  assert.equal(pkg.scripts.build, "npm run check:domain-language");
});

test("npm start is unchanged — the guard is not part of the runtime boot command", () => {
  assert.equal(pkg.scripts.start, "node index.js");
});

test("the guard is never invoked from inside the running server process", () => {
  assert.doesNotMatch(indexSrc, /check-domain-language/);
  assert.doesNotMatch(indexSrc, /domainLanguageGuard/);
});
