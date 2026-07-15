'use strict';
// Access Control V2 — Block B5: bootstrap/recovery ORCHESTRATION service (UNWIRED).
// Emergency admin access via a short-lived, one-shot, server-side window. NOT a
// human-JWT flow and NOT a B4 router action — backend-direct only. This module
// exposes NO Express route and is NOT called from index.js. All dependencies are
// injected for offline testing. External result is ALWAYS generic on failure —
// it never reveals which check failed (no window/secret/api-key/actor oracle).
//
// Required credentials (both), backend-direct only:
//   * X-Api-Key                 (existing DASHBOARD_API_KEY contract)
//   * X-Auth-Bootstrap-Secret   (bootstrap)  |  X-Auth-Recovery-Secret (recovery)
// A Bearer JWT is neither required nor accepted here.

const rw = require('./recoveryWindow');

const GENERIC_FAIL = Object.freeze({ ok: false, error: 'auth_failed' });

// deps: { env, now, dao, hashPin, ipHash, pinPolicy, logger }
//   dao        : { registerRecoveryWindow, consumeRecoveryWindow }
//   hashPin    : async (pin) => scryptHash            (B1)
//   ipHash     : (ip) => hash|null                    (B3 ipSecurity)
//   pinPolicy  : { validatePinFormat(pin, role) }     (B3 shared policy)
function createBootstrapRecoveryService(deps = {}) {
  const { env = process.env, now = Date.now, dao, hashPin, ipHash, pinPolicy } = deps;

  // req: { purpose, headers, newPin, trustedClientIp }
  async function execute(req = {}) {
    try {
      const purpose = req.purpose;
      if (purpose !== 'bootstrap' && purpose !== 'recovery') return GENERIC_FAIL;

      const headers = req.headers || {};

      // 1) backend-direct X-Api-Key (constant-time; fail-closed if unconfigured)
      const apiKey = rw.singleHeaderValue(headers[rw.HEADERS.apiKey]);
      if (!rw.validateApiKey(apiKey, env)) return GENERIC_FAIL;

      // 2) load + validate the env window descriptor (fail-closed on any defect)
      const loaded = rw.loadWindowDescriptor({ purpose, env, now });
      if (!loaded.ok) return GENERIC_FAIL;
      const descriptor = loaded.descriptor;

      // 3) dedicated purpose-specific secret header (name differs per purpose →
      //    a bootstrap secret cannot open recovery, and vice-versa)
      const secretHeaderName = rw.HEADERS[purpose];
      const presentedSecret = rw.singleHeaderValue(headers[secretHeaderName]);
      if (!presentedSecret) return GENERIC_FAIL;
      if (!rw.verifyPresentedSecret(presentedSecret, descriptor)) return GENERIC_FAIL;

      // 4) validate the new PIN against the admin policy BEFORE expensive hashing.
      //    Role is 'admin' (the flow targets the admin actor; the SQL RPC also
      //    enforces stored role = admin).
      const newPin = req.newPin;
      if (typeof newPin !== 'string' || newPin.length === 0) return GENERIC_FAIL;
      if (!pinPolicy.validatePinFormat(newPin, 'admin').ok) return GENERIC_FAIL;

      // 5) hash (B1 scrypt). Never store/return/log plaintext.
      let newHash;
      try { newHash = await hashPin(newPin); } catch (_) { return GENERIC_FAIL; }
      if (typeof newHash !== 'string' || newHash.slice(0, 7) !== 'scrypt$') return GENERIC_FAIL;

      const ipH = ipHash ? ipHash(req.trustedClientIp) : null;

      // 6) register the immutable descriptor idempotently (server enforces the
      //    15-min ceiling / no-reopen). A consumed window stays consumed.
      try {
        await dao.registerRecoveryWindow({
          windowId: descriptor.windowId,
          purpose,
          actor: descriptor.actor,
          secretDigest: descriptor.secretDigest,
          expiresAt: descriptor.expiresAt,
          meta: {},
        });
      } catch (_) { return GENERIC_FAIL; }

      // 7) atomic consume: window one-shot + admin PIN replacement + audit (1 tx).
      let result;
      try {
        result = await dao.consumeRecoveryWindow({
          windowId: descriptor.windowId,
          purpose,
          actor: descriptor.actor,
          secretDigest: descriptor.secretDigest,
          newHash,
          ipHash: ipH,
          meta: {},
        });
      } catch (_) { return GENERIC_FAIL; }

      if (!result || result.consumed !== true) return GENERIC_FAIL;

      // 8) sanitized success — no secret, no hash, no PIN.
      return Object.freeze({ ok: true, purpose, actor: descriptor.actor });
    } catch (_) {
      return GENERIC_FAIL; // any unexpected error → generic, no leak
    }
  }

  return { execute };
}

module.exports = { createBootstrapRecoveryService, GENERIC_FAIL };
