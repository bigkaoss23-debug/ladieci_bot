'use strict';
// tests/w5IntentActivationReconciler.test.js — src/delivery/giroIntentReconciler.js.
// Pure control-flow test against an injected fake `rpc`, no DB, no network. Proves:
// bounded scope (empty/missing session ids -> zero calls), the exact RPC call shapes
// (function names, params, actor constant), per-candidate failure isolation, correct
// attempted/consumed counting (replay and non-CONSUMED outcomes never count), and
// that the module truly never throws regardless of what the fake transport does.
//
// Run: node tests/w5IntentActivationReconciler.test.js

const {
  reconcilePendingGiroIntents,
  GIRO_INTENT_AUTO_CONSUME_ACTOR,
  DEFAULT_BATCH_LIMIT,
} = require("../src/delivery/giroIntentReconciler");

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

function listRpc(candidates, { ok = true } = {}) {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === "giro_authority_list_pending_intents_v1") {
      return ok ? { httpStatus: 200, ok: true, body: candidates } : { httpStatus: 500, ok: false, body: null };
    }
    throw new Error("unexpected rpc in listRpc-only fixture: " + fn);
  };
  return { rpc, calls };
}

(async () => {
  console.log("\n── bounds: no operationalSessionIds -> zero RPC calls ──");
  {
    const { rpc, calls } = listRpc([{ order_uid: "u1" }]);
    const out = await reconcilePendingGiroIntents({ rpc });
    check("no sessionIds -> outcome is {attempted:0,consumed:0}", out.attempted === 0 && out.consumed === 0);
    check("no sessionIds -> zero RPC calls (never even lists)", calls.length === 0);
  }
  {
    const { rpc, calls } = listRpc([{ order_uid: "u1" }]);
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: [], rpc });
    check("empty sessionIds array -> outcome is {attempted:0,consumed:0}", out.attempted === 0 && out.consumed === 0);
    check("empty sessionIds array -> zero RPC calls", calls.length === 0);
  }
  {
    const { rpc, calls } = listRpc([{ order_uid: "u1" }]);
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: "not-an-array", rpc });
    check("non-array sessionIds -> outcome is {attempted:0,consumed:0}, never throws", out.attempted === 0 && out.consumed === 0);
    check("non-array sessionIds -> zero RPC calls", calls.length === 0);
  }

  console.log("\n── list-call shape: function name, scope, limit, default limit ──");
  {
    const { rpc, calls } = listRpc([]);
    await reconcilePendingGiroIntents({ operationalSessionIds: ["s1", "s2"], rpc });
    check("exactly one call, to the list RPC", calls.length === 1 && calls[0].fn === "giro_authority_list_pending_intents_v1");
    check("scope threaded through unchanged", JSON.stringify(calls[0].args.p_operational_session_ids) === JSON.stringify(["s1", "s2"]));
    check("default limit applied when omitted", calls[0].args.p_limit === DEFAULT_BATCH_LIMIT);
  }
  {
    const { rpc, calls } = listRpc([]);
    await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], limit: 5, rpc });
    check("explicit limit passed through", calls[0].args.p_limit === 5);
  }

  console.log("\n── list call fails / malformed -> zero-attempt outcome, no crash ──");
  {
    const { rpc } = listRpc([], { ok: false });
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], rpc });
    check("list RPC not ok -> outcome is {attempted:0,consumed:0}", out.attempted === 0 && out.consumed === 0);
  }
  {
    const rpc = async () => ({ httpStatus: 200, ok: true, body: { not: "an array" } });
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], rpc });
    check("list RPC body not an array -> outcome is {attempted:0,consumed:0}", out.attempted === 0 && out.consumed === 0);
  }
  {
    const rpc = async () => { throw new Error("network exploded"); };
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], rpc });
    check("list RPC throws synchronously-awaited -> never propagates, outcome is {attempted:0,consumed:0}",
      out.attempted === 0 && out.consumed === 0);
  }

  console.log("\n── consume-call shape: function name, actor constant, order_uid, scope ──");
  {
    const calls = [];
    const rpc = async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "giro_authority_list_pending_intents_v1") return { ok: true, body: [{ order_uid: "order-abc" }] };
      return { ok: true, body: { status: "CONSUMED", code: "OK", replay: false } };
    };
    await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], rpc });
    check("second call is to the consume RPC", calls[1].fn === "giro_authority_consume_intent_v1");
    check("consume call carries the candidate's order_uid", calls[1].args.p_order_uid === "order-abc");
    check("consume call uses the shared automatic-actor constant, not a request-derived value",
      calls[1].args.p_actor === GIRO_INTENT_AUTO_CONSUME_ACTOR);
    check("consume call reuses the same operational scope as the list call",
      JSON.stringify(calls[1].args.p_operational_session_ids) === JSON.stringify(["s1"]));
  }

  console.log("\n── counting: only a real, non-replay CONSUMED counts as consumed ──");
  {
    const outcomes = [
      { status: "CONSUMED", replay: false },   // real mutation -> counts
      { status: "CONSUMED", replay: true },    // terminal replay -> does not count
      { status: "REJECTED", replay: false },   // rejected -> does not count
      { status: "EXPIRED", replay: false },    // expired -> does not count
      { code: "NO_INTENT" },                   // no intent at all -> does not count
    ];
    let i = 0;
    const rpc = async (fn) => {
      if (fn === "giro_authority_list_pending_intents_v1") {
        return { ok: true, body: outcomes.map((_, idx) => ({ order_uid: `u${idx}` })) };
      }
      return { ok: true, body: outcomes[i++] };
    };
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], rpc });
    check("attempted counts every candidate", out.attempted === outcomes.length);
    check("consumed counts exactly the one real non-replay CONSUMED outcome", out.consumed === 1);
  }

  console.log("\n── per-candidate isolation: one consume failure never aborts the batch ──");
  {
    const candidates = [{ order_uid: "u1" }, { order_uid: "u2" }, { order_uid: "u3" }];
    let call = 0;
    const rpc = async (fn) => {
      if (fn === "giro_authority_list_pending_intents_v1") return { ok: true, body: candidates };
      call += 1;
      if (call === 2) throw new Error("transient failure on the second candidate");
      return { ok: true, body: { status: "CONSUMED", replay: false } };
    };
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], rpc });
    check("all 3 candidates attempted despite the middle one throwing", out.attempted === 3);
    check("the 2 that succeeded are still counted as consumed", out.consumed === 2);
  }

  console.log("\n── candidates with a malformed order_uid are skipped, never crash ──");
  {
    const rpc = async (fn) => {
      if (fn === "giro_authority_list_pending_intents_v1") {
        return { ok: true, body: [{ order_uid: null }, {}, { order_uid: 42 }, { order_uid: "real" }] };
      }
      return { ok: true, body: { status: "CONSUMED", replay: false } };
    };
    const out = await reconcilePendingGiroIntents({ operationalSessionIds: ["s1"], rpc });
    check("only the one candidate with a real string order_uid is attempted", out.attempted === 1 && out.consumed === 1);
  }

  console.log("\n── never throws: default export contract holds even with a hostile rpc ──");
  {
    let threw = false;
    try {
      await reconcilePendingGiroIntents({
        operationalSessionIds: ["s1"],
        rpc: async () => { throw new TypeError("boom"); },
      });
    } catch (_) { threw = true; }
    check("reconcilePendingGiroIntents itself never throws", !threw);
  }

  console.log("");
  console.log("Totale: " + (pass + fail) + " | PASS: " + pass + " | FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
