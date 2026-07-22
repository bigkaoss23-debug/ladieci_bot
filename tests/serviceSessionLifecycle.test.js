"use strict";
const assert=require("node:assert/strict"); const test=require("node:test");
const {createServiceSessionLifecycle}=require("../src/serviceSessions/serviceSessionLifecycle");

test("open, close and closeout use exact RPC contracts without caller-selected identity",async()=>{
  const calls=[]; const rpc=async(fn,args)=>{calls.push([fn,args]); return {ok:true,body:{ok:true,code:"OK",session:{id:"S"}}};};
  const lifecycle=createServiceSessionLifecycle({rpc});
  await lifecycle.open({actor:"owner",source:"manual"});
  await lifecycle.beginClose({actor:"owner",source:"manual"});
  await lifecycle.completeClose({sessionId:"S",actor:"owner",source:"manual"});
  await lifecycle.currentCloseout();
  assert.deepEqual(calls.map(c=>c[0]),["open_service_session","begin_service_session_close","complete_service_session_close","get_current_service_closeout_session"]);
  assert.deepEqual(calls[3][1],{});
});

test("transport and malformed RPC results fail closed",async()=>{
  const lifecycle=createServiceSessionLifecycle({rpc:async()=>({ok:false,body:null})});
  assert.deepEqual(await lifecycle.currentCloseout(),{ok:false,code:"SERVICE_SESSION_TRANSPORT_ERROR"});
});
