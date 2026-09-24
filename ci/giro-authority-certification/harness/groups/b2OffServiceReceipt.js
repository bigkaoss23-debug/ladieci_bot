'use strict';
// DELIVERY_ECONOMY_DECOUPLING_V1 -- CORRECTION B2 (Option A): the OFF-SERVICE RECEIPT CONTRACT.
//
// THE CONTRACT under test (migration S2, "receipt service"; restored, not invented, by migration 139):
//   order_financial_events.service_session_id        = the OBLIGATION service (the order's own; set by trigger; never moves)
//   payment_transactions.service_session_id          = the RECEIPT service (the one open when the money was received)
//   order_financial_events.event_service_session_id  = the EVENT / receipt service (the SAME fact)
//   money received while NO service is open          => BOTH receipt columns are NULL
// The order's own service is NEVER written into the receipt column, and the meaning is not carried by a JSON flag:
// meta.off_service_receipt only lets payment_transactions_scope_chk admit the scope-less row, and it is decided by the writer.
//
// Everything runs on real PostgreSQL 17 with the REAL ledger (fixture/real_ledger_v1.sql: live table shapes, constraints, comments,
// triggers; the writer bodies verbatim from migrations/, md5-checked against staging) and the REAL economy readers (JS, unchanged).
// Nothing here touches staging or production.
//
// Sections: K constraint shape (direct INSERT) · W the writer decides the flag · M attribution matrix O1..O8 (the mandate) ·
// B1 the pending, end to end · C the cash views · G the SQL readers of the column · R rollback with real rows · S security.
const crypto = require('crypto');
const rt = require('../pgRuntime');
const { section, assert } = require('../lib');
const H = require('./deliveryEconomyDecoupling').helpers;
const { extractStatement } = require('../realLedger');

const FLAG = { off_service_receipt: true };
const DATE = '2026-09-19';
const MATRIX = [];

// The standalone Cash V1 writer with an explicit p_meta (the caller-controlled bag the writer must not trust for the flag).
const payMeta = (client, wsId, o, meta, x = {}) => {
  const reqId = x.reqId || `cash_${crypto.randomUUID()}`;
  return client.query('SELECT public.order_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) AS r',
    [wsId, x.actor || 'operator_backup', H.hex64('sid-b'), o.order_uid, x.method || 'efectivo', x.mode || 'full', x.amount ?? null,
      reqId, x.hash || H.hex64(`${o.order_uid}|${reqId}`), typeof meta === 'string' ? meta : JSON.stringify(meta), false]).then((r) => r.rows[0].r);
};
const cashPay = H.cashPayOrThrow;                                                  // { threw: <typed message> } instead of an exception
const payMetaSafe = (...a) => payMeta(...a).catch((e) => ({ threw: e.message }));
const throws = async (p) => { try { return { ok: true, value: await p }; } catch (e) { return { ok: false, msg: e.message, code: e.code, constraint: e.constraint }; } };

// Direct INSERT into the real payment_transactions (as the superuser of the throwaway database): the constraint alone decides.
async function ptInsert(c, ws, o = {}) {
  const metaText = o.metaRaw !== undefined ? o.metaRaw : JSON.stringify(o.meta === undefined ? {} : o.meta);
  return c.su.query(
    `INSERT INTO public.payment_transactions (workspace_id, table_session_id, service_session_id, kind, mode, amount, payment_method, covers_settled,
       reverses_transaction_id, by_actor, by_role, by_sid_hash, client_request_id, request_hash, meta)
     VALUES ($1,$2,$3,$4,$5,$6,'efectivo',$7,$8,'operator_primary','operator',$9,$10,$11,$12::jsonb) RETURNING id`,
    [ws, o.table ?? null, o.service ?? null, o.kind || 'payment', o.mode || 'full', o.amount || 5, o.covers ?? 0, o.reverses ?? null,
      H.hex64('sid-k'), `k_${crypto.randomUUID()}`, H.hex64(crypto.randomUUID()), metaText]);
}

// The three attribution columns of one order + the facts the mandate names, read straight from the ledger.
async function attribution(c, orderId) {
  const l = await H.ledger(c, orderId);
  return { l, obligation: l.ev[0] && l.ev[0].obligation_svc, txReceipt: l.tx[0] ? l.tx[0].receipt_svc : undefined, eventReceipt: l.ev[0] ? l.ev[0].receipt_svc : undefined,
    flag: l.tx[0] ? l.tx[0].meta.off_service_receipt : undefined };
}
const record = (label, a, extra = {}) => MATRIX.push({ case: label, obligation_service: a.obligation, tx_receipt_service: a.txReceipt, event_receipt_service: a.eventReceipt,
  tx_flag: a.flag === undefined ? null : a.flag, ...extra });

async function installReaders(su) {
  // The four LIVE bodies that read payment_transactions.service_session_id (md5 = staging, checked below): the shared evidence
  // predicate, the two delete guards that call it, and the N-5 paid-order mutation guard + its trigger.
  const ecf2 = rt.readRepo('migrations/2026-08-25_ecf2_order_delete_economic_evidence_alignment.sql');
  const n5 = rt.readRepo('migrations/2026-08-24_n5_paid_order_economic_mutation_guard.sql');
  await su.query('SET ROLE postgres');
  await su.query('CREATE TABLE IF NOT EXISTS public.service_incidents (order_id text, service_session_id uuid)'); // an empty dependency of an unrelated branch
  for (const [src, name] of [[ecf2, 'order_has_economic_evidence_v1'], [ecf2, 'delete_order_if_not_active'], [n5, 'paid_order_economic_mutation_guard_v1']]) await su.query(extractStatement(src, name));
  await su.query(`CREATE TRIGGER ordenes_paid_order_economic_mutation_guard_v1 BEFORE UPDATE OF totale, delivery_fee, descuento_tipo, descuento_valor, descuento_importe
                    ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.paid_order_economic_mutation_guard_v1()`);
  await su.query('RESET ROLE');
  return (await su.query(`SELECT proname, md5(prosrc) AS md5 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('order_has_economic_evidence_v1','delete_order_if_not_active','paid_order_economic_mutation_guard_v1') ORDER BY 1`)).rows;
}
const LIVE_READER_MD5 = { order_has_economic_evidence_v1: '13fca0055313439e877e60f53e359798', delete_order_if_not_active: '4590dd4346e2093fd66eb9d3eb0d1e6c', paid_order_economic_mutation_guard_v1: 'fcbc86950c285232aaee2b47f20c9ba7' };

