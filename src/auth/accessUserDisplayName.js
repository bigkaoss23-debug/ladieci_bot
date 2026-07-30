'use strict';
// Access Control V3 -- Block V3-D: display-name normalization contract (FOUNDATION ONLY,
// UNWIRED). Pure logic, no env, no I/O, no DB.
//
// Display names are presentation data only -- never a security identity. They may be
// changed, need not be unique, and may be shared by two staff members. This module is
// the ONE canonical definition of the bound and the normalization rule; the V3-D
// migration's auth_actors_display_name_chk CHECK constraint MUST be kept numerically in
// sync with MAX_DISPLAY_NAME_LENGTH below (SQL and Node cannot literally share a source
// constant across languages, so "one shared contract" means: this file is the value's
// canonical home, and the migration comments say so explicitly).
//
// Rules: trim surrounding whitespace; reject empty-after-trim; reject C0/DEL control
// characters; bound the length; otherwise accept anything -- including full Unicode
// (accents, letters like enye/u-diaeresis, non-Latin scripts) so ordinary human names
// are never rejected.

const MAX_DISPLAY_NAME_LENGTH = 120; // keep numerically in sync with the SQL CHECK

// C0 controls (code points 0-31) and DEL (code point 127). Nothing else is restricted.
const CONTROL_CHAR_RE = new RegExp('[\\x00-\\x1F\\x7F]');

// normalizeDisplayName(raw) -> trimmed string | null (null = invalid, caller must reject)
function normalizeDisplayName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

module.exports = { MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName };
