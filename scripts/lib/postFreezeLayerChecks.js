'use strict';
// scripts/lib/postFreezeLayerChecks.js -- the exact catalog state of every OWN post-freeze layer (scripts/lib/postFreezeLayers.js).
// Each check is a read-only read() (safe inside or outside a transaction, on a database with or without the layer) and a pure classify():
//   ABSENT    nothing of the layer exists
//   APPLIED   every object exists with its certified definition (pinned fingerprints below)
//   DETACHED  (layers with a DETACH rollback) the retained part exists exactly, the attached part is gone
//   DRIFT     anything else -- every mutating command of the runner refuses it (fail closed)
// The pins are the fingerprints the certified forward file produces on PostgreSQL 17 (recorded in the lab, re-checked by the runner inside
// the apply transaction). A change of the forward file changes its sha256 AND these pins, in the same reviewed change.

const LAYER_CHECKS = Object.freeze({});

module.exports = { LAYER_CHECKS };
