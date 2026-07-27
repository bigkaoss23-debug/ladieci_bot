'use strict';
// S2-7D6E4 — step-up PIN confirmation for the operational admin.
//
// WHY. `setActorPin` lets an authenticated admin change ANY actor's PIN, including their
// own, on the strength of the same admin session used for every other action. An admin
// session left unlocked for a moment is enough to walk up and change every PIN on the
// workspace. This module adds a deliberate re-authentication step: the admin must
// correctly re-enter their OWN current PIN before setActorPin will accept a change — the
// same friction a bank applies before a sensitive settings change, not a new privilege.
//
// The check reuses the EXACT lockout-safe sequence login.js uses (lock pre-check, sensitive
// read, real-or-decoy verify with exactly ONE derivation per call, reset-on-success /
// record-on-failure against the caller's OWN actor) — this is not a second, weaker PIN
// check with its own oracle.
//
// On success this does NOT mint a new session (never calls jwt.signToken, never touches
// req.authCtx's session): it returns a SEPARATE, narrowly-scoped, short-lived signed proof
// (jwt.signStepUpProof) that setActorPin must present and verify. That proof is
// cryptographically bound to the CURRENT session via jwt.hashBearerToken/verifyStepUpProof,
// so a proof minted in one session can never be replayed from a different session, even for
// the same actor at the same session_version.
//
// deps: { dao, jwt, pinPolicy, verifyPin, decoyHashPromise, ipHash }
//   dao: { getLockState, getActorForVerify_SENSITIVE, recordFailedAttempt, resetFailedAttempts }

const FAIL_CRED = Object.freeze({ ok: false, code: 'cred' });
const FAIL_BAD = Object.freeze({ ok: false, code: 'bad' });
const FAIL_UNAVAIL = Object.freeze({ ok: false, code: 'unavail' });
const failBlocked = (retryAfterSec) => Object.freeze({ ok: false, code: 'blocked', retryAfterSec });

function createPinStepUpVerifier(deps = {}) {
  const { dao, jwt, pinPolicy, verifyPin, decoyHashPromise } = deps;

  // verifyOwnPin({actor, role, sv, pin, bearerToken})
  //   actor/role/sv — from the ALREADY-VERIFIED req.authCtx. NEVER accept these from the
  //                   request body: the whole point is that the proof describes who the
  //                   server already knows the caller to be, not who the caller claims.
  //   bearerToken   — the raw current Bearer, used only to derive the session binding.
  //                   Never logged, never returned, never persisted.
  // Returns { ok:true, stepUpProof, expiresInSec } or { ok:false, code, retryAfterSec? }.
  async function verifyOwnPin({ actor, role, sv, pin, bearerToken } = {}) {
    try {
      if (role !== 'admin') return FAIL_BAD;                    // only admin/owner manages PINs
      if (typeof actor !== 'string' || actor.length === 0) return FAIL_BAD;
      if (!Number.isInteger(sv) || sv < 1) return FAIL_BAD;
      if (typeof pin !== 'string' || pin.length === 0) return FAIL_BAD;
      if (typeof bearerToken !== 'string' || bearerToken.length === 0) return FAIL_BAD;
      if (!dao || !jwt || !pinPolicy || typeof verifyPin !== 'function') return FAIL_UNAVAIL;
      // Generic format rejection — indistinguishable from a wrong PIN, no length/shape oracle.
      if (!pinPolicy.validatePinFormat(pin, role).ok) return FAIL_CRED;

      // 1) lock pre-check (optimization only; the RPC behind recordFailedAttempt is authoritative)
      try {
        const ls = await dao.getLockState(actor);
        if (ls && ls.locked) return failBlocked(ls.retryAfterSec);
      } catch (_) { /* NOT_FOUND / transient -> fall through to the decoy path */ }

      // 2) sensitive read + real-or-decoy verify — EXACTLY one derivation, same as login.js
      let row = null;
      try { row = await dao.getActorForVerify_SENSITIVE(actor); } catch (_) { row = null; }
      const hasReal = !!(row && row.active && row.pin_hash);
      const stored = hasReal ? row.pin_hash : await decoyHashPromise;

      let ok = false;
      try { ok = await verifyPin(pin, stored); } catch (_) { ok = false; }

      // 3) SUCCESS — only against a REAL, active hash
      if (ok && hasReal) {
        let reset;
        try { reset = await dao.resetFailedAttempts(actor); } catch (_) { return FAIL_UNAVAIL; }
        if (!reset || reset.active !== true) return FAIL_CRED;  // disabled mid-flow -> no proof
        // auth_reset_failed_attempts only clears failed_count/locked_until — it never mutates
        // session_version. This check catches a rotation that landed between the guard's
        // DB-fresh read (req.authCtx.sv) and this call, not a race with that read itself.
        if (!Number.isInteger(reset.session_version) || reset.session_version !== sv) return FAIL_CRED;

        const sessionHash = jwt.hashBearerToken(bearerToken);
        if (!sessionHash) return FAIL_UNAVAIL;
        const stepUpProof = jwt.signStepUpProof({ actor, role, sv, sessionHash });
        if (!stepUpProof) return FAIL_UNAVAIL;
        return Object.freeze({ ok: true, stepUpProof, expiresInSec: jwt.STEP_UP_TTL_SECONDS });
      }

      // 4) FAILURE — increments exactly the caller's own actor (authoritative RPC)
      let rec = null;
      try { rec = await dao.recordFailedAttempt(actor); } catch (_) { rec = null; }
      if (rec && rec.locked) return failBlocked(rec.retry_after_sec);
      return FAIL_CRED;
    } catch (_) {
      return FAIL_UNAVAIL;
    }
  }

  return { verifyOwnPin };
}

module.exports = { createPinStepUpVerifier };
