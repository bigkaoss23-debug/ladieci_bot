"use strict";
// POST-ASTRA CORRECTIVE CYCLE -- backend unit pins (no network, no database). The database halves of these fixes are proven on
// PostgreSQL 17 by the lab tests named in ~/Downloads/ECONOMY_POST_ASTRA_CORRECTIVE_REPORT_2026-09-26.md; this file pins the
// backend contracts that make them reachable:
//   F2  the Business Day digest is read BEFORE the reconciliation is built and travels in its payload; a database without 154 (PGRST202)
//       gets no digest (it does not ask for one); any other failure is a typed refusal; a window mismatch is refused.
//   F4  an obligation attaches by permanent identity; the composite provenance only for a row without it, and only when unambiguous.
//   F8  the cancellation key is the permanent identity, never the display id.
//   F1 / F5 client pins: expected_order_uid and expected_items are honoured by the writers (static: they sit before any write).
// Run: node --test tests/postAstraCorrectiveBackend.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createCloseoutReconciliation } = require("../src/economy/closeoutReconciliation");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");
const { obligationIndexByIdentity } = require("../src/closeout/currentServiceCloseout");
const { buildCancelRequestId } = require("../src/financial/cancelOrder");

const SVC = "11111111-1111-4111-8111-111111111111";
const sessions = [{ id: SVC, business_date: "2026-09-25", status: "open", opened_at: "2026-09-25T17:00:00.000Z", closed_at: null, service_kind: null }];
const ordenes = [{ id: "#1", estado: "RETIRADO", totale: 10, metodo_pago: "", cobrado: false, ya_pagado: false, service_session_id: SVC,
  created_at: "2026-09-25T18:00:00.000Z", order_uid: "aaaa1111-0000-4000-8000-000000000001" }];

function recon(rpc) {
  const select = createMemorySelect({ ordenes, order_obligations: [], order_financial_events: [], storico: [], // language-guard: allow-legacy storico is the archive table name the reader queries; it must match, not new vocabulary
    service_sessions: sessions, cash_counts: [], service_closeout_reconciliations: [] });
  return createCloseoutReconciliation({ select, rpc, snapshot: createEconomicSnapshot({ select }) });
}

test("F2 · withDayEvidence reads the digest BEFORE the build, over the reconciliation's own window, and sends it in the payload", async () => {
  const calls = [];
  const r = recon(async (fn, args) => { calls.push({ fn, args }); return { ok: true, body: { version: 1, digest: "d".repeat(32) } }; });
  const out = await r.buildRpcArgs({ serviceSessionId: SVC, closeoutCorrelationId: "c-1", actor: "owner", withDayEvidence: true });
  assert.equal(out.success, true);
  assert.equal(out.args.p_day_evidence_digest, "d".repeat(32));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "service_close_day_evidence_digest_v1");
  assert.equal(calls[0].args.p_from, out.args.p_window_from);
  assert.equal(calls[0].args.p_to, out.args.p_window_to);
});

test("F2 · without withDayEvidence (persist path) nothing is read and no digest key is sent", async () => {
  let n = 0;
  const out = await recon(async () => { n += 1; return { ok: true, body: {} }; }).buildRpcArgs({ serviceSessionId: SVC, closeoutCorrelationId: "c-2", actor: "owner" });
  assert.equal(out.success, true);
  assert.equal(n, 0);
  assert.ok(!("p_day_evidence_digest" in out.args));
});

test("F2 · a database without 154 (PGRST202) gets no digest; the close then behaves as before 154 (mixed-version window)", async () => {
  const out = await recon(async () => ({ ok: false, httpStatus: 404, body: { code: "PGRST202" } }))
    .buildRpcArgs({ serviceSessionId: SVC, closeoutCorrelationId: "c-3", actor: "owner", withDayEvidence: true });
  assert.equal(out.success, true);
  assert.ok(!("p_day_evidence_digest" in out.args));
});

test("F2 · any other digest failure is a typed refusal, never a reconciliation without its evidence", async () => {
  for (const rpc of [async () => ({ ok: false, httpStatus: 500, body: { code: "XX000" } }), async () => { throw new Error("network"); }, async () => ({ ok: true, body: { digest: 42 } })]) {
    const out = await recon(rpc).buildRpcArgs({ serviceSessionId: SVC, closeoutCorrelationId: "c-4", actor: "owner", withDayEvidence: true });
    assert.equal(out.success, false);
    assert.ok(["RECONCILIATION_DAY_EVIDENCE_UNAVAILABLE", "RECONCILIATION_BUILD_FAILED"].includes(out.code), out.code);
  }
});

