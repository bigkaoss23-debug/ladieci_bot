"use strict";
// S2-7D6B — migration + wiring contract.
//
// Structural proof that the migration says what it must say, that the rollback
// refuses to destroy two-service data, and that the runtime is wired to the new
// identity. The live uniqueness behaviour (lunch #001 and dinner #001 both
// payable) is proven against staging inside a rolled-back transaction, recorded
// in the block report — it cannot be asserted from a file.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const MIG = read("migrations/2026-07-26_two_service_identity.sql");
const RB = read("migrations/2026-07-26_two_service_identity.ROLLBACK.sql");
const SERVIZIO = read("src/utils/servizio.js");
const INDEX = read("index.js");
const CONTRACT = require("../src/auth/authorizationContract");

console.log("\n══ A. staging safety ══");
assert("A: staging sentinel guard present", /schema_migrations WHERE version='20260710075612'/.test(MIG));
assert("A: refuses without the identity foundation", /service session identity foundation missing/.test(MIG));
assert("A: refuses while a session is active", /an active service session exists — close it first/.test(MIG));
assert("A: single transaction", /^BEGIN;/m.test(MIG) && /COMMIT;\s*$/.test(MIG));
assert("A: a rollback file exists and is transactional", /^BEGIN;/m.test(RB) && /COMMIT;\s*$/.test(RB));

console.log("\n══ B. service identity ══");
assert("B: service_kind column added", /ADD COLUMN IF NOT EXISTS service_kind text/.test(MIG));
assert("B: enum restricted to PRANZO/SERA", /CHECK \(service_kind IS NULL OR service_kind IN \('PRANZO','SERA'\)\)/.test(MIG));
assert("B: legacy closed rows may stay NULL", /service_kind IS NULL OR/.test(MIG));
assert("B: every ACTIVE session must carry a kind", /CHECK \(status = 'closed' OR service_kind IS NOT NULL\)/.test(MIG));
assert("B: one kind per business date", /CREATE UNIQUE INDEX IF NOT EXISTS service_sessions_date_kind_uq[\s\S]{0,140}\(business_date, service_kind\)/.test(MIG));
assert("B: the single-active guard is NOT dropped", !/DROP INDEX[^\n]*service_sessions_single_active_uq/.test(MIG));
assert("B: summary carries the kind", /ALTER TABLE public\.serata_summary[\s\S]{0,80}ADD COLUMN IF NOT EXISTS service_kind/.test(MIG));

console.log("\n══ C. financial identity (the blocker) ══");
assert("C: old global payment index dropped", /DROP INDEX IF EXISTS public\.order_financial_events_one_payment_uq/.test(MIG));
assert("C: old global refund index dropped", /DROP INDEX IF EXISTS public\.order_financial_events_one_refund_uq/.test(MIG));
assert("C: old scope constraint dropped", /DROP CONSTRAINT IF EXISTS order_financial_events_scope_uq/.test(MIG));
assert("C: payment now scoped by session + order", /order_financial_events_one_payment_session_uq[\s\S]{0,160}\(service_session_id, order_id\)[\s\S]{0,160}service_session_id IS NOT NULL AND type IN \('payment','payment_imported'\)/.test(MIG));
assert("C: refund now scoped by session + order", /order_financial_events_one_refund_session_uq[\s\S]{0,160}\(service_session_id, order_id\)[\s\S]{0,160}type = 'refund'/.test(MIG));
assert("C: idempotency scoped by session", /order_financial_events_scope_session_uq[\s\S]{0,200}\(service_session_id, order_id, type, idem_scope_key\)/.test(MIG));
// Legacy rows (service_session_id NULL) keep the ORIGINAL global protection.
assert("C: legacy payment safety preserved", /order_financial_events_one_payment_legacy_uq[\s\S]{0,160}\(order_id\)[\s\S]{0,160}service_session_id IS NULL/.test(MIG));
assert("C: legacy refund safety preserved", /order_financial_events_one_refund_legacy_uq[\s\S]{0,160}service_session_id IS NULL/.test(MIG));
assert("C: legacy idempotency safety preserved", /order_financial_events_scope_legacy_uq[\s\S]{0,200}service_session_id IS NULL/.test(MIG));

