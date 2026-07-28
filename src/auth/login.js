'use strict';
// Access Control V2 — Block B3: DB login → JWT v2. NOT wired (no index.js).
// Factory receiving explicit dependencies for testability. Never logs. Never
// leaks actor existence / PIN config / failed_count / DB detail / hash / other
// actor's lock. The compatibility handler performs one derivation; universal
// login performs one real-or-decoy derivation for every canonical actor slot.
// No needsRehash (B1 accepts only the current exact format).

const ROLE_ACTORS = Object.freeze({
  admin: 'owner',
  rider: 'rider',
  // operator resolved to an explicit actor from the request
});
const OPERATOR_ACTORS = Object.freeze(new Set(['operator_primary', 'operator_backup']));

// Generic external responses (no internal detail).
const ERR = Object.freeze({
  bad:     { status: 400, body: { error: 'solicitud inválida' } },
  cred:    { status: 401, body: { error: 'credenciales incorrectas' } },
  blocked: (retryAfterSec) => ({ status: 429, body: { error: 'temporalmente bloqueado', retryAfterSec } }),
  unavail: { status: 503, body: { error: 'servicio auth no disponible' } },
});

// deps: { dao, jwt, pinPolicy, verifyPin, decoyHashPromise, ipHash, ipLimiter, audit }
function createLoginHandler(deps) {
  const { dao, jwt, pinPolicy, verifyPin, decoyHashPromise, ipHash, ipLimiter, audit } = deps;
  const lockedAuditSeen = new Map(); // dedup 'locked' audit per (actor|locked_until)

  function resolveActor(role, actor) {
    if (role === 'admin' || role === 'rider') return ROLE_ACTORS[role];
    if (role === 'operator') return OPERATOR_ACTORS.has(actor) ? actor : null;
    return null;
  }

  async function bestEffortAudit(rec) {
    try { if (audit && audit.writeAuthAuditBestEffort) await audit.writeAuthAuditBestEffort(rec); }
    catch (_) { /* best-effort: never affects login outcome */ }
  }

  function auditLockedOnce(actor, lockedUntil, ipH) {
    const key = actor + '|' + String(lockedUntil);
    const t = Date.now();
    // prune stale keys
    for (const [k, ts] of lockedAuditSeen) if (t - ts > 15 * 60 * 1000) lockedAuditSeen.delete(k);
    if (lockedAuditSeen.has(key)) return false;
    lockedAuditSeen.set(key, t);
    return true;
  }

  return async function login(req = {}) {
    const { role, pin, actor: reqActor, trustedClientIp } = req;

    // 1) shape + actor resolution
    if (role !== 'admin' && role !== 'operator' && role !== 'rider') return ERR.bad;
    if (typeof pin !== 'string' || pin.length === 0) return ERR.bad;
    const actor = resolveActor(role, reqActor);
    if (!actor) return ERR.bad; // e.g. operator without valid actor

    // 2) PIN format policy (shared). Generic failure — no DB touch, no oracle.
    if (!pinPolicy.validatePinFormat(pin, role).ok) return ERR.cred;

    // 3) JWT readiness (fail-closed)
    if (!jwt.isReady()) return ERR.unavail;

    // 4) IP hash + secondary limiter (never primary)
    const ipH = ipHash ? ipHash(trustedClientIp) : null;
    if (ipLimiter) {
      const c = ipLimiter.check(ipH);
      if (c.blocked) return ERR.blocked(c.retryAfterSec);
    }

    // 5) lock pre-check (optimization; RPC remains authoritative)
    try {
      const ls = await dao.getLockState(actor);
      if (ls && ls.locked) {
        if (auditLockedOnce(actor, ls.locked_until, ipH)) {
          await bestEffortAudit({ event: 'locked', targetActor: actor, ipHash: ipH, meta: { role } });
        }
        return ERR.blocked(ls.retryAfterSec);
      }
    } catch (_) { /* NOT_FOUND / transient → fall through to decoy path */ }

    // 6) load sensitive + choose real-or-decoy hash (exactly one derivation)
    let row = null;
    try { row = await dao.getActorForVerify_SENSITIVE(actor); } catch (_) { row = null; }
    const hasReal = !!(row && row.active && row.pin_hash);
    const stored = hasReal ? row.pin_hash : await decoyHashPromise;

    let ok = false;
    try { ok = await verifyPin(pin, stored); } catch (_) { ok = false; }

    // 7) SUCCESS (only if verified against a REAL, active hash)
    if (ok && hasReal) {
      let reset;
      try { reset = await dao.resetFailedAttempts(actor); }
      catch (_) { return ERR.unavail; }
      if (!reset || reset.active === false) return ERR.cred; // disabled mid-flow → no token
      // S2-7D4C — this is the explicit role/actor path: record it as `actor_pin`.
      const token = jwt.signToken({ role, sub: actor, sv: reset.session_version, authMethod: jwt.AUTH_METHOD_ACTOR_PIN });
      if (!token) return ERR.unavail;
      if (ipLimiter) ipLimiter.reset(ipH);
      await bestEffortAudit({ event: 'login_ok', targetActor: actor, ipHash: ipH, meta: { role } });
      return { status: 200, body: { token, role, actor, expiresIn: jwt.expiresInFor(role), tokenVersion: 2 } };
    }

    // 8) FAILURE — increment exactly the selected actor (authoritative RPC)
    if (ipLimiter) ipLimiter.recordFailure(ipH);
    let rec = null;
    try { rec = await dao.recordFailedAttempt(actor); } catch (_) { rec = null; }
    const nowLocked = !!(rec && rec.locked);
    if (nowLocked) {
      if (auditLockedOnce(actor, rec.locked_until, ipH)) {
        await bestEffortAudit({ event: 'locked', targetActor: actor, ipHash: ipH, meta: { role } });
      }
      return ERR.blocked(rec.retry_after_sec);
    }
    await bestEffortAudit({ event: 'login_fail', targetActor: actor, ipHash: ipH, meta: { role } });
    return ERR.cred;
  };
}

function createUniversalLoginHandler(deps) {
  const { dao, jwt, pinPolicy, verifyPin, decoyHashPromise, ipHash, ipLimiter, audit } = deps;
  const actorOrder = Object.freeze(['owner', 'operator_primary', 'operator_backup', 'rider']);
  const roleForActor = Object.freeze({ owner: 'admin', operator_primary: 'operator', operator_backup: 'operator', rider: 'rider' });
  async function bestEffortAudit(rec) {
    try { if (audit && audit.writeAuthAuditBestEffort) await audit.writeAuthAuditBestEffort(rec); }
    catch (_) { /* audit never changes the login result */ }
  }
  return async function universalLogin(req = {}) {
    const { pin, trustedClientIp } = req;
    if (!pinPolicy.validateUniversalPinFormat(pin).ok) return ERR.cred;
    if (!jwt.isReady()) return ERR.unavail;
    const ipH = ipHash ? ipHash(trustedClientIp) : null;
    if (ipLimiter) { const c = ipLimiter.check(ipH); if (c.blocked) return ERR.blocked(c.retryAfterSec); }
    let rows = [];
    try { rows = await dao.listActorsForVerify_SENSITIVE(); } catch (_) { rows = []; }
    const byActor = new Map(rows.map((row) => [row.actor, row]));
    const checks = await Promise.all(actorOrder.map(async (actor) => {
      const row = byActor.get(actor);
      const usable = !!(row && row.active && row.pin_hash && roleForActor[actor] === row.role);
      const stored = usable ? row.pin_hash : await decoyHashPromise;
      let matched = false;
      try { matched = await verifyPin(pin, stored); } catch (_) { /* treated as mismatch */ }
      return usable && matched ? row : null;
    }));
    const matches = checks.filter(Boolean);
    if (matches.length !== 1) {
      if (ipLimiter) ipLimiter.recordFailure(ipH);
      await bestEffortAudit({ event: 'login_fail', targetActor: null, ipHash: ipH, meta: { universal: true } });
      return ERR.cred;
    }
    const row = matches[0];
    const actor = row.actor;
    const role = roleForActor[actor];
    try {
      const ls = await dao.getLockState(actor);
      if (ls && ls.locked) return ERR.blocked(ls.retryAfterSec);
    } catch (_) { return ERR.cred; }
    let reset;
    try { reset = await dao.resetFailedAttempts(actor); } catch (_) { return ERR.unavail; }
    if (!reset || reset.active === false) return ERR.cred;
    // S2-7D4C — this is the {pin}-only universal path: record it as `legacy_universal`.
    const token = jwt.signToken({ role, sub: actor, sv: reset.session_version, authMethod: jwt.AUTH_METHOD_LEGACY_UNIVERSAL });
    if (!token) return ERR.unavail;
    if (ipLimiter) ipLimiter.reset(ipH);
    await bestEffortAudit({ event: 'login_ok', targetActor: actor, ipHash: ipH, meta: { role, universal: true } });
    return { status: 200, body: { token, role, actor, expiresIn: jwt.expiresInFor(role), tokenVersion: 2 } };
  };
}

module.exports = { createLoginHandler, createUniversalLoginHandler, ROLE_ACTORS, OPERATOR_ACTORS };
