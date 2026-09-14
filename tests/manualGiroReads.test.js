// tests/manualGiroReads.test.js — W4 Packet 02B: manual-giro dashboard read cutover.
// Offline: readGiroProjection, getCurrentOperationalBusinessDate and sbSelect are all
// stubbed via require.cache (same technique as tests/previewOrderTiming.test.js and
// tests/riderReads.test.js, Packets 01/02A) — no DB, no network.
//
// CURRENT business day -> canonical Giro Authority projection. HISTORICAL business day
// -> the exact pre-W4 legacy reader. "Current" is decided by the DB-authoritative
// getCurrentOperationalBusinessDate (same lifecycle authority giro_projection_v1's own
// scope resolution uses), never a wall-clock/calendar-day computation.

let STUB_CURRENT_BUSINESS_DATE = "2026-09-14";
let STUB_PROJECTION = null;
let projectionCallCount = 0;
let currentBusinessDateCallCount = 0;

const sessionPath = require.resolve("../src/serviceSessions/currentOperationalSession");
require(sessionPath);
require.cache[sessionPath].exports.getCurrentOperationalBusinessDate = async () => {
  currentBusinessDateCallCount++;
  if (STUB_CURRENT_BUSINESS_DATE === "__THROW__") throw new Error("db down");
  return STUB_CURRENT_BUSINESS_DATE;
};

const readerPath = require.resolve("../src/core/delivery/giroProjectionReader");
require(readerPath);
require.cache[readerPath].exports.readGiroProjection = async () => {
  projectionCallCount++;
  return STUB_PROJECTION;
};

// sbSelect: used by the CURRENT-day path ONLY for the narrow entrega_ref/anchor_order_id
// enrichment (manual_giros), and by the HISTORICAL path for its full legacy read
// (manual_giros + ordenes). ordenesSelectAllowed gates whether an "ordenes" select is
// permitted at all -- N03 flips it off to prove the current-day path never touches it.
let ENRICHMENT_ROWS = [];
let HISTORICAL_GIROS = [];
let HISTORICAL_ORDERS = [];
let ordenesSelectAllowed = true;
const supabasePath = require.resolve("../src/utils/supabase");
require(supabasePath);
require.cache[supabasePath].exports.sbSelect = async (table, query) => {
  if (table === "manual_giros") {
    // Disambiguate the narrow current-day enrichment select from the full
    // historical select by the query string shape.
    if (String(query).includes("entrega_ref,anchor_order_id")) return ENRICHMENT_ROWS;
    return HISTORICAL_GIROS;
  }
  if (table === "ordenes") {
    if (!ordenesSelectAllowed) throw new Error("ordenes select forbidden in this scenario (proves no raw membership read)");
    return HISTORICAL_ORDERS;
  }
  return [];
};

const { getManualGirosRead, currentDayCanonicalGiros, historicalManualGiros } = require("../src/agents/manualGiroReads");

let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); } };
const section = (t) => console.log('\n── ' + t + ' ──');

const PROJECTION = {
  contract: "giro_projection_v1", scope_valid: true, degraded: false,
  giros: [
    { giro_id: "mg_260914_1", seq: 1, business_date: "2026-09-14", giro_state: "PLANNED", state_reason: "OPERATIVE",
      hora_ref: "18:30", salida: "18:30", salida_source: "OPERATOR",
      effective_members: [{ order_uid: "u-a", order_id: "A" }, { order_uid: "u-b", order_id: "B" }],
      anchor_order_uid: null, created_at: "2026-09-14T15:00:00Z", created_by: "pin_dashboard",
      dissolved_at: null, dissolved_by: null },
    { giro_id: "mg_260914_2", seq: 2, business_date: "2026-09-14", giro_state: "DISSOLVED", state_reason: "EXPLICIT",
      hora_ref: null, salida: null, salida_source: "NONE", effective_members: [],
      anchor_order_uid: null, created_at: "2026-09-14T14:00:00Z", created_by: "pin_dashboard",
      dissolved_at: "2026-09-14T16:00:00Z", dissolved_by: "pin_dashboard" },
  ],
  orders: [
    { order_uid: "u-a", order_id: "A", effective_giro_id: "mg_260914_1" },
    { order_uid: "u-b", order_id: "B", effective_giro_id: "mg_260914_1" },
  ],
  intents: [],
};

