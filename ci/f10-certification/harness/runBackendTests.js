"use strict";
// F-10.3C Phase 19 -- FULL REGRESSION. This repository's tests are
// self-contained "node <file>.test.js" scripts (assert-based, no jest/mocha
// in package.json) -- this runs every one under tests/, against the SAME
// ephemeral Postgres+PostgREST+proxy stack the rest of this certification
// already uses (SUPABASE_URL/SUPABASE_KEY already in the environment), and
// reports pass/fail per file. The one pre-existing baseline failure the
// task names explicitly is the only tolerated failure.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const KNOWN_ALLOWED_BASELINE_FAILURE = "getOrdenesArchivadosSesionAuthorizationParity.test.js";

function findTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function runOne(file, backendDir) {
  const started = Date.now();
  try {
    execFileSync("node", [file], { cwd: backendDir, env: process.env, timeout: 60000, stdio: "pipe" });
    return { file: path.relative(backendDir, file), passed: true, durationMs: Date.now() - started };
  } catch (e) {
    return {
      file: path.relative(backendDir, file),
      passed: false,
      durationMs: Date.now() - started,
      exitCode: e.status ?? null,
      stderrTail: String(e.stderr || "").slice(-2000),
    };
  }
}

function runBackendTests({ backendDir }) {
  const files = findTestFiles(path.join(backendDir, "tests"));
  const results = files.map((f) => runOne(f, backendDir));

  const failed = results.filter((r) => !r.passed);
  const unexpectedFailures = failed.filter((r) => !r.file.endsWith(KNOWN_ALLOWED_BASELINE_FAILURE));
  const baselineFailureSeen = failed.some((r) => r.file.endsWith(KNOWN_ALLOWED_BASELINE_FAILURE));

  return {
    pass: unexpectedFailures.length === 0,
    totalFiles: results.length,
    failedCount: failed.length,
    unexpectedFailureCount: unexpectedFailures.length,
    baselineFailureSeen,
    unexpectedFailures: unexpectedFailures.map((r) => ({ file: r.file, exitCode: r.exitCode, stderrTail: r.stderrTail })),
    allFailed: failed.map((r) => r.file),
  };
}

module.exports = { runBackendTests, KNOWN_ALLOWED_BASELINE_FAILURE };
