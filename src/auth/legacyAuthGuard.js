// legacyAuthGuard.js — backend-authoritative authorization for the legacy /api dispatcher.
//
// S2-1B. The shared X-Api-Key check remains an infrastructure layer (already applied by
// index.js before this guard). This guard adds, for every legacy action:
//   1. Bearer JWT present + valid signature (reuse src/auth/jwt.verifyToken)
//   2. actor exists (reuse src/auth/dao.getActor)
//   3. actor active
//   4. token sv === current session_version  (freshness)
//   5. action is known (canonical map)        else 404
//   6. actor role is allowed for the action    else 403
// Only after success does index.js enter the action dispatcher.
//
// No cryptographic or session logic is duplicated here — jwt/dao are the B7 sources.
// Never throws to the client; on any internal failure returns a generic 500.

"use strict";

const jwt = require("./jwt");
const dao = require("./dao");
const { getActionRule } = require("./legacyActionRoles");

// Extract the action string for a legacy request.
// GET  -> req.query.action
// POST -> req.query.action || req.body.action
// The special REST route /api/delivery/shadow-preview -> "shadowPreview".
function extractAction(req) {
  // When mounted via app.use("/api", ...) Express strips the "/api" prefix from req.path,
  // so match both the mounted-relative and the full form (and originalUrl as a fallback).
  const p = (req && (req.path || "")) || "";
  const ou = (req && (req.originalUrl || "")) || "";
  if (p === "/api/delivery/shadow-preview" || p === "/delivery/shadow-preview" ||
      ou.split("?")[0].endsWith("/api/delivery/shadow-preview")) {
    return "shadowPreview";
  }
  const q = (req && req.query) || {};
  const b = (req && req.body) || {};
  if (req && req.method === "GET") return q.action;
  return q.action || b.action;
}

function bearerFrom(req) {
  const h = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t.length ? t : null;
}

// authorizeLegacyRequest(req, deps?) -> { ok:true, ctx:{actor,role,sv,action,rule} }
//                                     | { ok:false, status, code }
// deps allows offline tests to inject verifyToken/getActor. Defaults to B7 modules.
async function authorizeLegacyRequest(req, deps = {}) {
  const verifyToken = deps.verifyToken || jwt.verifyToken;
  const getActor = deps.getActor || dao.getActor;

  const action = extractAction(req);

  // Unknown action -> 404 (deny by default), evaluated before role logic.
  const rule = getActionRule(action);
  if (!rule) return { ok: false, status: 404, code: "UNKNOWN_ACTION" };

  // Bearer JWT
  const token = bearerFrom(req);
  if (!token) return { ok: false, status: 401, code: "MISSING_TOKEN" };

  const payload = verifyToken(token);
  if (!payload) return { ok: false, status: 401, code: "INVALID_TOKEN" };

  // Actor state + freshness (DB-verified, B7-consistent).
  let actorRow;
  try {
    actorRow = await getActor(payload.sub);
  } catch (_) {
    return { ok: false, status: 500, code: "AUTH_BACKEND_ERROR" };
  }
  if (!actorRow || actorRow.active !== true) {
    return { ok: false, status: 401, code: "INACTIVE_OR_UNKNOWN_ACTOR" };
  }
  if (actorRow.session_version !== payload.sv) {
    return { ok: false, status: 401, code: "SESSION_STALE" };
  }

  // Role authorization
  if (!rule.roles.has(payload.role)) {
    return { ok: false, status: 403, code: "ROLE_FORBIDDEN" };
  }

  return {
    ok: true,
    // S2-7D6E4 — sid is the per-login id from a fresh token, or null for a session signed
    // before this change (jwt.verifyToken tolerates its absence for ordinary actions).
    // Never logged; PIN-management step-up refuses to work without it (see pinStepUp.js).
    // S2-7D4C — authMethod is the server-derived login method (`am` claim), or null for a
    // pre-change token with none; step-up selects its PIN-format validator from it and refuses
    // a null one with REAUTH_REQUIRED (see pinStepUp.js). Never accepted from the body.
    ctx: {
      actor: payload.sub, role: payload.role, sv: payload.sv,
      sid: payload.sid || null, authMethod: payload.am || null, action, rule,
    },
  };
}

// Express middleware factory. Mount AFTER the X-Api-Key check and BEFORE the dispatcher.
// Attaches req.authCtx on success. Deny responses are normalized JSON, no internals leaked.
function legacyAuthGuardMiddleware(deps = {}) {
  return async function (req, res, next) {
    let decision;
    try {
      decision = await authorizeLegacyRequest(req, deps);
    } catch (_) {
      return res.status(500).json({ error: "internal_error" });
    }
    if (!decision.ok) {
      return res.status(decision.status).json({ error: decision.code });
    }
    req.authCtx = decision.ctx;
    return next();
  };
}

module.exports = { authorizeLegacyRequest, legacyAuthGuardMiddleware, extractAction };
