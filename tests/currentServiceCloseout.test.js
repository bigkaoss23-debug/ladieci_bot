"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createCurrentServiceCloseout } = require("../src/closeout/currentServiceCloseout");
const roles = require("../src/auth/legacyActionRoles");

const session = (overrides={}) => ({ id:"00000000-0000-4000-8000-00000000000a", business_date:"2026-07-22", opened_at:"2026-07-22T17:00:00Z", closed_at:null, status:"open", ...overrides });
const identity = (value) => ({ currentCloseout: async()=>value });

test("open closeout scopes live tickets and financial events exclusively by session identity", async()=>{
  const s=session(); const calls=[];
  const select=async(table,query)=>{ calls.push([table,query]); if(table==="ordenes") return [{id:"o1",service_session_id:s.id,totale:20,cobrado:true,metodo_pago:"efectivo",nombre:"SECRET"}]; return []; };
  const out=await createCurrentServiceCloseout({select,sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.serviceSessionId,s.id); assert.equal(out.businessDate,"2026-07-22"); assert.equal(out.openedAt,s.opened_at);
  assert.equal(JSON.stringify(out).includes("SECRET"),false);
  assert.ok(calls.every(([,q])=>q.includes(`service_session_id=eq.${s.id}`)));
  assert.equal(calls.some(([,q])=>/fecha=|order=opened_at|limit=1/.test(q)),false);
});

test("closed closeout uses lifecycle-authorized archive session, not date or latest row",async()=>{
  const s=session({id:"00000000-0000-4000-8000-00000000000b",status:"closed",closed_at:"2026-07-22T22:00:00Z"}); const calls=[];
  const select=async(table,q)=>{calls.push([table,q]); return table==="storico"?[{orden_id:"o2",service_session_id:s.id,totale:15,cobrado:true}]:[];};
  const out=await createCurrentServiceCloseout({select,sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.status,"closed"); assert.equal(out.closedAt,s.closed_at); assert.equal(calls[0][0],"storico");
  assert.match(calls[0][1],new RegExp(s.id)); assert.doesNotMatch(calls[0][1],/fecha|desc|limit/);
});

test("no lifecycle session is controlled and does not query data",async()=>{
  let reads=0; const out=await createCurrentServiceCloseout({select:async()=>{reads++;},sessionLifecycle:identity({ok:true,code:"NO_SERVICE_SESSION"})})();
  assert.equal(out.available,false); assert.equal(out.code,"NO_CURRENT_SERVICE"); assert.equal(reads,0);
});

test("multiple active sessions and mixed membership fail closed",async()=>{
  await assert.rejects(createCurrentServiceCloseout({select:async()=>[],sessionLifecycle:identity({ok:false,code:"MULTIPLE_ACTIVE_SERVICE_SESSIONS"})})(),e=>e.code==="MULTIPLE_ACTIVE_SERVICE_SESSIONS");
  const s=session();
  await assert.rejects(createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?[{id:"x",service_session_id:"wrong"}]:[],sessionLifecycle:identity({ok:true,code:"OK",session:s})})(),e=>e.code==="MIXED_SERVICE_SESSION_ROWS");
});

test("lunch and dinner on one business date never mix",async()=>{
  const lunch=session({id:"00000000-0000-4000-8000-00000000000a",status:"closed",closed_at:"2026-07-22T13:00:00Z"});
  const dinner=session({id:"00000000-0000-4000-8000-00000000000b",status:"open",opened_at:"2026-07-22T16:00:00Z"});
  assert.notEqual(lunch.id,dinner.id); assert.equal(lunch.business_date,dinner.business_date);
  const rows=[{id:"d1",service_session_id:dinner.id,totale:12}];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?rows:[],sessionLifecycle:identity({ok:true,code:"OK",session:dinner})})();
  assert.deepEqual(out.tickets.map(t=>t.id),["d1"]);
});

// S2-7D6C2 — the closeout must say WHICH service it reports, from the session
// row only. Covers every return path that produces a contract object.
test("closeout projects service kind from the session row, never derives it",async()=>{
  const mk=async(s)=>createCurrentServiceCloseout({select:async()=>[],sessionLifecycle:identity({ok:true,code:"OK",session:s})})();

  const lunch=await mk(session({service_kind:"PRANZO"}));
  assert.equal(lunch.serviceKind,"PRANZO");

  const dinner=await mk(session({service_kind:"SERA",opened_at:"2026-07-22T20:00:00Z"}));
  assert.equal(dinner.serviceKind,"SERA");

  // A CLOSED lunch stays PRANZO even while the evening is the current service:
  // the kind belongs to the reported session, not to "now".
  const closedLunch=await mk(session({service_kind:"PRANZO",status:"closed",closed_at:"2026-07-22T13:30:00Z"}));
  assert.equal(closedLunch.serviceKind,"PRANZO");

  // Legacy rows closed before the column existed: null, never guessed.
  const legacy=await mk(session({status:"closed",closed_at:"2026-07-22T22:00:00Z"}));
  assert.equal(legacy.serviceKind,null);

  // Same business_date and same opening hour for both kinds — proof the value
  // cannot have been inferred from the date or the clock.
  const a=await mk(session({service_kind:"PRANZO",opened_at:"2026-07-22T17:00:00Z"}));
  const b=await mk(session({service_kind:"SERA",opened_at:"2026-07-22T17:00:00Z"}));
  assert.equal(a.businessDate,b.businessDate);
  assert.equal(a.openedAt,b.openedAt);
  assert.notEqual(a.serviceKind,b.serviceKind);
});

test("no-session closeout still carries the key, as an explicit null",async()=>{
  const out=await createCurrentServiceCloseout({select:async()=>[],sessionLifecycle:identity({ok:true,code:"NO_SERVICE_SESSION"})})();
  assert.equal(Object.hasOwn(out,"serviceKind"),true);
  assert.equal(out.serviceKind,null);
});

test("service crossing midnight keeps opening business date and one identity",async()=>{
  const s=session({opened_at:"2026-07-22T17:00:00Z",closed_at:"2026-07-22T22:30:00Z",status:"closed"});
  const out=await createCurrentServiceCloseout({select:async()=>[],sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.businessDate,"2026-07-22"); assert.equal(out.serviceSessionId,s.id); assert.equal(out.closedAt,"2026-07-22T22:30:00Z");
});

test("financial reconciliation and role boundary remain intact",async()=>{
  const s=session(); const orders=[{id:"p",service_session_id:s.id,totale:20},{id:"u",service_session_id:s.id,totale:8}];
  const events=[{order_id:"p",service_session_id:s.id,type:"payment",amount:20,payment_method:"tarjeta"}];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?orders:events,sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.totals.collected,20); assert.equal(out.totals.unpaid,8);
  assert.equal(roles.isAllowed("admin","getCurrentServiceCloseout"),true); assert.equal(roles.isAllowed("operator","getCurrentServiceCloseout"),true); assert.equal(roles.isAllowed("rider","getCurrentServiceCloseout"),false);
  assert.equal(roles.isAllowed("admin","openServiceSession"),true); assert.equal(roles.isAllowed("operator","openServiceSession"),true); assert.equal(roles.isAllowed("rider","openServiceSession"),false);
});

test("partial mixed-method table payments preserve exact method buckets and residual",async()=>{
  const s=session();
  const orders=[{id:"table-1",service_session_id:s.id,totale:50}];
  const events=[
    {order_id:"table-1",service_session_id:s.id,type:"payment",amount:12,payment_method:"efectivo"},
    {order_id:"table-1",service_session_id:s.id,type:"payment",amount:8,payment_method:"tarjeta"},
  ];
  const out=await createCurrentServiceCloseout({
    select:async(t)=>t==="ordenes"?orders:events,
    sessionLifecycle:identity({ok:true,code:"OK",session:s}),
  })();
  assert.equal(out.totals.gross,50);
  assert.equal(out.totals.collected,20);
  assert.equal(out.totals.unpaid,30);
  assert.equal(out.paymentTotals.efectivo,12);
  assert.equal(out.paymentTotals.tarjeta,8);
  assert.equal(out.tickets[0].paymentState,"partially_paid");
  assert.equal(out.tickets[0].paymentMethod,"mixto");
  assert.equal(out.counts.partiallyPaid,1);
});

test("a partial refund reduces its original method without erasing other methods",async()=>{
  const s=session();
  const orders=[{id:"table-2",service_session_id:s.id,totale:30}];
  const events=[
    {order_id:"table-2",service_session_id:s.id,type:"payment",amount:10,payment_method:"efectivo"},
    {order_id:"table-2",service_session_id:s.id,type:"payment",amount:20,payment_method:"tarjeta"},
    {order_id:"table-2",service_session_id:s.id,type:"refund",amount:5,payment_method:"tarjeta"},
  ];
  const out=await createCurrentServiceCloseout({
    select:async(t)=>t==="ordenes"?orders:events,
    sessionLifecycle:identity({ok:true,code:"OK",session:s}),
  })();
  assert.equal(out.totals.collected,25);
  assert.equal(out.totals.unpaid,5);
  assert.equal(out.paymentTotals.efectivo,10);
  assert.equal(out.paymentTotals.tarjeta,15);
  assert.equal(out.tickets[0].paymentState,"partially_paid");
});

// P0 — force-closed-table economic classification. The audit's own semantic
// verdict: operational terminalization (kitchen never confirmed served),
// NOT economic void. Reproduced live on staging: 9 real orders in this
// estado, 7 fully paid, 1 partially paid, 1 unpaid — the old CANCELLED-set
// membership zeroed gross/collected/unpaid/cash/card/bizum for all of them
// regardless of real ledger evidence. Cases A/B/C/F below mirror the exact
// scenarios from that audit's regression-test brief. The literal itself is
// named once, below, so the rest of this block never repeats it.
const FORCE_CLOSED_TABLE_ESTADO = "CHIUSO_FORZATO"; // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal under test throughout this block; named once here so every test below references the constant instead, not new vocabulary

