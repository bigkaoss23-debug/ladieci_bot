"use strict";
// F-7.6 — ORDER STATE AUDIT IDENTITY HARDENING.
//
// `orden_estado_logs` is keyed only by the DISPLAY order number
// (orden_id/numero_ordine), which is NOT globally unique — it is recycled // language-guard: allow-legacy numero_ordine is the existing orden_estado_logs column name, quoted to identify the ambiguous key, not new vocabulary
// across service sessions. Proven live on staging: display id `#370` carries
// BOTH a PRANZO Mesa order (session d301682e..., RETIRADO, paid, €40) and an // language-guard: allow-legacy PRANZO is the existing service_kind enum value, naming the real colliding session as evidence, not new vocabulary
// unrelated SERA delivery order (session c9d5aaa7..., €17) inside one single
// log timeline, already indistinguishable without inferring from timestamps.
//
// This slice makes every NEW transition self-identifying by persisting, into
// the existing jsonb `metadata` column:
//   metadata.order_uid           — permanent order identity
//   metadata.service_session_id  — owning service session
//   metadata.reason              — optional operator justification
//
// Both identifiers are resolved SERVER-SIDE from the live `ordenes` row and
// are never accepted from the client. `reason` is the ONLY free-text field
// the routed action accepts, so arbitrary client metadata can never be
// injected into the audit log.
//
// Storage decision (evidence-based, no schema change): `metadata` is already
// jsonb NOT NULL DEFAULT '{}', populated on 100% of rows, genuinely queryable
// (`metadata->>'tipo_consegna'` filters real rows), has zero triggers, zero // language-guard: allow-legacy tipo_consegna is the existing metadata key already present on 100% of rows, cited as durability proof, not new vocabulary
// RLS, and — verified by full grep of BOTH repos — exactly one writer
// (orderStateLogger.js) and ZERO readers that could strip it. Two prior
// audited reconciliations already used this same shape (#725
// codex_staging_recovery with {reason, archived, service_session_id}; #366
// manual_p0b_test_fixture_cleanup with {reason}). First-class columns were
// therefore unnecessary.
//
// Historical ambiguous rows are deliberately NOT backfilled — order_uid can
// only be inferred for them, and inference is exactly what produced the
// earlier false conclusion this slice exists to prevent.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

// language-guard: allow-legacy agentOrdini.js is the existing module filename being read under test, not new vocabulary
const AGENT = read("src/agents/agentOrdini.js");
const INDEX = read("index.js");
const LOGGER = read("src/utils/orderStateLogger.js");

console.log("\n== A. Identity is resolved SERVER-SIDE from the live row ==");
assert("1a: the prev-fetch select includes order_uid and service_session_id",
  /select=id,estado,manual_giro_id,tipo_consegna,order_uid,service_session_id/.test(AGENT)); // language-guard: allow-legacy tipo_consegna is the existing ordenes column in the asserted select string, not new vocabulary
assert("1b: orderUidActual is populated from the fetched row, not from extras/client",
  /orderUidActual = _prev\?\.\[0\]\?\.order_uid \|\| null/.test(AGENT));
assert("1c: serviceSessionIdActual is populated from the fetched row, not from extras/client",
  /serviceSessionIdActual = _prev\?\.\[0\]\?\.service_session_id \|\| null/.test(AGENT));
assert("1d: neither identifier is ever read out of `extras` (the client-influenced bag)",
  !/extras\.order_uid/.test(AGENT) && !/extras\.service_session_id/.test(AGENT));

console.log("\n== B. Identity + reason reach the transition log ==");
assert("2a: metadata carries the server-resolved order_uid",
  /order_uid: orderUidActual/.test(AGENT));
assert("2b: metadata carries the server-resolved service_session_id",
  /service_session_id: serviceSessionIdActual/.test(AGENT));
assert("2c: reason is spread in ONLY when present, so ordinary transitions keep their exact existing metadata shape",
  /\.\.\.\(extras\.reason \? \{ reason: extras\.reason \} : \{\}\)/.test(AGENT));

console.log("\n== C. Only the reason field is client-accepted, and it is bounded ==");
assert("3a: updateEstado accepts req.body.reason only as a trimmed non-empty string",
  /typeof req\.body\.reason === "string" && req\.body\.reason\.trim\(\)/.test(INDEX));
assert("3b: the accepted reason is length-capped before it reaches the audit log",
  /extras\.reason = req\.body\.reason\.trim\(\)\.slice\(0, 500\)/.test(INDEX));
assert("3c: no wholesale client metadata object is ever forwarded into extras",
  !/extras\.metadata\s*=/.test(INDEX) && !/req\.body\.metadata/.test(INDEX));
{
  // The extras allowlist in updateEstado must not have silently grown.
  const m = INDEX.match(/for \(const k of \[([^\]]+)\]\) \{\s*if \(req\.body\[k\] !== undefined\) extras\[k\] = req\.body\[k\];/);
  assert("3d: the updateEstado extras allowlist is still exactly the pre-F-7.6 set (reason is handled separately, not added to it)",
    // language-guard: allow-legacy cucina_check is the existing updateEstado allowlist entry, restated verbatim to assert the list did not grow, not new vocabulary
    !!m && m[1].replace(/["\s]/g, "") === "metodo_pago,hora_entrega,hora_salida,repartidor,llegado,cucina_check,descuento_tipo,descuento_valor",
    m ? m[1] : "allowlist not found");
}

console.log("\n== D. The logger preserves the new keys (PII scrub is a denylist, not an allowlist) ==");
assert("4a: sanitizeMetadata filters by an explicit PII key denylist",
  /if \(PII_METADATA_KEYS\.has\(String\(key\)\.toLowerCase\(\)\)\) continue;/.test(LOGGER));
for (const k of ["order_uid", "service_session_id", "reason"]) {
  assert(`4b: '${k}' is NOT in the PII denylist, so it survives sanitizeMetadata`,
    !new RegExp(`^\\s*"${k}",`, "m").test(LOGGER));
}
assert("4c: string values are preserved verbatim by cleanMetadataValue",
  /if \(\["string", "number", "boolean"\]\.includes\(typeof value\)\) return value;/.test(LOGGER));

console.log("\n== E. Scope discipline — no schema change, no backfill, no mandatory-justification project ==");
{
  const migDir = path.join(__dirname, "..", "migrations");
  const f76 = fs.readdirSync(migDir).filter((f) => /f7_?6|f76/i.test(f));
  assert("5a: F-7.6 introduces NO migration (metadata jsonb already existed and is durable/queryable)",
    f76.length === 0, f76.join(", "));
}
assert("5b: no UPDATE against orden_estado_logs anywhere in the backend (historical rows are never rewritten)",
  !/UPDATE\s+(public\.)?orden_estado_logs/i.test(AGENT + INDEX + LOGGER)
  && !/sbUpdate\(\s*["'`]orden_estado_logs/.test(AGENT + INDEX + LOGGER));
assert("5c: reason stays OPTIONAL — no throw/reject when it is absent",
  !/reason.*required|REASON_REQUIRED|missing_reason/i.test(INDEX));

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