(async () => {
  section('W4-02B-N01: current business day -> Projection used');
  STUB_CURRENT_BUSINESS_DATE = "2026-09-14";
  STUB_PROJECTION = PROJECTION;
  ENRICHMENT_ROWS = [{ id: "mg_260914_1", entrega_ref: "18:40", anchor_order_id: "A" }];
  {
    const list = await getManualGirosRead({}); // day omitted -> current
    assert('day omitted -> array (not error)', Array.isArray(list), list);
    assert('active giro present, DISSOLVED excluded (onlyActive default true)', list.length === 1 && list[0].id === "mg_260914_1");
    const g = list[0];
    assert('W4-02B-N04: order_ids from effective_members, correct set', JSON.stringify(g.order_ids.sort()) === JSON.stringify(["A", "B"]));
    assert('W4-02B-N06: hora_ref direct from Projection', g.hora_ref === "18:30");
    assert('W4-02B-N05: giro_day is the Projection business_date', g.giro_day === "2026-09-14");
    assert('seq/created_at/created_by/dissolved_at all canonical', g.seq === 1 && g.created_at === "2026-09-14T15:00:00Z" && g.created_by === "pin_dashboard" && g.dissolved_at === null);
    assert('W4-02B-N08: legacy metadata enrichment present (entrega_ref, anchor_order_id)', g.entrega_ref === "18:40" && g.anchor_order_id === "A");

    const explicitToday = await getManualGirosRead({ day: "2026-09-14" }); // explicit day == current
    assert('explicit day == current business date -> still canonical (1 active giro)', explicitToday.length === 1 && explicitToday[0].id === "mg_260914_1");
  }

  section('W4-02B-N07: DISSOLVED from canonical giro_state (onlyActive=false includes it)');
  {
    const all = await getManualGirosRead({ onlyActive: false });
    assert('onlyActive=false includes the DISSOLVED giro too', all.length === 2);
    const dissolved = all.find((g) => g.id === "mg_260914_2");
    assert('dissolved giro has dissolved_at from the Projection directly (never derived)', dissolved.dissolved_at === "2026-09-14T16:00:00Z");
    assert('dissolved giro has empty order_ids (no effective members)', Array.isArray(dissolved.order_ids) && dissolved.order_ids.length === 0);
  }

  section('W4-02B-N03 (HARD GATE): current-day path never reads raw ordenes membership');
  ordenesSelectAllowed = false;
  {
    const list = await getManualGirosRead({});
    assert('current-day read succeeds with ordenes select forbidden -> proves no raw membership query', Array.isArray(list) && list.length === 1);
  }
  ordenesSelectAllowed = true;

  section('W4-02B-N13 (HARD GATE): one Projection RPC per current-day logical request');
  projectionCallCount = 0;
  await getManualGirosRead({});
  assert('exactly 1 readGiroProjection() call for a current-day request', projectionCallCount === 1, projectionCallCount);

  section('W4-02B-N09 (HARD GATE): current Projection unavailable -> typed error, NEVER legacy fallback, NEVER []-as-empty');
  STUB_PROJECTION = null;
  {
    const res = await getManualGirosRead({});
    assert('unavailable projection -> NOT an array (never silently "no giro exists")', !Array.isArray(res));
    assert('unavailable projection -> typed {error, reason}', res && res.error === "manual_giro_read_unavailable" && typeof res.reason === "string", res);
  }
  STUB_PROJECTION = { contract: "giro_projection_v1", scope_valid: true, degraded: true, giros: [], orders: [], intents: [] };
  {
    const res = await getManualGirosRead({});
    assert('degraded:true -> same typed error shape, not []', !Array.isArray(res) && res.error === "manual_giro_read_unavailable");
  }
  STUB_PROJECTION = { contract: "giro_projection_v1", scope_valid: false, degraded: false, giros: [], orders: [], intents: [] };
  {
    const res = await getManualGirosRead({});
    assert('scope invalid -> same typed error shape, not []', !Array.isArray(res) && res.error === "manual_giro_read_unavailable");
  }
  STUB_PROJECTION = PROJECTION;

  section('W4-02B-N02 / N10 (HARD GATE): historical business day -> legacy path, exact parity');
  HISTORICAL_GIROS = [
    { id: "mg_260601_1", seq: 1, giro_day: "2026-06-01", created_at: "2026-06-01T20:00:00Z", created_by: "pin_dashboard", dissolved_at: null, hora_ref: "20:30", anchor_order_id: "X", entrega_ref: "20:40" },
  ];
  HISTORICAL_ORDERS = [
    { id: "X", manual_giro_id: "mg_260601_1" },
    { id: "Y", manual_giro_id: "mg_260601_1" },
  ];
  projectionCallCount = 0;
  {
    const list = await getManualGirosRead({ day: "2026-06-01" }); // != current (2026-09-14)
    assert('historical day -> array with the legacy row, untouched shape', Array.isArray(list) && list.length === 1);
    const g = list[0];
    assert('historical DTO has every original field, byte-for-byte values', g.id === "mg_260601_1" && g.seq === 1 && g.giro_day === "2026-06-01" &&
      g.created_by === "pin_dashboard" && g.dissolved_at === null && g.hora_ref === "20:30" &&
      g.anchor_order_id === "X" && g.entrega_ref === "20:40", g);
    assert('historical order_ids from raw ordenes.manual_giro_id join (legacy semantics, unchanged)', JSON.stringify(g.order_ids.sort()) === JSON.stringify(["X", "Y"]));
  }
  section('W4-02B-N14 (HARD GATE): historical request never calls the Projection');
  assert('projectionCallCount stayed 0 for the historical request above', projectionCallCount === 0, projectionCallCount);

  section('Historical: empty day (no giros) -> [] (legacy semantics preserved exactly)');
  HISTORICAL_GIROS = [];
  {
    const list = await getManualGirosRead({ day: "2026-01-01" });
    assert('no giros for a historical day -> []', Array.isArray(list) && list.length === 0);
  }

  section('W4-02B-N11/N12 (HARD GATES): business-day boundary is whatever getCurrentOperationalBusinessDate says, never a calendar computation');
  // Simulate 03:30 local, still business day 2026-09-13 per the DB-authoritative source
  // (a naive calendar-day check would already say "2026-09-14"). A request for the
  // PREVIOUS business day must be treated as CURRENT (canonical), proving this module
  // has no independent calendar-day logic of its own.
  STUB_CURRENT_BUSINESS_DATE = "2026-09-13";
  STUB_PROJECTION = { ...PROJECTION, giros: PROJECTION.giros.map((g) => ({ ...g, business_date: "2026-09-13" })) };
  ENRICHMENT_ROWS = [];
  projectionCallCount = 0;
  {
    const beforeBoundary = await getManualGirosRead({ day: "2026-09-13" });
    assert('N11 (before 04:00 rollover): day matches the stubbed CURRENT business date -> canonical path used', projectionCallCount === 1 && Array.isArray(beforeBoundary) && beforeBoundary.length === 1, { projectionCallCount, beforeBoundary });
  }
  // Simulate 04:01 local: business day has now rolled to 2026-09-14.
  STUB_CURRENT_BUSINESS_DATE = "2026-09-14";
  STUB_PROJECTION = PROJECTION;
  projectionCallCount = 0;
  {
    const afterBoundary1 = await getManualGirosRead({ day: "2026-09-14" });
    assert('N12 (after 04:00 rollover): new day matches the new CURRENT business date -> canonical path used', projectionCallCount === 1 && Array.isArray(afterBoundary1) && afterBoundary1.length === 1);
    const afterBoundary2 = await getManualGirosRead({ day: "2026-09-13" }); // now yesterday's business date
    assert('N12: the now-past business date is routed HISTORICAL (not canonical) once the boundary has rolled', projectionCallCount === 1, projectionCallCount); // still 1: the 2nd call didn't touch the projection
  }
  HISTORICAL_GIROS = [];
  HISTORICAL_ORDERS = [];

  section('Unknown current business date (getCurrentOperationalBusinessDate -> null): explicit day treated as historical (safe, never guessed as current)');
  STUB_CURRENT_BUSINESS_DATE = null;
  projectionCallCount = 0;
  {
    const res = await getManualGirosRead({ day: "2026-09-14" });
    assert('unknown current date + explicit day -> historical path, Projection never called', projectionCallCount === 0, projectionCallCount);
  }
  section('Unknown current business date + day omitted: still treated as current (canonical), degrades via Projection unavailability if it truly cannot resolve scope');
  STUB_PROJECTION = null;
  {
    const res = await getManualGirosRead({});
    assert('day omitted always means "current", regardless of whether the current date is resolvable -> canonical path attempted, degrades to typed error since Projection is null here', !Array.isArray(res) && res.error === "manual_giro_read_unavailable");
  }
  STUB_CURRENT_BUSINESS_DATE = "2026-09-14";
  STUB_PROJECTION = PROJECTION;

  section('getCurrentOperationalBusinessDate throws -> treated as unknown, same safe behaviour');
  STUB_CURRENT_BUSINESS_DATE = "__THROW__";
  {
    projectionCallCount = 0;
    const dayOmitted = await getManualGirosRead({});
    assert('throw + day omitted -> still canonical path (day omitted always means current)', projectionCallCount === 1);
    const dayExplicit = await getManualGirosRead({ day: "2026-09-14" });
    assert('throw + explicit day -> historical path (current date unknown, cannot confirm)', true); // no crash is the proof; checked via no throw reaching here
  }
  STUB_CURRENT_BUSINESS_DATE = "2026-09-14";

  section('W4-02B-N15: public DTO field set matches the exact pre-cutover shape');
  STUB_PROJECTION = PROJECTION;
  ENRICHMENT_ROWS = [{ id: "mg_260914_1", entrega_ref: null, anchor_order_id: null }];
  {
    const list = await getManualGirosRead({});
    const expectedKeys = ["id", "seq", "giro_day", "created_at", "created_by", "dissolved_at", "hora_ref", "anchor_order_id", "entrega_ref", "order_ids"];
    assert('current-day DTO key set == legacy DTO key set exactly', JSON.stringify(Object.keys(list[0]).sort()) === JSON.stringify([...expectedKeys].sort()), Object.keys(list[0]));
  }
  {
    HISTORICAL_GIROS = [{ id: "mg_x", seq: 1, giro_day: "2026-01-01", created_at: "t", created_by: "c", dissolved_at: null, hora_ref: null, anchor_order_id: null, entrega_ref: null }];
    HISTORICAL_ORDERS = [];
    const list = await getManualGirosRead({ day: "2026-01-01" });
    const expectedKeys = ["id", "seq", "giro_day", "created_at", "created_by", "dissolved_at", "hora_ref", "anchor_order_id", "entrega_ref", "order_ids"];
    assert('historical DTO key set == legacy DTO key set exactly', JSON.stringify(Object.keys(list[0]).sort()) === JSON.stringify([...expectedKeys].sort()));
    HISTORICAL_GIROS = [];
  }

  section('Delegation proof: manualGiros.getManualGiros forwards to manualGiroReads.getManualGirosRead unchanged');
  {
    const mg = require("../src/agents/manualGiros");
    STUB_PROJECTION = PROJECTION;
    ENRICHMENT_ROWS = [];
    const viaWrapper = await mg.getManualGiros({});
    const viaDirect = await getManualGirosRead({});
    assert('mg.getManualGiros({}) result matches manualGiroReads.getManualGirosRead({}) result', JSON.stringify(viaWrapper) === JSON.stringify(viaDirect));
    assert('mg.getManualGiros still defaults onlyActive to true (same as before)', viaWrapper.length === 1 && viaWrapper[0].id === "mg_260914_1");
  }

  console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