test("F2 · the engine asks for the digest on BOTH close paths (main + CASE B resume)", () => {
  const engine = fs.readFileSync(path.join(__dirname, "..", "src", "serviceSessions", "serviceLifecycleEngine.js"), "utf8");
  assert.equal((engine.match(/buildRpcArgs\(\{[^}]*withDayEvidence: true/g) || []).length, 2);
});

test("F4 · obligations attach by order_uid; a legacy row (no uid) only through an UNAMBIGUOUS composite provenance", () => {
  const obligations = [
    { order_uid: "u-1", order_id: "#5", service_session_id: "s-A", revision: 1, gross_amount: 10 },
    { order_uid: "u-1", order_id: "#5", service_session_id: "s-A", revision: 2, gross_amount: 8 },
    { order_uid: "u-2", order_id: "#5", service_session_id: "s-B", revision: 1, gross_amount: 30 },   // a later order reusing display id #5
    { order_uid: "u-3", order_id: "#7", service_session_id: "s-C", revision: 1, gross_amount: 12 },
    { order_uid: "u-4", order_id: "#7", service_session_id: "s-C", revision: 1, gross_amount: 99 },   // two orders behind one provenance
  ];
  const obligationFor = obligationIndexByIdentity(obligations);
  assert.equal(Number(obligationFor({ order_uid: "u-1", id: "#5", service_session_id: "s-A" }).gross_amount), 8, "latest revision of that identity");
  assert.equal(Number(obligationFor({ order_uid: "u-2", id: "#5", service_session_id: "s-B" }).gross_amount), 30);
  assert.equal(Number(obligationFor({ orden_id: "#5", service_session_id: "s-A" }).gross_amount), 8, "legacy row, unambiguous provenance");
  assert.equal(obligationFor({ orden_id: "#5", service_session_id: "s-Z" }), null, "never the bare display id of another service");
  assert.equal(obligationFor({ orden_id: "#7", service_session_id: "s-C" }), null, "ambiguous provenance -> fail closed to the legacy total");
});

test("F8 · the cancellation key is the permanent identity; a display id or a short value is refused", () => {
  assert.equal(buildCancelRequestId("aaaa1111-0000-4000-8000-000000000001"), "cancel-order-aaaa1111-0000-4000-8000-000000000001");
  assert.equal(buildCancelRequestId("#999034"), null);
  assert.equal(buildCancelRequestId(""), null);
});

test("F1 / F5 · the client pins sit BEFORE any write: expected_order_uid before the cancellation, expected_items before the editor write", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "agentOrdini.js"), "utf8"); // language-guard: allow-legacy agentOrdini.js is the existing file name being read, not new vocabulary
  const pinUid = src.indexOf("extras.expected_order_uid !== undefined && String(extras.expected_order_uid) !== String(orderUidActual");
  assert.ok(pinUid > 0 && pinUid < src.indexOf("const cancelled = await cancelOrderCanonical({"));
  const pinItems = src.indexOf("updates.expected_items !== undefined && canonicalJson(updates.expected_items) !== canonicalJson(ord.items || [])");
  assert.ok(pinItems > 0 && pinItems < src.indexOf("const modRefusal = await writeOrderPatch(ordenId, upd, basisRow);"));
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(index, /extras\.expected_order_uid = req\.body\.expected_order_uid\.trim\(\);/);
});

test("rollout · without migration 153 (PGRST202 ONLY) the editor keeps the pre-153 direct PATCH, still classified; any other RPC refusal is final", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "agentOrdini.js"), "utf8"); // language-guard: allow-legacy agentOrdini.js is the existing file name being read, not new vocabulary
  const body = src.slice(src.indexOf("async function writeOrderPatch("), src.indexOf("\n}\n", src.indexOf("async function writeOrderPatch(")));
  assert.match(body, /if \(!\(res && res\.ok === false && res\.body && res\.body\.code === "PGRST202"\)\) \{\n\s+return classifyOrderWriteResult\(ordenId, res && res\.body\) \|\| orderWriteFailure\(ordenId\);/);
  assert.match(body, /const res = await sbUpdate\("ordenes", `id=eq\.\$\{encodeURIComponent\(ordenId\)\}`, patch\);\n\s+return classifyOrderWriteResult\(ordenId, res\);/);
  assert.equal((body.match(/PGRST202/g) || []).length, 2, "one comment mention + the one condition");
});
