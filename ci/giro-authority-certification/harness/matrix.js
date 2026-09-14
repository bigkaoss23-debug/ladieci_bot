'use strict';
// W3 contract matrix (sections 10-30 of the W3 brief). Each entry is proven by the
// named harness assertions its patterns match. run.js fails if any entry has no
// passing assertion, if any matched assertion failed, or if any pattern matches
// nothing (a renamed assertion can never silently drop a proof).

const re = (s) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const any = (...xs) => xs.map((x) => (x instanceof RegExp ? x : re(x)));

module.exports = {
  'W3-N01': { title: 'create giro with two members', match: any('create {A,B} -> OK', 'giro id keeps the legacy format', 'hora_ref normalized 9:05', 'PLANNED with both members effective') },
  'W3-N02': { title: 'attach a third member', match: any('attach C to G1 -> OK', 'attach D to G1 -> OK', 'attach C to G1 again -> IDEMPOTENT') },
  'W3-N03': { title: 'an order is never in two giros', match: any('attach C (effective in G1) to G2 -> ORDER_ALREADY_IN_GIRO', 'same order to two giros: second', 'two creates sharing an order', 'N03: exactly one membership row') },
  'W3-N04': { title: 'no implicit move', match: any('create with a member of an effective giro -> ORDER_ALREADY_IN_GIRO (never an implicit move)', '...and A is still in G1', 'A (only in dissolved G1) is free') },
  'W3-N05': { title: 'explicit move', match: any('explicit move C: G1 -> G2 -> OK', 'move again to the same giro -> IDEMPOTENT', 'move of an order in no giro -> ORDER_NOT_IN_GIRO') },
  'W3-N06': { title: 'explicit dissolve with audit', match: any('dissolve G2 -> OK', 'explicit dissolve records dissolved_at/dissolved_by (audit)', 'dissolve G2 again -> IDEMPOTENT', 'explicit dissolve -> DISSOLVED/EXPLICIT with audit fields') },
  'W3-N07': { title: '<2 effective members -> DISSOLVED, no write', match: any('detach B -> G1 has one member -> DISSOLVED (derived, no write)', 'derived dissolution never writes dissolved_at', 'N07 cancel: 2-member giro', 'N07 EC-F2 delete: down to 1 -> DISSOLVED', 'attach to a derived-DISSOLVED giro -> GIRO_NOT_PLANNED') },
  'W3-N08': { title: 'hora_ref precedence', match: any('hora_ref 21:10 prevails over forno 21:18', 'set hora_ref 21:10 -> OK, salida 21:10 OPERATOR') },
  'W3-N09': { title: 'max forno_out', match: any('hora_ref cleared -> salida 21:18 PROXY_MAX_FORNO', 'clear hora_ref -> OK, salida falls back to PROXY_MAX_FORNO', 'N07 EC-F2 delete: salida recomputed from the survivors') },
  'W3-N10': { title: 'salida NONE', match: any('salida NONE when no hora_ref and no valid forno_out', 'a DISSOLVED giro never carries a salida (NONE)') },
  'W3-N11': { title: 'after midnight / service day', match: any('N09: giro of Business Day', 'N09: salida is the service-day max', 'N09: business_date stays') },
  'W3-N12': { title: 'out-of-scope member', match: any('out-of-scope member: scope {s2}', 'out-of-scope member: the order of the other session', 'out-of-scope member: scope {s}', 'create with OUT_OF_SCOPE -> ORDER_NOT_ELIGIBLE/OUT_OF_SCOPE') },
  'W3-N13': { title: 'valid capture -> PENDING', match: any('GIRO intent -> PENDING', 'ANCHOR intent -> PENDING', 'GIRO intent: RETURNING shows pending_giro_intent NULL', 'GIRO intent: stored row has pending_giro_intent NULL') },
  'W3-N14': { title: 'malformed -> REJECTED', match: [/-> order created, input NULL, REJECTED CAPTURE_/, ...any('malformed input persists no target', 'fault inside capture -> order created, REJECTED CAPTURE_INTERNAL')] },
  'W3-N15': { title: 'consume ANCHOR', match: any('Q2 ANCHOR Q5 -> CONSUMED GIRO_CREATED', 'the created giro records Q5 as anchor_order_uid') },
  'W3-N16': { title: 'consume GIRO', match: any('Q1 GIRO -> CONSUMED ATTACHED', 'N01-lite: exactly one giro {Q5,Q2,Q1}') },
  'W3-N17': { title: 'double consume idempotent (retry = same logical outcome)', match: any('N03: sequential retries replay the identical outcome', 'N12: the replay returns the same SCOPE_UNAVAILABLE outcome', 'resolved intent cannot go back to PENDING') },
  'W3-N18': { title: 'fingerprint changed -> TARGET_CHANGED', match: any('N04: stale GIRO target -> REJECTED TARGET_CHANGED', 'N04: anchor now in another giro -> REJECTED TARGET_CHANGED', 'N04: the other giro is untouched') },
  'W3-N19': { title: 'target gone', match: any('dissolved GIRO target -> REJECTED TARGET_GONE', 'cancelled anchor -> REJECTED TARGET_GONE') },
  'W3-N20': { title: 'order changed', match: any('order zona changed after capture -> REJECTED ORDER_CHANGED', 'order grouped elsewhere by the operator -> REJECTED ORDER_CHANGED') },
  'W3-N21': { title: 'order ineligible', match: any('cancelled order -> REJECTED ORDER_NOT_ELIGIBLE', 'hard-deleted order -> REJECTED ORDER_NOT_ELIGIBLE') },
  'W3-N22': { title: 'concurrent attach', match: any('concurrent attach of two different orders to one giro', 'same order to two giros: the second waits on the order lock', 'same order to two giros: second') },
  'W3-N23': { title: 'concurrent consume of the same intent', match: any('N03: 8 parallel consumes -> exactly one non-replay CONSUMED', 'N03: all 8 outcomes logically identical') },
  'W3-N24': { title: 'concurrent different orders, same target', match: any('two consumes into the same giro in parallel', 'two consumes on the same ANCHOR in parallel') },
  'W3-N25': { title: 'move vs attach race', match: any('move held: attach into the source giro waits', 'move-then-attach:', 'attach held: the move out of that giro waits', 'attach-then-move:', 'same order: move held', 'same order move vs attach:') },
  'W3-N26': { title: 'projection exposes no raw membership', match: any('payload never carries manual_giro_id', 'IN_TRIP effective members are exactly the snapshot members', 'N07 cancel: survivor E is single', 'out-of-scope member: the order of the other session has no effective giro') },
  'W3-N27': { title: 'private membership: direct access denied', match: [/^(anon|authenticated|service_role): (SELECT|INSERT|UPDATE|DELETE|TRUNCATE) giro_authority\.giro_members -> 42501$/] },
  'W3-N28': { title: 'private intents: direct access denied', match: [/^(anon|authenticated|service_role): (SELECT|INSERT|UPDATE|DELETE|TRUNCATE) giro_authority\.giro_intents -> 42501$/] },
  'W3-N29': { title: 'SECURITY DEFINER + fixed search_path', match: any('every Authority function is owned by postgres', 'every Authority function pins search_path', '8 public entry points, all SECURITY DEFINER', 'capture function is SECURITY DEFINER') },
  'W3-N30': { title: 'no economic / order writes', match: any('zero statements against ordenes', 'no new row version of any order', 'obligations / financial events / payments untouched', 'pre-existing public functions are byte-identical', 'capture never UPDATEs ordenes', 'no raw ordenes.manual_giro_id ever written') },

  'R-LOCKING': { title: 'giro row first, deterministic order, W4 start_rider_trip rule rehearsed', match: any('N06b: W4-order departure waits on the giro row held by attach', 'N06b reverse: attach waits on the giro row held by the departure', 'dissolve held: attach waits on the giro row', '10 rounds of crossed moves: zero deadlocks') },
  'R-CONSUME-CODES': { title: 'every consume code incl. SCOPE_UNAVAILABLE and TARGET_DEPARTED', match: any('N12: scope unavailable -> REJECTED SCOPE_UNAVAILABLE', 'N05: GIRO target departed', 'N05: ANCHOR departed', 'N12: DRIVER_STATO unreadable -> REJECTED UNVERIFIABLE', 'N08: consume outside the operational scope -> EXPIRED SERVICE_CLOSED') },
  'R-SCOPE': { title: 'scope is an input; Business Day, not calendar day', match: any('create with scope NULL -> SCOPE_UNAVAILABLE', 'N08: scope without the closed session', 'invalid scope -> scope_valid=false') },
  'R-DONE': { title: 'IN_TRIP/DONE derived from trip snapshot and closed facts', match: any('IN_TRIP after the real start_rider_trip', 'DONE after the stop is delivered and the real close_rider_trip closes', 'DONE is never returned as operative') },
  'R-SALIDA-NO-WRITE': { title: 'no salida_ref write', match: any('no salida_ref/plan_source/computed_at ever written') },
};
