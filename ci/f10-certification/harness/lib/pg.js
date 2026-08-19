"use strict";
// F-10.3C CI-ONLY: thin psql wrapper for fixture construction and evidence
// reads. Orchestration only -- never part of "the real application path"
// (creaOrdine/forgottenCloseRecovery/serviceCloseAuthority/serviceLifecycle
// Engine never shell out to psql; they only ever use supabaseTransport.js).
// Requires PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE in the environment
// (standard libpq env vars) -- connects directly to Postgres, bypassing
// PostgREST entirely, exactly as Phase 6 specifies for bootstrap/fixtures.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function runSqlFile(sqlText) {
  const tmp = path.join(os.tmpdir(), `f10cert-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmp, sqlText, "utf8");
  try {
    return execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-f", tmp], { encoding: "utf8" });
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Tuples-only, unaligned, single-column-friendly scalar/row query.
function queryScalar(sql) {
  const out = execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], { encoding: "utf8" });
  return out.trim();
}

// Returns rows as an array of objects using JSON aggregation server-side --
// avoids any fragile client-side CSV parsing of arbitrary column types.
function queryJson(sql) {
  const wrapped = `SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (${sql}) t;`;
  const out = queryScalar(wrapped);
  return JSON.parse(out || "[]");
}

module.exports = { runSqlFile, queryScalar, queryJson };