console.log("\n══ D. conversation archive identity ══");
assert("D: archivio_conv gains the session id", /ALTER TABLE public\.archivio_conv[\s\S]{0,120}ADD COLUMN IF NOT EXISTS service_session_id uuid/.test(MIG));
assert("D: old (wa_id, data_servizio) unique dropped", /DROP INDEX IF EXISTS public\.archivio_conv_unique/.test(MIG));
assert("D: new key is (session, wa_id)", /archivio_conv_session_wa_uq[\s\S]{0,140}\(service_session_id, wa_id\)/.test(MIG));
assert("D: historical NULL-session rows still protected", /archivio_conv_legacy_uq[\s\S]{0,140}\(wa_id, data_servizio\)[\s\S]{0,80}service_session_id IS NULL/.test(MIG));
assert("D: the writer sends the session id", /service_session_id: serviceSessionId/.test(SERVIZIO));
assert("D: the writer upserts on the new key", /"service_session_id,wa_id"/.test(SERVIZIO));

console.log("\n══ E. ensure RPC ══");
assert("E: ensure_service_session created", /CREATE OR REPLACE FUNCTION public\.ensure_service_session\(/.test(MIG));
assert("E: kind validated against the enum", /p_service_kind NOT IN \('PRANZO','SERA'\)[\s\S]{0,120}INVALID_SERVICE_KIND/.test(MIG));
assert("E: reuses the existing advisory lock", /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(MIG));
assert("E: locks the state row", /FROM public\.service_session_state WHERE singleton=true FOR UPDATE/.test(MIG));
assert("E: same kind → REUSED, created:false", /'code','REUSED','created',false/.test(MIG));
assert("E: new → CREATED, created:true", /'code','CREATED','created',true/.test(MIG));
assert("E: lunch-at-dinner is a typed conflict", /LUNCH_SESSION_STILL_ACTIVE/.test(MIG));
assert("E: business date honours the 04:00 rollover", /v_madrid::time < TIME '04:00'[\s\S]{0,60}v_madrid::date - 1/.test(MIG));
assert("E: opened_by recorded, open_source defaults to auto_entry", /p_opened_by,COALESCE\(p_source,'auto_entry'\),p_service_kind/.test(MIG));
assert("E: audit row written", /INSERT INTO public\.service_session_audit[\s\S]{0,120}'opened'/.test(MIG));
assert("E: service_role only", /GRANT EXECUTE ON FUNCTION public\.ensure_service_session\(text,text,text\) TO service_role/.test(MIG));
assert("E: revoked from anon/authenticated", /REVOKE ALL ON FUNCTION public\.ensure_service_session\(text,text,text\) FROM PUBLIC, anon, authenticated/.test(MIG));
assert("E: the kind-less opener fail-closes", /open_service_session[\s\S]{0,400}SERVICE_KIND_REQUIRED/.test(MIG));

console.log("\n══ F. rollback refuses to destroy two-service data ══");
for (const [label, re] of [
  ["a business date holding two services", /a business date holds two services/],
  ["an order id holding two payments", /an order id holds two payments across services/],
  ["an order id holding two refunds", /an order id holds two refunds across services/],
  ["a customer holding two archives", /a customer holds two archives on one date/],
  ["an active session", /an active service session exists/],
]) assert(`F: refuses on ${label}`, re.test(RB));
assert("F: restores the original global indexes", /CREATE UNIQUE INDEX order_financial_events_one_payment_uq[\s\S]{0,120}\(order_id\)/.test(RB));
assert("F: drops the ensure function", /DROP FUNCTION IF EXISTS public\.ensure_service_session/.test(RB));

console.log("\n══ G. runtime wiring ══");
assert("G: ensure action routed", /action === "ensureCurrentServiceSession"/.test(INDEX));
assert("G: actor comes from verified auth, never the body", /const actorId = req\.authCtx\?\.actor;/.test(INDEX));
assert("G: the kind is never read from the request", !/req\.body\.(serviceKind|service_kind|kind)/.test(INDEX));
assert("G: unverified actor → 401", /UNVERIFIED_ACTOR/.test(INDEX));
assert("G: manual open is now recovery through the SAME ensure", /source: "manual_recovery"/.test(INDEX));
assert("G: no caller uses the retired kind-less opener", !/serviceSessionLifecycle\.open\(/.test(INDEX));

console.log("\n══ H. authorization ══");
assert("H: action is canonical", CONTRACT.CANONICAL_ACTIONS.includes("ensureCurrentServiceSession"));
assert("H: admin allowed", CONTRACT.isAllowed("admin", "ensureCurrentServiceSession") === true);
assert("H: operator allowed", CONTRACT.isAllowed("operator", "ensureCurrentServiceSession") === true);
assert("H: RIDER DENIED", CONTRACT.isAllowed("rider", "ensureCurrentServiceSession") === false);
assert("H: service principal denied", CONTRACT.isAllowed("service", "ensureCurrentServiceSession") === false);
assert("H: not fresh-auth (it runs on every entry)", !CONTRACT.getActionContract("ensureCurrentServiceSession").freshAuth);

console.log("\n══ I. close and accounting scoping ══");
assert("I: close guard is per kind, not a flat 22:00", /closeEligibility\(kind, new Date\(\)\)/.test(INDEX));
assert("I: the old flat 22:00 guard is gone from chiudiServizio", !/Chiusura permessa solo dopo le 22:00/.test(INDEX));
assert("I: one periodic close tick, not a 23:50 forced close", /serviceCloseTick/.test(INDEX) && !/function schedula2350/.test(INDEX));
assert("I: the tick reuses the single close implementation (SLICE 3: via the incident-safe rollover orchestrator, which itself always delegates archival to chiudiServizio)", /performIncidentSafeRollover\(\{\s*session, source: decision\.source, actor: "system" \}\)/.test(INDEX));
assert("I: 04:00 escalates rather than force-closing", /ESCALATION[\s\S]{0,120}past 04:00/.test(INDEX));
assert("I: summary is stamped with the kind", /summary\.service_kind = serviceKind/.test(SERVIZIO));
assert("I: summary window starts at THIS session's opening", /sessionOpenedAt[\s\S]{0,120}toISOString\(\)/.test(SERVIZIO));
assert("I: the hardcoded \\+02:00 is gone", !/T00:00:00\+02:00/.test(SERVIZIO));
assert("I: lunch close does not wipe dinner-capable conv/wa state", /const isLunchClose = serviceKind === "PRANZO"[\s\S]{0,400}if \(!isLunchClose\)/.test(SERVIZIO));
assert("I: close marker is per kind", /LAST_CLOSE_PRANZO/.test(SERVIZIO) && /LAST_CLOSE_SERA/.test(SERVIZIO));
assert("I: a lunch close does not move LAST_CLOSE_DATE", /if \(serviceKind !== "PRANZO"\)[\s\S]{0,140}LAST_CLOSE_DATE/.test(SERVIZIO));
assert("I: financial events are still never deleted", /Financial events are never deleted here/.test(SERVIZIO));

console.log("\n══ J. closeout reports which service it is (S2-7D6C2, corrected S-E) ══");
const CLOSEOUT = read("src/closeout/currentServiceCloseout.js");
// S-E — after the Operational Service repair (S-D), a session can legitimately
// span both economic windows, so the closeout no longer asserts the raw
// session.service_kind unconditionally: it exposes a single PRANZO/SERA label
// only when every ticket's own era-aware kind agrees (byte-identical to the
// old behavior for every closeout that is still genuinely single-kind, which
// is all real data as of S-E), falling back to the session's own kind only
// when there are no tickets to disagree with. See
// tests/sEEconomicPeriodReaders.static.test.js for the full S-E proof; this
// file keeps its original, narrower camelCase/no-clock/single-aggregate checks.
assert("J: the closeout contract exposes the kind in camelCase, era-aware (not the raw session column unconditionally)",
  /serviceKind: tickets\.length === 0/.test(CLOSEOUT) && /singleKindOrNull\(tickets\.map/.test(CLOSEOUT));
assert("J: the kind is read from the session row only, never from the clock", !/getHours\(|new Date\(\)|Date\.now\(/.test(CLOSEOUT));
assert("J: one aggregate builds every contract return path", (CLOSEOUT.match(/ok: true,/g) || []).length === 1);

console.log("");
console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