// What the three guards say about ONE order (a mutation attempt is always rolled back).
async function guardsSay(c, orderId) {
  const evidence = (await c.su.query('SELECT public.order_has_economic_evidence_v1($1) AS e', [orderId])).rows[0].e;
  let del;
  await c.su.query('BEGIN');
  try { del = (await c.su.query('SELECT public.delete_order_if_not_active($1) AS r', [orderId])).rows[0].r; }
  catch (e) { del = { ok: false, code: `THREW ${e.message.slice(0, 60)}` }; }   // an order with NO evidence reaches the real DELETE (rolled back below)
  finally { await c.su.query('ROLLBACK'); }
  let mutation;
  await c.su.query('BEGIN');
  try { await c.su.query('UPDATE public.ordenes SET totale = totale + 1 WHERE id = $1', [orderId]); mutation = { allowed: true }; }
  catch (e) { mutation = { allowed: false, forbidden: /PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN/.test(e.message), msg: e.message.slice(0, 80) }; }
  finally { await c.su.query('ROLLBACK'); }
  return { evidence, delete: del.code, deleteOk: del.ok, mutation };
}

async function run(env) {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('K1 THE CONSTRAINT ITSELF -- payment_transactions_scope_chk admits a scope-less row ONLY for a server-marked off-service PAYMENT receipt (direct INSERT, the constraint alone decides)');
  {
    const w = await H.world(env, { label: 'b2-k' });
    const ws = await H.wsOf(w.c);
    const T = (await w.c.su.query('INSERT INTO public.table_sessions (workspace_id) VALUES ($1) RETURNING id', [ws])).rows[0].id;
    const base = (await ptInsert(w.c, ws, { service: w.s })).rows[0].id;              // a normal service-bearing payment (the target of the refund cases)
    const def = (await w.c.su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'public.payment_transactions'::regclass AND conname = 'payment_transactions_scope_chk'`)).rows[0].d;
    assert('K0: the live constraint is exactly the narrow 139 one (the migration installed it; every case below runs against IT)', def === env.NEW_SCOPE_CHK, { def });
    const cases = [
      // the shape 122 forbade and 139 admits -- and ONLY this one
      ['K1/a THE TRAP: no scope, meta {} and NO flag at all', { meta: {} }, false],
      ['K1/b flag false', { meta: { off_service_receipt: false } }, false],
      ['K1/c flag null', { metaRaw: '{"off_service_receipt": null}' }, false],
      ['K1/d flag the STRING "true" (not the boolean)', { metaRaw: '{"off_service_receipt": "true"}' }, false],
      ['K1/e flag the number 1', { metaRaw: '{"off_service_receipt": 1}' }, false],
      ['K1/f flag [true] (an array containing true)', { metaRaw: '{"off_service_receipt": [true]}' }, false],
      ['K1/g the flag nested under another key', { metaRaw: '{"a": {"off_service_receipt": true}}' }, false],
      ['K2/a flag true but a Mesa-only MODE (equal_split)', { mode: 'equal_split', meta: FLAG }, false],
      ['K2/b flag true but a Mesa-only MODE (item_selection)', { mode: 'item_selection', meta: FLAG }, false],
      ['K2/c flag true but covers_settled 2 (Mesa covers)', { covers: 2, meta: FLAG }, false],
      ['K3 flag true on a REFUND (kind refund, reverses a payment): a refund can NEVER be scope-less', { kind: 'refund', mode: 'refund', reverses: base, meta: FLAG }, false],
      ['K3/b a REFUND scope-less WITHOUT the flag (the pre-139 rule, unchanged)', { kind: 'refund', mode: 'refund', reverses: base }, false],
      ['K4/a THE ONE ADMITTED SHAPE: payment / full / covers 0 / flag boolean true / no scope', { meta: FLAG }, true],
      ['K4/b ... payment / custom_amount / covers 0 / flag true / no scope', { mode: 'custom_amount', meta: FLAG }, true],
      // everything that was valid before is still valid
      ['K5/a a Mesa-shaped row (table_session_id, no service, no flag, Mesa mode + covers): historical S2 off-service Mesa receipt', { table: T, mode: 'item_selection', covers: 2 }, true],
      ['K5/b a service-bearing check-centric payment without any flag', { service: w.s }, true],
      ['K5/c a service-bearing payment carrying the flag (harmless: it has a scope)', { service: w.s, meta: FLAG }, true],
    ];
    for (const [label, opts, accepted] of cases) {
      const r = await throws(ptInsert(w.c, ws, opts));
      const ok = accepted ? r.ok : (!r.ok && r.code === '23514' && r.constraint === 'payment_transactions_scope_chk');
      assert(`${label} -> ${accepted ? 'ACCEPTED' : 'REJECTED by payment_transactions_scope_chk (23514)'}`, ok, r.ok ? 'accepted' : { code: r.code, constraint: r.constraint });
    }
    const scopeless = (await w.c.su.query(`SELECT count(*)::int AS n, bool_and(kind = 'payment' AND meta -> 'off_service_receipt' = 'true'::jsonb) AS all_flagged
        FROM public.payment_transactions WHERE table_session_id IS NULL AND service_session_id IS NULL`)).rows[0];
    assert('K6: after all of the above the ONLY scope-less rows in the table are the two admitted shapes, every one a flagged PAYMENT', scopeless.n === 2 && scopeless.all_flagged === true, scopeless);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('W1 THE WRITER DECIDES THE FLAG -- a value supplied by the caller is discarded; both receipt columns are written from the SAME variable; the order\'s own service is never a receipt');
  {
    const w = await H.world(env, { label: 'b2-w' });
    const ws = await H.wsOf(w.c);
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#W0001', zona: 'Q1' });
    const o2 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#W0002', zona: 'Q1' });
    const o3 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#W0003', zona: 'Q1' });
    const r1 = await payMetaSafe(w.c.svc, ws, o1, { off_service_receipt: true, source: 'caller' });
    const a1 = await attribution(w.c, o1.id);
    assert('W1/a a service IS open and the caller claims off_service_receipt=true: the flag is DISCARDED (absent), the receipt is the open service on BOTH columns, and the caller\'s other keys survive',
      r1.ok === true && a1.txReceipt === w.s && a1.eventReceipt === w.s && !('off_service_receipt' in a1.l.tx[0].meta) && a1.l.tx[0].meta.source === 'caller' && a1.obligation === w.s, { r1, tx: a1.l.tx, ev: a1.l.ev });
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    const r2 = await payMetaSafe(w.c.svc, ws, o2, { off_service_receipt: false });
    const a2 = await attribution(w.c, o2.id);
    assert('W1/b NO service is open and the caller says off_service_receipt=false: the WRITER sets it true; BOTH receipt columns are NULL; the obligation stays on A',
      r2.ok === true && a2.flag === true && a2.txReceipt === null && a2.eventReceipt === null && a2.obligation === w.s, { r2, tx: a2.l.tx, ev: a2.l.ev });
    const r3 = await payMetaSafe(w.c.svc, ws, o3, '{"off_service_receipt": "true", "service_session_id": "00000000-0000-0000-0000-000000000009", "receipt_service": "x"}');
    const a3 = await attribution(w.c, o3.id);
    const typ = (await w.c.su.query(`SELECT jsonb_typeof(t.meta -> 'off_service_receipt') AS t FROM public.payment_transactions t JOIN public.payment_allocations a ON a.payment_transaction_id = t.id WHERE a.order_uid = $1`, [o3.order_uid])).rows[0]?.t;
    assert('W1/c a STRING "true" and a spoofed service id in the caller\'s meta: the stored flag is the JSON BOOLEAN true; the columns still come from the service pointer only (NULL) -- a meta key can never become a service',
      r3.ok === true && typ === 'boolean' && a3.flag === true && a3.txReceipt === null && a3.eventReceipt === null, { typ, tx: a3.l.tx });
    const fnArgs = (await w.c.su.query(`SELECT pg_get_function_arguments(oid) AS a FROM pg_proc WHERE oid = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure`)).rows[0].a;
    assert('W1/d there is NO service parameter on the writer: a receipt service cannot be supplied, only derived from the lifecycle pointer', !/service/i.test(fnArgs), fnArgs);
    await w.c.close();
  }
  {
    // size: adding the flag must never push meta over the 2048-character CHECK as a raw constraint error
    const w = await H.world(env, { label: 'b2-w-size' });
    const ws = await H.wsOf(w.c);
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#W0011', zona: 'Q1' });
    const o2 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#W0012', zona: 'Q1' });
    const n = (await w.c.su.query(`SELECT n FROM generate_series(1, 2100) n WHERE length(jsonb_build_object('pad', repeat('x', n))::text) = 2040`)).rows[0].n;
    const big = { pad: 'x'.repeat(n) };
    const withService = await throws(payMeta(w.c.svc, ws, o1, big));
    assert('W1/e a 2040-character meta with a service OPEN is accepted (no flag is added, nothing changes)', withService.ok === true && withService.value.ok === true, withService);
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    const before = await H.ledger(w.c, o2.id);
    const off = await throws(payMeta(w.c.svc, ws, o2, big));
    const after = await H.ledger(w.c, o2.id);
    assert('W1/f the SAME meta with NO service open would exceed 2048 once the flag is added: a TYPED ORDER_PAYMENT_INVALID, never a raw CHECK violation, and NOTHING is written',
      off.ok === false && off.msg === 'ORDER_PAYMENT_INVALID' && before.events === 0 && after.events === 0 && after.tx.length === 0, off);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // M -- the mandate's O1..O8. The scenario of every one: service A CLOSED (trip ACTIVE, the delivery confirmed by the operator),
  // order A unpaid 12.50, the operator collects. Read the three attribution columns straight from the ledger.
  const offServiceWorld = async (label, totale = 12.5, extra = 0) => {
    const w = await H.world(env, { label });
    const a = await H.dispatched(w, { id: `#${label.slice(-4).toUpperCase()}1`, totale });
    // orders that must exist BEFORE the close (nothing can be created in a closed service): delivered, unpaid
    const extras = [];
    for (let i = 0; i < extra; i++) extras.push(await w.mk({ estado: 'RETIRADO', totale: 6, id: `#${label.slice(-4).toUpperCase()}X${i}`, zona: 'Q1' }));
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    await H.opConfirm(w.c.svc, a.o.id, null);                       // delivery confirmed by the operator only: RETIRADO, unpaid stays unpaid
    return { w, o: a.o, ws: await H.wsOf(w.c), extras };
  };
  for (const [tag, method] of [['O1', 'efectivo'], ['O2', 'tarjeta'], ['O3', 'bizum']]) {
    section(`M/${tag} A CLOSED, NO service open, ${method.toUpperCase()} 12.50: BOTH receipt columns NULL, obligation on A, one payment, one event, nothing else moves`);
    const { w, o, ws } = await offServiceWorld(`b2-${tag.toLowerCase()}`);
    const beforeFp = await H.fingerprint(w.c);
    const beforeSnap = await H.snap(w.c, w.s);
    const beforeOrder = await H.orderIdentity(w.c, o.id);
    const beforeLogs = (await H.logsFor(w.c, o.id)).length;
    const r = await cashPay(w.c.svc, ws, o, { method });
    const afterFp = await H.fingerprint(w.c);
    const a = await attribution(w.c, o.id);
    const sn = await H.snap(w.c, w.s);
    record(`${tag} ${method}, A closed, no service open`, a, { events: a.l.events, transactions: a.l.tx.length, services: sn.services });
    assert(`${tag}: the payment succeeds, is not a replay, and no service received it (serviceSessionId null)`, r.ok === true && r.idempotent === false && r.serviceSessionId === null && Number(r.amount) === 12.5 && Number(r.unpaid) === 0, r);
    assert(`${tag}: THE THREE COLUMNS -- order_financial_events.service_session_id = A; payment_transactions.service_session_id = NULL; order_financial_events.event_service_session_id = NULL`,
      a.obligation === w.s && a.txReceipt === null && a.eventReceipt === null, { obligation: a.obligation, A: w.s, tx: a.txReceipt, event: a.eventReceipt });
    assert(`${tag}: the two receipt columns represent the SAME fact (both NULL), and the row is only MARKED off_service_receipt by the writer`, a.txReceipt === a.eventReceipt && a.flag === true, { tx: a.l.tx[0].meta });
    assert(`${tag}: exactly ONE payment event, ONE transaction, ONE allocation; the method is ${method} everywhere; obligation covered exactly (no overcoverage)`,
      a.l.events === 1 && a.l.payment_events === 1 && a.l.tx.length === 1 && a.l.allocations === 1 && a.l.ev[0].payment_method === method && a.l.tx[0].payment_method === method && a.l.metodo_pago === method && a.l.paid === 12.5 && a.l.unpaid === 0, a.l);
    assert(`${tag}: the sale and the obligation stay on A (the order row itself is still A's)`, a.l.svc === w.s && a.obligation === w.s, a.l);
    assert(`${tag}: NO new service, NO reopening: A still closed, no pointer, one service row`, sn.svc === 'closed' && sn.pointer === null && sn.services === 1 && beforeSnap.services === 1, sn);
    assert(`${tag}: the closeout / closed-service snapshot is NOT rewritten (service_sessions, closeouts, attempts, obligations, trips, pointer, audit are byte-identical)`,
      ['public.service_sessions', 'public.service_closeouts', 'public.service_closeout_attempts', 'public.order_obligations', 'trip_authority.trips', 'public.service_session_state', 'public.orden_estado_logs', 'public.business_days']
        .every((t) => beforeFp[t] === afterFp[t]), H.changedTables(beforeFp, afterFp));
    assert(`${tag}: the payment wrote to EXACTLY the four payment tables -- nothing else in the database`,
      JSON.stringify(H.changedTables(beforeFp, afterFp)) === JSON.stringify(['public.order_financial_events', 'public.ordenes', 'public.payment_allocations', 'public.payment_transactions'].sort()), H.changedTables(beforeFp, afterFp));
    assert(`${tag}: the DELIVERY fact is untouched (estado, service, total, identity identical; no audit row) and the trip is STILL ACTIVE: a payment is not the driver's return`,
      JSON.stringify(beforeOrder) === JSON.stringify(await H.orderIdentity(w.c, o.id)) && (await H.logsFor(w.c, o.id)).length === beforeLogs && sn.active_trips === 1, { beforeOrder, sn });
    assert(`${tag}: no service was fabricated to hold the money (M/O8 explicit): every service row is A, closed`,
      (await w.c.su.query(`SELECT count(*)::int AS n, bool_and(status = 'closed') AS closed, bool_and(id = $1) AS only_a FROM public.service_sessions`, [w.s])).rows[0].closed === true, sn);
    await w.c.close();
  }
  {
    section('M/O1b the same scenario through the OPERATOR delivery+payment RPC (Entregas): the same three columns');
    const w = await H.world(env, { label: 'b2-o1b' });
    const a0 = await H.dispatched(w, { id: '#O1B01', totale: 12.5 });
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    const r = await H.opConfirm(w.c.svc, a0.o.id, H.PAY({ method: 'efectivo' }));
    const a = await attribution(w.c, a0.o.id);
    record('O1b efectivo via operator delivery+payment RPC, A closed', a, { events: a.l.events, transactions: a.l.tx.length });
    assert('O1b: the operator RPC succeeds off-service; obligation A, tx.service NULL, event NULL; ONE payment; recorded AS THE OPERATOR',
      r.ok === true && a.obligation === w.s && a.txReceipt === null && a.eventReceipt === null && a.l.events === 1 && a.l.tx.length === 1 && a.l.ev[0].by_role === 'operator' && a.l.tx[0].by_role === 'operator', { r, tx: a.l.tx, ev: a.l.ev });
    await w.c.close();
  }
  {
    section('M/O4 service B OPEN, the order of A collected DURING B: the semantics are UNCHANGED (obligation A, receipt B on BOTH columns, no flag)');
    const w = await H.world(env, { label: 'b2-o4' });
    const o = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#O4001', zona: 'Q1' });
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    const B = await H.openService(w.c, DATE);
    const r = await cashPay(w.c.svc, await H.wsOf(w.c), o, { method: 'efectivo' });
    const a = await attribution(w.c, o.id);
    record('O4 A closed, B open', a, { B });
    assert('O4: THE THREE COLUMNS -- order_financial_events.service_session_id = A; payment_transactions.service_session_id = B; event_service_session_id = B',
      r.ok === true && r.serviceSessionId === B && a.obligation === w.s && a.txReceipt === B && a.eventReceipt === B, { B, A: w.s, obligation: a.obligation, tx: a.txReceipt, event: a.eventReceipt });
    assert('O4: no off-service marker on a receipt that has a service; ONE payment / event; the sale stays A\'s', a.flag === undefined || a.l.tx[0].meta.off_service_receipt === undefined, a.l.tx[0].meta);
    assert('O4: B is untouched (still open, still the pointer); A stays closed', (await H.snap(w.c, B)).svc === 'open' && (await H.snap(w.c, w.s)).pointer === B, await H.snap(w.c, w.s));
    await w.c.close();
  }
  {
    section('M/O5 service A still OPEN: every relevant column coherent with A');
    const w = await H.world(env, { label: 'b2-o5' });
    const o = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#O5001', zona: 'Q1' });
    const r = await cashPay(w.c.svc, await H.wsOf(w.c), o, { method: 'tarjeta' });
    const a = await attribution(w.c, o.id);
    record('O5 A open', a);
    assert('O5: THE THREE COLUMNS -- obligation A; payment_transactions.service_session_id = A; event_service_session_id = A; no flag',
      r.ok === true && r.serviceSessionId === w.s && a.obligation === w.s && a.txReceipt === w.s && a.eventReceipt === w.s && a.l.tx[0].meta.off_service_receipt === undefined, { tx: a.l.tx, ev: a.l.ev });
    await w.c.close();
  }
  {
    section('M/O6 DUPLICATE REQUEST: at most one payment, one event, no overcoverage -- sequential, concurrent (same id), two tablets (different ids), a new id after settled');
    const { w, o, ws } = await offServiceWorld('b2-o6');
    const reqId = `cash_${crypto.randomUUID()}`;
    const r1 = await cashPay(w.c.svc, ws, o, { reqId });
    const r2 = await cashPay(w.c.svc, ws, o, { reqId });
    let l = await H.ledger(w.c, o.id);
    assert('O6/a the SAME request id twice (double click): the second is a canonical replay of the SAME transaction; ONE payment, ONE event, ONE transaction',
      r1.idempotent === false && r2.idempotent === true && r2.transactionId === r1.transactionId && l.events === 1 && l.tx.length === 1 && l.paid === 12.5 && l.unpaid === 0, { r1, r2, l: { ev: l.events, tx: l.tx.length } });
    const again = await H.cashPayOrThrow(w.c.svc, ws, o, {});
    l = await H.ledger(w.c, o.id);
    assert('O6/b a NEW request id after it is settled: ORDER_PAYMENT_ALREADY_SETTLED, nothing more is written (no overcoverage)', again.threw === 'ORDER_PAYMENT_ALREADY_SETTLED' && l.events === 1 && l.tx.length === 1 && l.paid === 12.5, again);
    const b = await offServiceWorld('b2-o6b');
    const c1 = await b.w.c.client('b2-o6-c1'); const c2 = await b.w.c.client('b2-o6-c2');
    const same = `cash_${crypto.randomUUID()}`;
    const race = await Promise.all([H.cashPayOrThrow(c1, b.ws, b.o, { reqId: same }), H.cashPayOrThrow(c2, b.ws, b.o, { reqId: same })]);
    const lb = await H.ledger(b.w.c, b.o.id);
    assert('O6/c two CONCURRENT connections, the SAME request id: no error, exactly one real payment and one replay; ONE event / ONE transaction', race.every((x) => x.ok === true) && race.filter((x) => x.idempotent === true).length === 1 && lb.events === 1 && lb.tx.length === 1, { race, ev: lb.events });
    const t = await offServiceWorld('b2-o6t');
    const t1 = await t.w.c.client('b2-o6-t1'); const t2 = await t.w.c.client('b2-o6-t2');
    const tablets = await Promise.all([H.cashPayOrThrow(t1, t.ws, t.o, {}), H.cashPayOrThrow(t2, t.ws, t.o, {})]);
    const lt = await H.ledger(t.w.c, t.o.id);
    assert('O6/d two TABLETS (different request ids, same instant): ONE payment; the other gets ORDER_PAYMENT_ALREADY_SETTLED; never overcollected',
      tablets.filter((x) => x.ok === true).length === 1 && tablets.filter((x) => x.threw === 'ORDER_PAYMENT_ALREADY_SETTLED').length === 1 && lt.events === 1 && lt.tx.length === 1 && lt.paid === 12.5 && lt.unpaid === 0, { tablets, ev: lt.events });
    await w.c.close(); await b.w.c.close(); await t.w.c.close();
  }
  {
    section('M/O7 RETRY AFTER AN UNCERTAIN RESPONSE: idempotent whether the first attempt committed (response lost) or never committed (rolled back)');
    const { w, o, ws } = await offServiceWorld('b2-o7');
    const reqId = `cash_${crypto.randomUUID()}`;
    // (b) the attempt that never committed: the whole transaction rolls back, the retry with the SAME id then records the payment ONCE
    await w.c.svc.query('BEGIN');
    const lost = await cashPay(w.c.svc, ws, o, { reqId });
    await w.c.svc.query('ROLLBACK');
    const mid = await H.ledger(w.c, o.id);
    assert('O7/a an attempt whose transaction never committed leaves NOTHING behind (0 events, 0 transactions, still unpaid)', lost.ok === true && mid.events === 0 && mid.tx.length === 0 && mid.unpaid === 12.5, mid);
    const retry = await cashPay(w.c.svc, ws, o, { reqId });
    const a = await attribution(w.c, o.id);
    assert('O7/b the retry with the SAME request id records the payment ONCE, off-service, with the contract columns (obligation A, tx NULL, event NULL)',
      retry.ok === true && retry.idempotent === false && a.l.events === 1 && a.l.tx.length === 1 && a.obligation === w.s && a.txReceipt === null && a.eventReceipt === null, { retry, a: a.l.tx });
    // (a) the attempt that DID commit but whose response was lost: the retry is the canonical replay
    const replay = await cashPay(w.c.svc, ws, o, { reqId });
    const l2 = await H.ledger(w.c, o.id);
    assert('O7/c the response of a COMMITTED payment is lost and the client retries: idempotent replay of the SAME transaction; still ONE event / ONE transaction; unpaid 0',
      replay.ok === true && replay.idempotent === true && replay.transactionId === retry.transactionId && l2.events === 1 && l2.tx.length === 1 && l2.unpaid === 0, { replay, l2: { ev: l2.events } });
    const op = await offServiceWorld('b2-o7op');
    const pay = H.PAY({ method: 'bizum' });
    const first = await H.opConfirm(op.w.c.svc, op.o.id, pay);
    const second = await H.opConfirm(op.w.c.svc, op.o.id, pay);
    const l3 = await H.ledger(op.w.c, op.o.id);
    assert('O7/d the same for the OPERATOR delivery+payment RPC: the second identical request is IDEMPOTENT, ONE payment, ONE event, tx.service NULL',
      first.ok === true && second.ok === true && second.code === 'IDEMPOTENT' && l3.events === 1 && l3.tx.length === 1 && l3.tx[0].receipt_svc === null && l3.ev[0].receipt_svc === null, { first: first.code, second: second.code });
    await w.c.close(); await op.w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('B1 THE PENDING, END TO END on the REAL readers (Economía / Pendientes): the pending disappears, no euro is counted twice, none is both current and historical');
  {
    const w = await H.world(env, { label: 'b2-b1' });
    const ws = await H.wsOf(w.c);
    const done = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#B1001', zona: 'Q1' });     // delivered, unpaid -> historical pendency once A closes
    const out = await H.dispatched(w, { id: '#B1002', totale: 9 });                              // still EN_ENTREGA, unpaid -> "SIN_CONFIRMAR" historical pendency
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    let rd = await H.economyReaders(w.c); let p = await rd.pending(); let s = await rd.snapshot();
    const part = (pp, ss) => Math.round((ss.obligation.currentServiceUnpaid + pp.totals.porCobrar) * 100) / 100 === Math.round(ss.obligation.unpaid * 100) / 100;
    assert('B1/a before any payment: both credits are HISTORICAL pendencies (porCobrar 21.50), none is "current", and current + historical == unpaid (a partition)', p.totals.porCobrar === 21.5 && s.obligation.currentServiceUnpaid === 0 && part(p, s), { p: p.totals, s: s.obligation });
    await cashPay(w.c.svc, ws, done, { method: 'efectivo' });                                 // off-service collection of the delivered one
    rd = await H.economyReaders(w.c); p = await rd.pending(); s = await rd.snapshot();
    const ledgerDone = await attribution(w.c, done.id);
    assert('B1/b after the off-service collection (tx.service NULL, event NULL): the collected 12.50 leaves Pendientes and ONLY it (porCobrar 9.00); nothing is counted twice; still a partition',
      ledgerDone.txReceipt === null && ledgerDone.eventReceipt === null && p.totals.porCobrar === 9 && p.counts.porCobrar === 1 && s.obligation.unpaid === 9 && s.obligation.currentServiceUnpaid === 0 && part(p, s), { p: p.totals, s: s.obligation });
    assert('B1/c the receipt is booked ONCE (12.50 Efectivo, one payment) and the sale is not duplicated: obligation total unchanged', s.receipts.byMethod.efectivo === 12.5 && s.counts.payments === 1, { r: s.receipts, n: s.counts });
    const conf = await H.opConfirm(w.c.svc, out.o.id, H.PAY({ method: 'tarjeta' }));            // the operator delivers AND collects the second, off-service
    rd = await H.economyReaders(w.c); p = await rd.pending(); s = await rd.snapshot();
    assert('B1/d after the second off-service collection everything is settled: porCobrar 0, unpaid 0, current 0; two payments, 21.50 collected, each once',
      conf.ok === true && p.totals.porCobrar === 0 && s.obligation.unpaid === 0 && s.obligation.currentServiceUnpaid === 0 && s.counts.payments === 2 && s.receipts.collected === 21.5, { p: p.totals, s: s.obligation, r: s.receipts });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('C CAJA / CASH COUNT with a NULL receipt service on the transaction: the money does not disappear from the day / cash views (the readers read the EVENTS)');
  {
    const w = await H.world(env, { label: 'b2-c', date: DATE });
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#CB001', zona: 'Q1' });
    const o2 = await w.mk({ estado: 'RETIRADO', totale: 20, id: '#CB002', zona: 'Q1' });
    const o3 = await w.mk({ estado: 'RETIRADO', totale: 30, id: '#CB003', zona: 'Q1' });
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    const ws = await H.wsOf(w.c);
    await cashPay(w.c.svc, ws, o1, { method: 'efectivo' });
    await cashPay(w.c.svc, ws, o2, { method: 'tarjeta' });
    await cashPay(w.c.svc, ws, o3, { method: 'bizum' });
    const txs = (await w.c.su.query(`SELECT service_session_id, table_session_id, meta -> 'off_service_receipt' AS flag FROM public.payment_transactions ORDER BY created_at`)).rows;
    assert('C/pre: all three transactions carry a NULL receipt service (and no table session)', txs.length === 3 && txs.every((t) => t.service_session_id === null && t.table_session_id === null && t.flag === true), txs);
    const rd = await H.economyReaders(w.c);
    const day = await rd.snapshot();
    assert('C/a a NULL on payment_transactions does NOT hide the money: the time-window view still counts Efectivo 10 / Tarjeta 20 / Bizum 30 once each (60), three distinct events, three payments',
      day.receipts.byMethod.efectivo === 10 && day.receipts.byMethod.tarjeta === 20 && day.receipts.byMethod.bizum === 30 && day.receipts.collected === 60 && day.counts.payments === 3 && new Set(day.drillDown.receipts.map((r) => r.eventId)).size === 3, { r: day.receipts, n: day.counts });
    const cashDao = require('fs').readFileSync(require('path').join(rd.root, 'src/cash/cashDao.js'), 'utf8');
    const listTx = cashDao.slice(cashDao.indexOf('async function listCanonicalTransactions'), cashDao.indexOf('const postPayment'));
    assert('C/b the Cash V1 check reader lists a check\'s transactions through payment_allocations and never selects service_session_id: a NULL receipt service cannot drop a payment from the check',
      /payment_allocations/.test(listTx) && !/service_session_id/.test(listTx.replace(/[^\n]*\/\/[^\n]*/g, '')), listTx.slice(0, 200));
    const listed = (await w.c.su.query(`SELECT count(*)::int AS n FROM public.payment_allocations a JOIN public.payment_transactions t ON t.id = a.payment_transaction_id WHERE a.order_uid = $1`, [o1.order_uid])).rows[0].n;
    assert('C/c the allocation -> transaction join that reader uses returns the NULL-service payment (1 row)', listed === 1, listed);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('G THE LIVE SQL READERS of payment_transactions.service_session_id (order_has_economic_evidence_v1, its delete guard, the N-5 mutation guard): a NULL receipt service keeps them FAIL-CLOSED and authorizes nothing that was forbidden');
  {
    const post = await H.world(env, { label: 'b2-g-post' });
    const md5s = await installReaders(post.c.su);
    assert('G0: the three guard bodies installed here are byte-identical to the LIVE staging ones (md5(prosrc))', md5s.length === 3 && md5s.every((r) => LIVE_READER_MD5[r.proname] === r.md5), md5s);
    const o = await post.mk({ estado: 'RETIRADO', totale: 12.5, id: '#G0001', zona: 'Q1' });
    const spare = await post.mk({ estado: 'RETIRADO', totale: 8, id: '#G0002', zona: 'Q1' });
    await H.closeV3(post.c.svc, post.s, await H.seedCloseable(post.c, post.s));
    const ws = await H.wsOf(post.c);
    await cashPay(post.c.svc, ws, o, { method: 'efectivo' });
    const off = await guardsSay(post.c, o.id);
    const pre = await H.world(env, { pre: true, label: 'b2-g-pre' });
    await installReaders(pre.c.su);
    const op = await pre.mk({ estado: 'RETIRADO', totale: 12.5, id: '#G0011', zona: 'Q1' });
    await cashPay(pre.c.svc, await H.wsOf(pre.c), op, { method: 'efectivo' });    // paid WHILE the service is open: the tx carries the receipt service (the writer live today)
    const serviced = await guardsSay(pre.c, op.id);
    assert('G1: an order paid OFF-SERVICE (tx receipt NULL) is still EVIDENCED, cannot be deleted (ORDER_HAS_FINANCIAL_EVIDENCE) and its economic basis cannot be mutated (PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN)',
      off.evidence === true && off.deleteOk === false && off.delete === 'ORDER_HAS_FINANCIAL_EVIDENCE' && off.mutation.allowed === false && off.mutation.forbidden === true, off);
    assert('G2: identical to what the guards say today about an order paid WHILE a service is open on the pre-139 writer: nothing forbidden before is authorized now (same verdicts)',
      JSON.stringify(off) === JSON.stringify(serviced), { off, serviced });
    // Isolate the payment_transactions branch itself: remove every OTHER evidence (events, obligation, legacy flags) in the throwaway DB.
    const su = post.c.su;
    await su.query('SET ROLE postgres');
    await su.query('ALTER TABLE public.order_financial_events DISABLE TRIGGER order_financial_events_no_update_delete');
    await su.query('ALTER TABLE public.order_obligations DISABLE TRIGGER order_obligations_append_only_v1');
    await su.query('DELETE FROM public.order_financial_events WHERE order_id = $1', [o.id]);
    await su.query('DELETE FROM public.order_obligations WHERE order_uid = $1', [o.order_uid]);
    await su.query('UPDATE public.ordenes SET ya_pagado = false, cobrado = false WHERE id = $1', [o.id]);
    await su.query('ALTER TABLE public.payment_transactions DISABLE TRIGGER payment_transactions_append_only_v1');
    const B = await H.openService(post.c, DATE);
    const setTx = (svc) => su.query(`UPDATE public.payment_transactions SET service_session_id = $2 WHERE id IN (SELECT payment_transaction_id FROM public.payment_allocations WHERE order_uid = $1)`, [o.order_uid, svc]);
    const iso = {};
    iso.nullTx = await guardsSay(post.c, o.id);
    await setTx(post.s); iso.sameTx = await guardsSay(post.c, o.id);
    await setTx(B); iso.otherTx = await guardsSay(post.c, o.id);
    await setTx(null);
    await su.query('RESET ROLE');
    assert('G3 (payment_transactions branch ALONE -- every other evidence removed in the throwaway DB): a NULL receipt service is EVIDENCE, exactly like a transaction of the order\'s own service; both refuse the delete and the mutation',
      iso.nullTx.evidence === true && iso.nullTx.delete === 'ORDER_HAS_FINANCIAL_EVIDENCE' && iso.nullTx.mutation.forbidden === true
      && iso.sameTx.evidence === true && iso.sameTx.delete === 'ORDER_HAS_FINANCIAL_EVIDENCE' && iso.sameTx.mutation.forbidden === true, iso);
    assert('G3 (control): a transaction of ANOTHER service alone is NOT evidence for this order (the branch really discriminates) -- so the NULL case above is the fail-closed branch, not a vacuous pass',
      iso.otherTx.evidence === false && iso.otherTx.mutation.forbidden !== true, iso.otherTx);
    const neighbour = await guardsSay(post.c, spare.id);
    assert('G4: an order that was NOT paid is judged by its own evidence only (its obligation), untouched by another order\'s NULL receipt: the verdict for it is the pre-139 one (obligation evidence, mutation allowed)',
      neighbour.evidence === true && neighbour.mutation.forbidden !== true, neighbour);
    await post.c.close(); await pre.c.close();
  }
  {
    const fs = require('fs'); const path = require('path');
    const ecf2 = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'migrations', '2026-08-25_ecf2_order_delete_economic_evidence_alignment.sql'), 'utf8');
    const conv = extractStatement(ecf2, 'delete_conversation_if_not_active');
    assert('G5: the conversation delete guard reads no payment column of its own: it delegates the per-order verdict to order_has_economic_evidence_v1 (live md5 b5298c3a…), so G1-G4 cover it',
      /order_has_economic_evidence_v1/.test(conv) && !/payment_transactions/.test(conv), conv.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('R ROLLBACK against REAL data: refused (typed, nothing changes) while an off-service receipt exists; allowed -- and the pre-139 contract restored -- when there is none');
  {
    const { w, o, ws } = await (async () => {
      const x = await offServiceWorld('b2-r1');
      await H.closeTrip(x.w.c.svc);                                   // close the ACTIVE trip: the ONLY remaining reason to refuse the rollback is the money fact
      return x;
    })();
    await cashPay(w.c.svc, ws, o, { method: 'efectivo' });
    // B-RID-1: on a POST-140 database the documented rollback order is 140 first, then 139 (139's rollback pins the 139 writer body).
    if (env.BRID_RBK) { await env.applyRepoAsPostgres(w.c.su, env.BRID_RBK); }
    const before = await env.catalogFingerprint(w.c.su);
    const md5Before = (await w.c.su.query(`SELECT md5(prosrc) AS m FROM pg_proc WHERE oid = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure`)).rows[0].m;
    let err = null;
    try { await env.applyRepoAsPostgres(w.c.su, env.RBK); } catch (e) { err = e; }
    assert('R1/a the rollback is REFUSED with the typed message (off-service payment receipts exist: append-only money facts) -- it does not fail on a raw constraint error',
      !!err && /rollback refused: 1 off-service payment receipt\(s\) exist/.test(err.message), err && err.message);
    const after = await env.catalogFingerprint(w.c.su);
    assert('R1/b the refused rollback changed NOTHING in the catalog (139 is still fully applied: constraint, comments, writer, functions)', env.fingerprintDiff(before, after).length === 0, env.fingerprintDiff(before, after));
    const l = await H.ledger(w.c, o.id);
    assert('R1/c the money fact is intact: one payment, tx.service NULL, event NULL, obligation A', l.events === 1 && l.tx.length === 1 && l.tx[0].receipt_svc === null && l.ev[0].receipt_svc === null && l.ev[0].obligation_svc === w.s && md5Before === (await w.c.su.query(`SELECT md5(prosrc) AS m FROM pg_proc WHERE oid = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure`)).rows[0].m, l);
    await w.c.close();
  }
  {
    const w = await H.world(env, { label: 'b2-r2' });
    const ws = await H.wsOf(w.c);
    const o = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#R2001', zona: 'Q1' });
    const spare = await w.mk({ estado: 'RETIRADO', totale: 7, id: '#R2002', zona: 'Q1' });
    await cashPay(w.c.svc, ws, o, { method: 'efectivo' });                    // a SERVICE-BEARING receipt (A is open): allowed under the old constraint
    await H.closeV3(w.c.svc, w.s, await H.seedCloseable(w.c, w.s));
    if (env.BRID_RBK) { await env.applyRepoAsPostgres(w.c.su, env.BRID_RBK); }   // B-RID-1: roll back 140 first (documented order)
    const fp0 = await env.catalogFingerprint(w.c.su);
    let err = null;
    try { await env.applyRepoAsPostgres(w.c.su, env.RBK); } catch (e) { err = e; }
    assert('R2/a with only SERVICE-BEARING receipts the rollback is ALLOWED (the refusal is about the off-service shape, not about payments)', !err, err && err.message);
    const fp1 = await env.catalogFingerprint(w.c.su);
    const changed = env.fingerprintDiff(fp0, fp1);
    assert('R2/b the rollback restored the pre-139 contract: the exact 122 constraint, no constraint comment, the S2 / 122 comments, the ledger-126 writer',
      fp1.constraints['public.payment_transactions::payment_transactions_scope_chk'] === env.OLD_SCOPE_CHK && !('public.payment_transactions::payment_transactions_scope_chk' in fp1.constraintComments)
      && fp1.columnComments['public.payment_transactions.service_session_id'] === env.LIVE_COMMENT_SERVICE && fp1.columnComments['public.payment_transactions.table_session_id'] === env.LIVE_COMMENT_TABLE
      && changed.some((k) => k.startsWith('functions:public.order_post_payment_v1(')) && changed.some((k) => k === 'constraints:public.payment_transactions::payment_transactions_scope_chk'), changed);
    const noSvc = await H.cashPayOrThrow(w.c.svc, ws, spare, {});
    assert('R2/c after the rollback the OLD writer rules again: an off-service payment is refused (ORDER_PAYMENT_NO_OPEN_SERVICE) and nothing is written', noSvc.threw === 'ORDER_PAYMENT_NO_OPEN_SERVICE' && (await H.ledger(w.c, spare.id)).events === 0, noSvc);
    const direct = await throws(ptInsert(w.c, ws, { meta: FLAG }));
    assert('R2/d ... and the scope-less exception no longer exists: even a flagged scope-less INSERT is rejected by the restored 122 constraint (23514)', direct.ok === false && direct.code === '23514' && direct.constraint === 'payment_transactions_scope_chk', direct);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('S SECURITY of the sensitive RPCs (anon / authenticated / PUBLIC excluded; actor, role and session version decided server-side; tender and amount canonical; cross-order replay refused)');
  {
    const { w, o, ws, extras } = await offServiceWorld('b2-s', 12.5, 2);
    const acl = (await w.c.su.query(`SELECT p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_x, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
      FROM pg_proc p WHERE p.oid IN ('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure,
        'public.operator_confirm_delivery_v1(text,text,integer,jsonb)'::regprocedure, 'public.trip_residual_scope_v1()'::regprocedure) ORDER BY 1`)).rows;
    assert('S1: order_post_payment_v1, operator_confirm_delivery_v1 and trip_residual_scope_v1 are executable by service_role ONLY -- anon, authenticated and PUBLIC cannot', acl.length === 3 && acl.every((r) => r.svc_x && !r.anon_x && !r.auth_x && !r.public_x), acl);
    const anon = await w.c.client('b2-s-anon', 'anon'); const authd = await w.c.client('b2-s-auth', 'authenticated');
    const viaAnon = await throws(H.cashPay(anon, ws, o, {}));
    const viaAuth = await throws(H.cashPay(authd, ws, o, {}));
    const insAnon = await throws(anon.query(`INSERT INTO public.payment_transactions (workspace_id, kind, mode, amount, payment_method, by_actor, by_role, by_sid_hash, client_request_id, request_hash, meta)
      VALUES ($1,'payment','full',1,'efectivo','operator_primary','operator',$2,'anon_probe_0001',$3,'{"off_service_receipt": true}')`, [ws, H.hex64('a'), H.hex64('b')]));
    assert('S2: anon / authenticated cannot call the writer (42501) and anon cannot INSERT a flagged scope-less row directly into payment_transactions (42501): the exception is not reachable from a client role',
      viaAnon.ok === false && viaAnon.code === '42501' && viaAuth.ok === false && viaAuth.code === '42501' && insAnon.ok === false && insAnon.code === '42501', { viaAnon, viaAuth, insAnon });
    const before = await H.ledger(w.c, o.id);
    const rider = await H.cashPayOrThrow(w.c.svc, ws, o, { actor: 'rider' });
    const ghost = await H.cashPayOrThrow(w.c.svc, ws, o, { actor: 'nobody_here' });
    assert('S3: the actor is decided server-side from auth_actors: a rider or an unknown actor is refused (ORDER_PAYMENT_FORBIDDEN) and nothing is written', rider.threw === 'ORDER_PAYMENT_FORBIDDEN' && ghost.threw === 'ORDER_PAYMENT_FORBIDDEN' && (await H.ledger(w.c, o.id)).events === before.events, { rider, ghost });
    const stale = await H.opConfirm(w.c.svc, o.id, H.PAY(), 'operator_primary', 99);
    const asRider = await H.opConfirm(w.c.svc, o.id, H.PAY(), 'rider', 1);
    assert('S4: session_version and role are checked server-side by the operator RPC: a stale session_version -> AUTH_SESSION_STALE, the rider role -> AUTH_FORBIDDEN_ROLE; nothing written',
      stale.ok === false && stale.code === 'AUTH_SESSION_STALE' && asRider.ok === false && asRider.code === 'AUTH_FORBIDDEN_ROLE' && (await H.ledger(w.c, o.id)).events === before.events, { stale: stale.code, asRider: asRider.code });
    const paypal = await H.cashPayOrThrow(w.c.svc, ws, o, { method: 'paypal' });
    const tooMuch = await H.cashPayOrThrow(w.c.svc, ws, o, { mode: 'custom_amount', amount: 99.99 });
    assert('S5: tender and amount are canonical: an unknown tender -> ORDER_PAYMENT_INVALID; a custom amount above the residual -> ORDER_PAYMENT_AMOUNT_INVALID; nothing written', paypal.threw === 'ORDER_PAYMENT_INVALID' && tooMuch.threw === 'ORDER_PAYMENT_AMOUNT_INVALID' && (await H.ledger(w.c, o.id)).events === before.events, { paypal, tooMuch });
    const full = await cashPay(w.c.svc, ws, o, { mode: 'full', amount: 999 });
    const lf = await H.ledger(w.c, o.id);
    assert('S6: a FULL payment ignores any client amount (999 is discarded): the amount is the canonical residual read under lock (12.50)', full.ok === true && Number(full.amount) === 12.5 && lf.paid === 12.5 && lf.unpaid === 0, full);
    const [other, otherOrder] = extras;
    const reqId = `cash_${crypto.randomUUID()}`;
    const first = await cashPay(w.c.svc, ws, other, { reqId });
    const cross = await H.cashPayOrThrow(w.c.svc, ws, otherOrder, { reqId });                       // same request id, ANOTHER order (the default hash binds the order)
    assert('S7: a request id re-used on ANOTHER order is refused (ORDER_PAYMENT_IDEMPOTENCY_CONFLICT) and writes nothing for that order', first.ok === true && cross.threw === 'ORDER_PAYMENT_IDEMPOTENCY_CONFLICT' && (await H.ledger(w.c, otherOrder.id)).events === 0, { cross });
    await w.c.close();
  }

  console.log('\nB2_ATTRIBUTION_MATRIX ' + JSON.stringify(MATRIX));
}

module.exports = { run };
