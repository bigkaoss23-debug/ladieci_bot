'use strict';
// Mounts /api/economy/v1, mirroring mesaHttpIntegration.js.
//
// Deliberately NOT behind an enablement flag. The Mesa router carries one
// because it fronts twelve WRITE routes into a then-new subsystem. This router
// is two reads and one append-only insert into a table of its own, every route
// authenticated and role-gated, and none of it can touch the service
// lifecycle — there is nothing here a flag would protect, and an unset flag
// would only produce a 404 that looks exactly like a broken deploy.

const express = require('express');
const { registerEconomyRoutes } = require('./economyHttpHandlers');

const PREFIX = '/api/economy/v1';

function integrateEconomyRoutes(app, { logger = console, ...deps } = {}) {
  if (!app || typeof app.use !== 'function') throw new TypeError('Express app required');
  const router = express.Router();
  const registered = registerEconomyRoutes(router, { logger, ...deps });
  app.use(PREFIX, router);
  return Object.freeze({ enabled: true, prefix: PREFIX, routes: registered.routes });
}

module.exports = { PREFIX, integrateEconomyRoutes };