test("P0-A — force-closed-table order fully paid (cash) reads real money, not zero",async()=>{
  const s=session();
  const orders=[{id:"o-a",service_session_id:s.id,totale:100,estado:FORCE_CLOSED_TABLE_ESTADO}];
  const events=[{order_id:"o-a",service_session_id:s.id,type:"payment",amount:100,payment_method:"efectivo"}];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?orders:events,sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.totals.gross,100);
  assert.equal(out.totals.collected,100);
  assert.equal(out.totals.unpaid,0);
  assert.equal(out.paymentTotals.efectivo,100);
  assert.equal(out.tickets[0].paymentState,"paid");
  assert.equal(out.tickets[0].cancelled,false);
  assert.equal(out.counts.cancelled,0);
});

test("P0-B — force-closed-table order partially paid (card) reads real gross/collected/unpaid, not zero",async()=>{
  const s=session();
  const orders=[{id:"o-b",service_session_id:s.id,totale:100,estado:FORCE_CLOSED_TABLE_ESTADO}];
  const events=[{order_id:"o-b",service_session_id:s.id,type:"payment",amount:50,payment_method:"tarjeta"}];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?orders:events,sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.totals.gross,100);
  assert.equal(out.totals.collected,50);
  assert.equal(out.totals.unpaid,50);
  assert.equal(out.paymentTotals.tarjeta,50);
  assert.equal(out.tickets[0].paymentState,"partially_paid");
  assert.equal(out.tickets[0].cancelled,false);
});

test("P0-C — force-closed-table order with zero payment reads real unpaid exposure, not a silent zero",async()=>{
  const s=session();
  const orders=[{id:"o-c",service_session_id:s.id,totale:100,estado:FORCE_CLOSED_TABLE_ESTADO}];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?orders:[],sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.totals.gross,100);
  assert.equal(out.totals.collected,0);
  assert.equal(out.totals.unpaid,100);
  assert.equal(out.tickets[0].paymentState,"unpaid");
  assert.equal(out.tickets[0].cancelled,false);
});

// OVER-COLLECTED SLICE A — a genuinely CANCELADO order still VOIDS the
// obligation (gross/unpaid stay 0, paymentState stays "cancelled"), but its
// real payment evidence is a fact that already happened and must no longer
// be erased: collected/paymentTotals now report the true 100.00 collected,
// and the surplus is published as overCollected rather than hidden behind a
// false zero (frozen invariant #1, "payment facts are never erased by order
// state" — over-collected audit, 2026-08-26). Pre-Slice-A this test asserted
// collected=0/paymentTotals.efectivo=0, which was exactly the bug: cash
// really received on a since-cancelled order vanished from every reader.
test("P0-D — a genuinely CANCELADO order voids the obligation but its real payment stays visible as overCollected",async()=>{
  const s=session();
  const orders=[{id:"o-d",service_session_id:s.id,totale:100,estado:"CANCELADO"}];
  const events=[{order_id:"o-d",service_session_id:s.id,type:"payment",amount:100,payment_method:"efectivo"}];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?orders:events,sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.totals.gross,0);
  assert.equal(out.totals.collected,100);
  assert.equal(out.totals.unpaid,0);
  assert.equal(out.totals.overCollected,100);
  assert.equal(out.paymentTotals.efectivo,100);
  assert.equal(out.tickets[0].paymentState,"cancelled");
  assert.equal(out.tickets[0].cancelled,true);
  assert.equal(out.tickets[0].overCollectedAmount,100);
  assert.equal(out.counts.cancelled,1);
});

test("P0-E — a genuinely ANULADO order keeps today's void semantics unchanged",async()=>{
  const s=session();
  const orders=[{id:"o-e",service_session_id:s.id,totale:40,estado:"ANULADO"}];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?orders:[],sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.totals.gross,0);
  assert.equal(out.tickets[0].cancelled,true);
  assert.equal(out.tickets[0].paymentState,"cancelled");
});

test("P0-F — force-closed-table mixed-method payment preserves exact per-method buckets",async()=>{
  const s=session();
  const orders=[{id:"o-f",service_session_id:s.id,totale:100,estado:FORCE_CLOSED_TABLE_ESTADO}];
  const events=[
    {order_id:"o-f",service_session_id:s.id,type:"payment",amount:30,payment_method:"efectivo"},
    {order_id:"o-f",service_session_id:s.id,type:"payment",amount:20,payment_method:"tarjeta"},
    {order_id:"o-f",service_session_id:s.id,type:"payment",amount:0.5,payment_method:"bizum"},
  ];
  const out=await createCurrentServiceCloseout({select:async(t)=>t==="ordenes"?orders:events,sessionLifecycle:identity({ok:true,code:"OK",session:s})})();
  assert.equal(out.totals.gross,100);
  assert.equal(out.totals.collected,50.5);
  assert.equal(out.totals.unpaid,49.5);
  assert.equal(out.paymentTotals.efectivo,30);
  assert.equal(out.paymentTotals.tarjeta,20);
  assert.equal(out.paymentTotals.bizum,0.5);
  assert.equal(out.tickets[0].paymentMethod,"mixto");
});
