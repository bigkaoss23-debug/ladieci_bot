"use strict";
// S2-7D6D — the order-level half of "may we auto-close this session". Pure
// against an injected `select`, so every non-terminal estado is provable
// without a database. Mirrors the exact terminal-state list chiudiServizio's
// own PASSO 3 archive step already uses, so "pending" here means precisely
// what an automatic force-close would otherwise have swept up.
const { hasPendingOperationalActivity, TERMINAL_STATES } = require("../src/serviceSessions/pendingActivityGuard");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const run = (fn) => { const p = fn(); if (p && typeof p.then === "function") return p; throw new Error("expected a promise"); };

const selectReturning = (rows) => async (_table, _query) => rows;
const selectCapturingQuery = (rows, capture) => async (_table, query) => { capture.query = query; return rows; };

(async () => {
  console.log("\n══ A. no session id ══");
  {
    const r = await hasPendingOperationalActivity({ sessionId: null, select: selectReturning([{ id: 1 }]) });
    assert("no sessionId -> pending:false (fail closed on the read, not on the answer)", r.pending === false);
  }

  console.log("\n══ B. each non-terminal estado independently blocks ══");
  for (const estado of ["POR_CONFIRMAR", "NUEVO", "EN_COCINA", "LISTO", "EN_ENTREGA"]) {
    const r = await hasPendingOperationalActivity({ sessionId: "s1", select: selectReturning([{ id: 1, estado }]) });
    assert(`${estado} order -> pending:true (auto-close must not sweep it up)`, r.pending === true);
  }

  console.log("\n══ C. only terminal orders -> not pending ══");
  {
    const r = await hasPendingOperationalActivity({ sessionId: "s1", select: selectReturning([]) });
    assert("no rows returned (all terminal / none open) -> pending:false", r.pending === false);
  }

  console.log("\n══ D. scoped to the given session, uses chiudiServizio's own terminal list ══");
  {
    const cap = {};
    await hasPendingOperationalActivity({ sessionId: "abc-123", select: selectCapturingQuery([], cap) });
    assert("query is scoped to service_session_id", cap.query.includes("service_session_id=eq.abc-123"));
    assert("terminal states match chiudiServizio's PASSO 3 list", TERMINAL_STATES.join(",") === "RETIRADO,COMPLETADO,COMPLETATO");
    assert("query excludes exactly the terminal states", cap.query.includes("estado=not.in.(RETIRADO,COMPLETADO,COMPLETATO)"));
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})();
