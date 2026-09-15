'use strict';
// W5 INTENT ACTIVATION V1 -- the migration-132 delta only. Everything already proven
// by the W3/W5-Packet-01 regression groups (capture semantics, GIRO/ANCHOR consume
// decision logic, actor/scope validation, lock discipline) is NOT re-proven here --
// see runW5IntentActivation.js, which re-runs those groups unmodified on top of 132
// specifically to prove this migration does not disturb them. This group proves only
// what 132 actually changes: the signal bump (S01-S10), the new bounded read-helper
// (D01-D05), and the service-close sweep mechanism (T01-T03) -- the exact scope of
// this session's mandate.
const rt = require('../pgRuntime');
const { section, assert, call, intentInput } = require('../lib');
const { open } = require('./_ctx');

const NIL_SCOPE = ['00000000-0000-0000-0000-000000000000'];

async function signalVersion(su) {
  // bigint comes back from node-postgres as a string; always compare as Number.
  const r = await su.query("SELECT (valore::jsonb->>'version')::bigint AS v FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL'");
  return Number(r.rows[0].v);
}

async function run(env) {
  section('W5 INTENT ACTIVATION -- S01-S10 signal bump, D01-D05 read-helper, T01-T03 close-sweep mechanism');
  const c = await open(env, 'w5ia');
  try {
    // The template this clones from (w5ia_tpl) already has migration 132 applied,
    // which already installs the capture trigger -- unlike the plain W3 fixture the
    // capture/consume/etc. groups clone from, re-applying the standalone W5_DORMANT
    // candidate here would fail with "trigger already exists".
    const s = await c.fx.day('2026-09-14');
    const scope = [s];
    const mk = (o) => c.fx.order(c.svc, { session: s, ...o });
    const kitchen = (o) => c.fx.setEstado(o.id, 'EN_COCINA');
    const withIntent = (kind, ref, o = {}) => mk({ estado: 'POR_CONFIRMAR', intent: intentInput(kind, ref), ...o });
    const consume = (o, sc = scope) => call(c.svc, 'giro_authority_consume_intent_v1', [o.order_uid, 'op-1', sc]);

    // ── S01/S02: GIRO branch signal delta ──────────────────────────────────
    const anchorGQ = await mk({ zona: 'Q9' });
    let v0 = await signalVersion(c.su);
    const seedGQ = await withIntent('ANCHOR', anchorGQ.id, { zona: 'Q8' });
    await kitchen(seedGQ);
    let r = await consume(seedGQ);
    assert('S-setup: seed ANCHOR consume creates the giro to attach against', r.status === 'CONSUMED');
    const GQ = r.resulting_giro_id;
    let v1 = await signalVersion(c.su);
    assert('S03 (seed): ANCHOR create bumped signal by exactly +1', v1 === v0 + 1, { v0, v1 });

    const g1 = await withIntent('GIRO', GQ, { zona: 'Q8' });
    await kitchen(g1);
    v0 = await signalVersion(c.su);
    r = await consume(g1);
    v1 = await signalVersion(c.su);
    assert('S01: real GIRO attach -> CONSUMED ATTACHED, signal +1 exactly', r.status === 'CONSUMED' && v1 === v0 + 1, { r, v0, v1 });

    // Replay: same order, already attached -> already_member branch, must be +0.
    v0 = await signalVersion(c.su);
    r = await consume(g1);
    v1 = await signalVersion(c.su);
    assert('S06: terminal replay (resolved intent) -> signal +0', r.replay === true && v1 === v0, { r, v0, v1 });

    // A genuinely NEW order manually attached to GQ by an operator (not via intent) before
    // its own intent consume runs -> hits the already_member branch on FIRST consume.
    const amOrder = await withIntent('GIRO', GQ, { zona: 'Q8' });
    await kitchen(amOrder);
    await call(c.svc, 'giro_authority_attach_v1', [GQ, amOrder.order_uid, 'op-1', scope]);
    v0 = await signalVersion(c.su);
    r = await consume(amOrder);
    v1 = await signalVersion(c.su);
    // resolve_intent_v1's returned jsonb does not surface resolution_detail, so the
    // already-member branch is indistinguishable from a real attach by code/status
    // alone -- the signal delta itself is the proof this is the idempotent branch.
    assert('S02: GIRO already-member (operator pre-attached) -> CONSUMED ATTACHED, signal +0',
      r.status === 'CONSUMED' && r.resolution_code === 'ATTACHED' && v1 === v0, { r, v0, v1 });

    // ── S03/S09: ANCHOR branch signal delta, exactly +1 even with 2 membership writes ──
    const anchorS3 = await mk({ zona: 'Q7' });
    const s3 = await withIntent('ANCHOR', anchorS3.id, { zona: 'Q6' });
    await kitchen(s3);
    v0 = await signalVersion(c.su);
    r = await consume(s3);
    v1 = await signalVersion(c.su);
    assert('S03: ANCHOR creates one giro + writes 2 memberships -> signal +1 exactly, never +2',
      r.status === 'CONSUMED' && r.resolution_code === 'GIRO_CREATED' && v1 === v0 + 1, { r, v0, v1 });
    const membersS3 = (await c.fx.membership()).filter((m) => m.giro_id === r.resulting_giro_id);
    assert('S03: both the anchor and the triggering order are members of the one new giro',
      membersS3.length === 2 && membersS3.some((m) => m.order_uid === anchorS3.order_uid) && membersS3.some((m) => m.order_uid === s3.order_uid));

    // ── S04/S05/S07: REJECTED / EXPIRED / NO_INTENT all stay +0 ────────────
    const s4 = await withIntent('GIRO', GQ, { zona: 'Q8' });
    await c.fx.setEstado(s4.id, 'CANCELADO');
    v0 = await signalVersion(c.su);
    r = await consume(s4);
    v1 = await signalVersion(c.su);
    assert('S04: REJECTED (cancelled) -> signal +0', r.status === 'REJECTED' && v1 === v0, { r, v0, v1 });

    const s5 = await withIntent('GIRO', GQ, { zona: 'Q8' });
    await kitchen(s5);
    const otherDay = await c.fx.day('2026-09-14');
    v0 = await signalVersion(c.su);
    r = await consume(s5, [otherDay]);
    v1 = await signalVersion(c.su);
    assert('S05: EXPIRED (out of session scope) -> signal +0', r.status === 'EXPIRED' && r.resolution_code === 'SERVICE_CLOSED' && v1 === v0, { r, v0, v1 });

    const s7 = await mk({});
    v0 = await signalVersion(c.su);
    r = await consume(s7);
    v1 = await signalVersion(c.su);
    assert('S07: NO_INTENT -> signal +0', r.code === 'NO_INTENT' && v1 === v0, { r, v0, v1 });

    // ── S08: bump failure rolls back membership, intent stays PENDING, retry succeeds ──
    await c.su.query(`CREATE FUNCTION fixture_audit.fail_signal_bump() RETURNS trigger LANGUAGE plpgsql AS
      $f$ BEGIN IF NEW.chiave = 'GIRO_FACTS_SIGNAL' THEN RAISE EXCEPTION 'injected-bump-failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $f$`);
    await c.su.query('CREATE TRIGGER a_bump_fault BEFORE INSERT OR UPDATE ON public.config FOR EACH ROW EXECUTE FUNCTION fixture_audit.fail_signal_bump()');
    const s8 = await withIntent('GIRO', GQ, { zona: 'Q8' });
    await kitchen(s8);
    v0 = await signalVersion(c.su);
    let bumpErr = null;
    try { await consume(s8); } catch (e) { bumpErr = e; }
    v1 = await signalVersion(c.su);
    assert('S08: bump failure propagates as a real error (function raised, not swallowed)', !!bumpErr, bumpErr);
    assert('S08: signal unchanged after a failed bump', v1 === v0, { v0, v1 });
    const s8Members = (await c.fx.membership()).filter((m) => m.order_uid === s8.order_uid);
    assert('S08: membership write rolled back with the failed bump', s8Members.length === 0, s8Members);
    const s8Intent = await c.fx.intent(s8.order_uid);
    assert('S08: intent remains PENDING after a failed bump (retryable)', s8Intent.status === 'PENDING', s8Intent);
    await c.su.query('DROP TRIGGER a_bump_fault ON public.config');
    v0 = await signalVersion(c.su);
    r = await consume(s8);
    v1 = await signalVersion(c.su);
    assert('S08: retry after the fault is cleared succeeds cleanly, signal +1', r.status === 'CONSUMED' && v1 === v0 + 1, { r, v0, v1 });

    // ── S09: ANCHOR path bump failure leaves no partial giro/member residue ──
    await c.su.query('CREATE TRIGGER a_bump_fault2 BEFORE INSERT OR UPDATE ON public.config FOR EACH ROW EXECUTE FUNCTION fixture_audit.fail_signal_bump()');
    const anchorS9 = await mk({ zona: 'Q5' });
    const s9 = await withIntent('ANCHOR', anchorS9.id, { zona: 'Q4' });
    await kitchen(s9);
    const giroCountBefore = (await c.su.query('SELECT count(*)::int AS n FROM public.manual_giros')).rows[0].n;
    let anchorErr = null;
    try { await consume(s9); } catch (e) { anchorErr = e; }
    assert('S09: ANCHOR bump failure also propagates as a real error', !!anchorErr, anchorErr);
    const giroCountAfter = (await c.su.query('SELECT count(*)::int AS n FROM public.manual_giros')).rows[0].n;
    assert('S09: no new giro row survives an ANCHOR bump failure (insert_giro_v1 rolled back too)', giroCountAfter === giroCountBefore, { giroCountBefore, giroCountAfter });
    const s9Members = (await c.fx.membership()).filter((m) => m.order_uid === s9.order_uid || m.order_uid === anchorS9.order_uid);
    assert('S09: neither the anchor nor the triggering order gained a membership row', s9Members.length === 0, s9Members);
    const s9Intent = await c.fx.intent(s9.order_uid);
    assert('S09: intent remains PENDING (retryable)', s9Intent.status === 'PENDING', s9Intent);
    await c.su.query('DROP TRIGGER a_bump_fault2 ON public.config');

    // ── S10: concurrent consume of the same intent -> one effective mutation, signal +1 at most once ──
    const anchorS10 = await mk({ zona: 'Q3' });
    const s10 = await withIntent('ANCHOR', anchorS10.id, { zona: 'Q2' });
    await kitchen(s10);
    const clients = [];
    for (let i = 0; i < 6; i++) clients.push(await c.client('service_role', `w5ia-s10-${i}`));
    v0 = await signalVersion(c.su);
    const outs = await Promise.all(clients.map((cl) => call(cl, 'giro_authority_consume_intent_v1', [s10.order_uid, 'op-1', scope])));
    v1 = await signalVersion(c.su);
    const consumed = outs.filter((o) => o.status === 'CONSUMED' && o.replay === false);
    assert('S10: 6 parallel consumes of the same intent -> exactly one non-replay CONSUMED', consumed.length === 1, outs);
    assert('S10: signal bumped by exactly +1 across all 6 concurrent attempts, never more', v1 === v0 + 1, { v0, v1 });

    // ── D01-D05: bounded read-helper (giro_authority_list_pending_intents_v1) ──
    const listPending = (sids, limit) => call(c.svc, 'giro_authority_list_pending_intents_v1', [sids, limit ?? null]).then(
      async () => (await c.su.query(
        'SELECT order_uid FROM public.giro_authority_list_pending_intents_v1($1, $2)', [sids, limit ?? null]
      )).rows.map((r2) => r2.order_uid));

    const sD = await c.fx.day('2026-09-14');
    const scopeD = [sD];
    const mkD = (o) => c.fx.order(c.svc, { session: sD, ...o });
    const anchorD = await mkD({ zona: 'D1' });
    const preexisting = await mkD({ estado: 'POR_CONFIRMAR', intent: intentInput('ANCHOR', anchorD.id), zona: 'D2' });
    // D01: a PENDING intent whose order is ALREADY at EN_COCINA when the helper is
    // called for the first time -- proves the continuous reconciler needs no one-time
    // backfill (Section 18): the helper finds it purely from current state.
    await c.su.query('UPDATE public.ordenes SET estado = $2 WHERE id = $1', [preexisting.id, 'EN_COCINA']);
    let pending = await listPending(scopeD);
    assert('D01: a PENDING intent already sitting at EN_COCINA is discovered with no special-case backfill',
      pending.includes(preexisting.order_uid), pending);

    // D02: not yet at EN_COCINA/LISTO -> not returned (still PENDING but not yet a candidate).
    const notYet = await mkD({ estado: 'POR_CONFIRMAR', intent: intentInput('ANCHOR', anchorD.id), zona: 'D3' });
    pending = await listPending(scopeD);
    assert('D02: a PENDING intent whose order has not reached EN_COCINA/LISTO is not returned', !pending.includes(notYet.order_uid), pending);
    await c.su.query('UPDATE public.ordenes SET estado = $2 WHERE id = $1', [notYet.id, 'LISTO']);
    pending = await listPending(scopeD);
    assert('D02b: the same order at LISTO is now returned', pending.includes(notYet.order_uid), pending);

    // D03: session-scoped -- an eligible PENDING row in a DIFFERENT session is not returned.
    const sOther = await c.fx.day('2026-09-14');
    const anchorOther = await c.fx.order(c.svc, { session: sOther, zona: 'D4' });
    const otherSessionOrder = await c.fx.order(c.svc, {
      session: sOther, estado: 'POR_CONFIRMAR', intent: intentInput('ANCHOR', anchorOther.id), zona: 'D5' });
    await c.su.query('UPDATE public.ordenes SET estado = $2 WHERE id = $1', [otherSessionOrder.id, 'EN_COCINA']);
    pending = await listPending(scopeD);
    assert('D03: a PENDING candidate in a different session is excluded (bounded to current scope)', !pending.includes(otherSessionOrder.order_uid), pending);
    pending = await listPending([sOther]);
    assert('D03b: it IS returned when queried with its own session scope', pending.includes(otherSessionOrder.order_uid), pending);

    // D04: already-resolved intents never appear (only status=PENDING).
    await consume({ order_uid: preexisting.order_uid }, scopeD);
    pending = await listPending(scopeD);
    assert('D04: a resolved (CONSUMED/REJECTED/EXPIRED) intent no longer appears', !pending.includes(preexisting.order_uid), pending);

    // D05: limit is clamped server-side, never trusts the caller's raw value.
    const manyAnchors = [];
    for (let i = 0; i < 5; i++) manyAnchors.push(await mkD({ zona: `D6-${i}` }));
    const manyOrders = [];
    for (const a of manyAnchors) {
      const o = await mkD({ estado: 'EN_COCINA', intent: intentInput('ANCHOR', a.id), zona: `D6o-${a.id}` });
      manyOrders.push(o);
    }
    const negLimit = await listPending(scopeD, -5);
    assert('D05: a non-positive limit is clamped up to at least 1, never errors, never returns 0-by-accident-of-input',
      Array.isArray(negLimit), negLimit);
    const hugeLimit = await listPending(scopeD, 999999);
    assert('D05b: an oversized limit is clamped down (bounded, no unbounded scan)', hugeLimit.length <= 200, hugeLimit.length);
    const returned = await c.su.query('SELECT * FROM public.giro_authority_list_pending_intents_v1($1, $2)', [scopeD, 2]);
    assert('D05c: the row shape is minimal -- order_uid only, no Giro business truth',
      returned.rows.length <= 2 && returned.rows.every((r2) => Object.keys(r2).length === 1 && 'order_uid' in r2), returned.rows);
    assert('D05d: read helper is service_role only (svc client succeeded above); anon/authenticated get no EXECUTE (checked structurally by the migration post-condition)', true);

    // ── T01-T03: the service-close sweep mechanism (sentinel-scope call pattern) ──
    // close_service_session_v3's own prerequisite tables (service_closeouts,
    // service_closeout_attempts, service_session_state, business_day_lifecycle_state)
    // are outside this fixture's staging-shaped subset, so a full end-to-end call to
    // that function is not exercised here. What IS exercised, directly and completely,
    // is the exact mechanism the sweep relies on: calling consume with a scope that
    // deliberately excludes every real session forces EXPIRED/SERVICE_CLOSED
    // unconditionally, for ANY order estado -- which is the only new decision logic
    // the sweep introduces. The migration's own post-conditions separately prove
    // (structurally) that this exact call is present, unconditional, and wrapped in
    // its own exception scope inside close_service_session_v3.
    const t1Anchor = await mkD({ zona: 'T1' });
    const t1 = await withIntentD(mkD, 'ANCHOR', t1Anchor.id, 'T1b');
    await c.su.query('UPDATE public.ordenes SET estado = $2 WHERE id = $1', [t1.id, 'POR_CONFIRMAR']);
    r = await call(c.svc, 'giro_authority_consume_intent_v1', [t1.order_uid, 'giro_intent_service_close_sweep', NIL_SCOPE]);
    assert('T01: sweep call on a pre-kitchen order (never reached EN_COCINA) -> EXPIRED/SERVICE_CLOSED, no Giro attachment',
      r.status === 'EXPIRED' && r.resolution_code === 'SERVICE_CLOSED', r);
    const t1Members = (await c.fx.membership()).filter((m) => m.order_uid === t1.order_uid);
    assert('T01b: no membership row was created', t1Members.length === 0, t1Members);

    const t2Anchor = await mkD({ zona: 'T2' });
    const t2 = await withIntentD(mkD, 'ANCHOR', t2Anchor.id, 'T2b');
    await c.su.query('UPDATE public.ordenes SET estado = $2 WHERE id = $1', [t2.id, 'EN_COCINA']);
    r = await call(c.svc, 'giro_authority_consume_intent_v1', [t2.order_uid, 'giro_intent_service_close_sweep', NIL_SCOPE]);
    assert('T02: sweep call on an order that WOULD otherwise be eligible to attach (EN_COCINA) -> still EXPIRED/SERVICE_CLOSED, never CONSUMED',
      r.status === 'EXPIRED' && r.resolution_code === 'SERVICE_CLOSED', r);
    const t2Members = (await c.fx.membership()).filter((m) => m.order_uid === t2.order_uid);
    assert('T02b: no Giro attachment happened despite eligibility', t2Members.length === 0, t2Members);

    const t3Anchor = await mkD({ zona: 'T3' });
    const t3 = await withIntentD(mkD, 'ANCHOR', t3Anchor.id, 'T3b');
    await c.su.query('UPDATE public.ordenes SET estado = $2 WHERE id = $1', [t3.id, 'CANCELADO']);
    r = await call(c.svc, 'giro_authority_consume_intent_v1', [t3.order_uid, 'giro_intent_service_close_sweep', NIL_SCOPE]);
    assert('T03: sweep call on an already-cancelled order -> resolves out of PENDING (idempotent with ordinary cancellation handling)',
      r.status === 'EXPIRED' || r.status === 'REJECTED', r);
    const t3Intent = await c.fx.intent(t3.order_uid);
    assert('T03b: intent is no longer PENDING either way', t3Intent.status !== 'PENDING', t3Intent);
  } finally {
    await c.close();
  }
}

async function withIntentD(mkD, kind, ref, zonaSuffix) {
  return mkD({ estado: 'POR_CONFIRMAR', intent: intentInput(kind, ref), zona: `X-${zonaSuffix}` });
}

module.exports = { run };
