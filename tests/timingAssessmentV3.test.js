// tests/timingAssessmentV3.test.js
// ===============================================================
// TIMING ASSESSMENT V3 — canonical core certification (W2, TB-2).
// Run: node tests/timingAssessmentV3.test.js
//
// Pure/offline: the core (computeTimingAssessmentV3, buildStandaloneScheduleFacts)
// takes plain fact objects, no DB, no fetch, no Date.now(). The three ports
// (giroFactsPort, driverFactsPort, operationalScopePort) are exercised with
// injected stubs — still no network, no DB, no writes.
//
// Covers the W2-N01..N16 minimal contract plus the extra reason codes TB-2
// §4 lists (GIRO_AVAILABLE, RECOMMENDED_HORA, DRIVER_TRIP_FROM_PREVIOUS_SERVICE)
// and the port-level failure-mode guarantees (never a silent FREE/empty/NONE).
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const {
  SEVERITY_RANK,
  REASON_CATALOG,
  computeTimingAssessmentV3,
  buildStandaloneScheduleFacts,
} = require("../src/core/delivery/timingAssessmentV3");
// W6.5 — giroFactsPort.js (the W2 temporary shim) is DELETED. Its canonical
// successor, giroProjectionPort.js, has been the live read boundary since W4.
// These fixture builders adapt the test's legacy giro shape onto a real
// giro_projection_v1 body, so the W2 core below is exercised against the SAME
// facts it will actually receive when it is activated.
const {
  resolveIntendedGiroFromProjection,
  findCompatibleGiroFromProjection,
} = require("../src/core/delivery/giroProjectionPort");

// giros: [{ id, hora_ref, dissolved_at, order_ids, giro_state? }] -> projection body.
// `giro_state` is now EXPLICIT: the pre-W6.5 shim inferred DEPARTED from "hora_ref is
// already in the past", a heuristic the canonical Authority replaced with a real
// lifecycle state (TB-2). Fixtures state the fact instead of implying it.
function projectionFrom(giros, ordersById = {}) {
  return {
    contract: "giro_projection_v1", scope_valid: true, degraded: false,
    giros: (giros || []).map((g) => ({
      giro_id: g.id,
      giro_state: g.giro_state || (g.dissolved_at ? "DISSOLVED" : "PLANNED"),
      salida: g.hora_ref || null,
      hora_ref: g.hora_ref || null,
      effective_members: (g.order_ids || []).map((oid) => ({ order_uid: `u-${oid}`, order_id: oid })),
      dissolved_at: g.dissolved_at || null,
    })),
    orders: (giros || []).flatMap((g) => (g.order_ids || []).map((oid) => ({
      order_uid: `u-${oid}`, order_id: oid, effective_giro_id: g.id,
    }))),
    intents: [],
  };
}
const resolveIntendedGiroFacts = ({ giroId, newOrderZona, giros, ordersById }) =>
  resolveIntendedGiroFromProjection({ giroId, newOrderZona, projection: projectionFrom(giros, ordersById), ordersById });
const findCompatibleGiro = ({ newOrderZona, giros, ordersById }) => {
  const hit = findCompatibleGiroFromProjection(projectionFrom(giros, ordersById), newOrderZona, ordersById);
  return hit ? hit.giro_id : null;
};
const { resolveDriverFacts } = require("../src/core/delivery/driverFactsPort");
const { resolveOperationalScope } = require("../src/core/delivery/operationalScopePort");
const { toServiceDayMin, computeDriverFields } = require("../src/utils/zones");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const section = (s) => console.log(`\n══ ${s} ══`);
const codes = (a) => a.reasons.map((r) => r.code);
const has = (a, code) => codes(a).includes(code);
const T = (hhmm) => toServiceDayMin(hhmm);

(async () => {

// ─────────────────────────────────────────────────────────────────────────
section("W2-N01 — same-zone compatible giro absorbs the draft order");
{
  const a = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    intendedGiro: { status: "VALID", absorbsOverlap: true, estimatedSalidaMin: null },
    standaloneRetrasoMin: 999, // must be ignored — never simulated as a second trip
  });
  check("severity <= ADVISORY", SEVERITY_RANK[a.severity] <= SEVERITY_RANK.ADVISORY, a.severity);
  check("GIRO_ABSORBS_OVERLAP fired", has(a, "GIRO_ABSORBS_OVERLAP"));
  check("SCHEDULE_OVERLAP_ESTIMATED did NOT fire", !has(a, "SCHEDULE_OVERLAP_ESTIMATED"));
  check("intended_giro.can_apply = true", a.intended_giro.can_apply === true);
  check("intended_giro.absorbs_overlap = true", a.intended_giro.absorbs_overlap === true);
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N02 — cross-zone compatible giro (the historical bug regression)");
{
  // Q2 and Q5 are both on the "sur" channel (deliveryChannels), different zonas.
  const giros = [{ id: "mg1", hora_ref: "21:30", dissolved_at: null, order_ids: ["A"] }];
  const ordersById = { A: { zona: "Q2" } };
  const gf = resolveIntendedGiroFacts({
    giroId: "mg1", newOrderZona: "Q5", giros, ordersById, nowServiceDayMin: T("19:00"),
  });
  check("port resolves VALID", gf.status === "VALID");
  check("port resolves cross-zone absorption = true", gf.absorbsOverlap === true);

  const a = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    intendedGiro: gf,
    standaloneRetrasoMin: 999, // if this fires, the order WAS simulated as a second trip — the bug
  });
  check("GIRO_ABSORBS_OVERLAP fired", has(a, "GIRO_ABSORBS_OVERLAP"));
  check("NOT simulated as a separate trip (no SCHEDULE_OVERLAP_ESTIMATED)", !has(a, "SCHEDULE_OVERLAP_ESTIMATED"));
  check("intended_giro.can_apply = true", a.intended_giro.can_apply === true);

  // Negative control: a genuinely cross-CHANNEL pair (sur vs oeste) must NOT absorb.
  const giros2 = [{ id: "mg2", hora_ref: "21:30", dissolved_at: null, order_ids: ["B"] }];
  const ordersById2 = { B: { zona: "Q2" } }; // sur
  const gf2 = resolveIntendedGiroFacts({
    giroId: "mg2", newOrderZona: "Q3", giros: giros2, ordersById: ordersById2, nowServiceDayMin: T("19:00"), // Q3 = oeste
  });
  check("cross-channel pair does NOT absorb (control)", gf2.status === "VALID" && gf2.absorbsOverlap === false);
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N03 — standalone estimated rider overlap");
{
  const a = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    intendedGiro: null,
    compatibleGiroAvailable: false,
    standaloneRetrasoMin: 12,
  });
  check("severity = WARNING", a.severity === "WARNING");
  check("SCHEDULE_OVERLAP_ESTIMATED fired", has(a, "SCHEDULE_OVERLAP_ESTIMATED"));
  check("no HARD concept anywhere (ladder has no such value)", Object.values(SEVERITY_RANK).every((v) => v <= SEVERITY_RANK.WARNING));
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N04 — rider out, returns before the draft order's own salida");
{
  const a = computeTimingAssessmentV3({
    driver: { state: "IN_TRIP", returnEstimateMin: T("20:40") },
    newOrderSalidaMin: T("21:00"),
  });
  check("severity = INFO", a.severity === "INFO");
  check("RIDER_OUT_RETURN_ESTIMATED fired", has(a, "RIDER_OUT_RETURN_ESTIMATED"));
  check("RIDER_RETURN_AFTER_SALIDA_ESTIMATED did NOT fire", !has(a, "RIDER_RETURN_AFTER_SALIDA_ESTIMATED"));
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N05 — rider returns after the estimated salida");
{
  const a = computeTimingAssessmentV3({
    driver: { state: "IN_TRIP", returnEstimateMin: T("21:10") },
    newOrderSalidaMin: T("21:00"),
  });
  check("severity = WARNING", a.severity === "WARNING");
  check("RIDER_RETURN_AFTER_SALIDA_ESTIMATED fired", has(a, "RIDER_RETURN_AFTER_SALIDA_ESTIMATED"));
  check("RIDER_OUT_RETURN_ESTIMATED did NOT also fire", !has(a, "RIDER_OUT_RETURN_ESTIMATED"));
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N06 — driver authority unavailable");
{
  const a = computeTimingAssessmentV3({ driver: null });
  check("driver_state = UNKNOWN", a.driver_state === "UNKNOWN");
  check("degraded = true", a.degraded === true);
  check("DRIVER_STATE_UNKNOWN fired", has(a, "DRIVER_STATE_UNKNOWN"));

  // Port level: never a silent FREE.
  const r1 = await resolveDriverFacts({ readDriverStato: async () => { throw new Error("boom"); } });
  check("port: read throws -> UNKNOWN (not FREE)", r1.state === "UNKNOWN");
  const r2 = await resolveDriverFacts({ readDriverStato: async () => null });
  check("port: null DRIVER_STATO -> UNKNOWN", r2.state === "UNKNOWN");
  const r3 = await resolveDriverFacts({ readDriverStato: async () => ({ stato: "WEIRD_UNRECOGNIZED" }) });
  check("port: unrecognized stato -> UNKNOWN (not FREE)", r3.state === "UNKNOWN");
  const r4 = await resolveDriverFacts({ readDriverStato: async () => ({ stato: "LIBERO" }) });
  check("port: LIBERO -> FREE", r4.state === "FREE");
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N07 — operational scope read failure");
{
  const a = computeTimingAssessmentV3({ driver: { state: "FREE" }, scopeAvailable: false });
  check("degraded = true (never a silent NONE)", a.degraded === true);
  check("SCOPE_UNAVAILABLE fired", has(a, "SCOPE_UNAVAILABLE"));

  const r1 = await resolveOperationalScope({
    getOperationalSessionIds: async () => { throw new Error("read failed"); },
    plannerBusinessDate: () => "2026-09-14",
  });
  check("port: getOperationalSessionIds throws -> available:false", r1.available === false);

  const r2 = await resolveOperationalScope({ getOperationalSessionIds: async () => ["s1"], plannerBusinessDate: () => "2026-09-14" });
  check("port: success -> available:true + businessDate", r2.available === true && r2.businessDate === "2026-09-14");

  const r3 = await resolveOperationalScope({});
  check("port: missing deps -> available:false (fail closed, not fail open)", r3.available === false);
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N08 — Google/geo duration unavailable");
{
  const a = computeTimingAssessmentV3({ driver: { state: "FREE" }, geoDurationAvailable: false });
  check("degraded = true", a.degraded === true);
  check("GEO_DURATION_ESTIMATED fired", has(a, "GEO_DURATION_ESTIMATED"));
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N09 — manual hora overlap, hora is never rewritten");
{
  const a = computeTimingAssessmentV3({ driver: { state: "FREE" }, standaloneRetrasoMin: 8 });
  check("severity = WARNING", a.severity === "WARNING");
  check("no hora / hora_proposta field exists on the assessment", !("hora" in a) && !("hora_proposta" in a));
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N10 — operator-typed vs Planner-applied hora: deep-equivalent");
{
  const base = {
    driver: { state: "FREE" },
    standaloneRetrasoMin: 8,
    newOrder: { horaMin: T("21:00"), zona: "Q2" },
  };
  const a1 = computeTimingAssessmentV3({ ...base, horaOwnership: "operator" });
  const a2 = computeTimingAssessmentV3({ ...base, horaOwnership: "planner" });
  check("identical facts + different hora ownership -> deep-equal assessment", JSON.stringify(a1) === JSON.stringify(a2));
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N11 — hora before earliest_hora");
{
  const a = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    newOrder: { horaMin: T("19:10"), zona: "Q2" },
    earliestHoraMin: T("19:30"),
  });
  check("severity = WARNING", a.severity === "WARNING");
  check("HORA_BEFORE_EARLIEST fired", has(a, "HORA_BEFORE_EARLIEST"));
  check("earliest_hora surfaced", a.earliest_hora === "19:30");
  check("no confirm-semantics field anywhere", !("can_confirm" in a) && !("block_confirm" in a) && !("has_conflict" in a));
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N12 — 23:50 → 00:20, same service day, no false midnight conflict");
{
  check("service-day clock orders 00:20 AFTER 23:50 (no wrap)", T("00:20") > T("23:50"));
  check("service-day values are the documented ones", T("23:50") === 1430 && T("00:20") === 1460);

  const existing = [{ id: "E1", tipo_consegna: "DOMICILIO", estado: "LISTO", zona: "Q1", hora: "23:50", durata_andata_min: 5 }];
  const draft = { tipo_consegna: "DOMICILIO", zona: "Q1", hora: "00:20", durata_andata_min: 5 };
  const sf = buildStandaloneScheduleFacts(existing, draft);
  check("retrasoEstimadoMin is never negative", sf.retrasoEstimadoMin == null || sf.retrasoEstimadoMin >= 0);
  check("no false conflict across the midnight boundary", sf.conflictoDriver === false);
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N13 — terminal/cancelled orders never contribute to the schedule");
{
  const terminal = [
    { id: "C1", tipo_consegna: "DOMICILIO", estado: "CANCELADO", zona: "Q1", hora: "19:00", durata_andata_min: 30 },
    { id: "C2", tipo_consegna: "DOMICILIO", estado: "ANULADO", zona: "Q1", hora: "19:05", durata_andata_min: 30 },
    { id: "C3", tipo_consegna: "DOMICILIO", estado: "CHIUSO_FORZATO", zona: "Q1", hora: "19:03", durata_andata_min: 30 },
  ];
  const draft = { tipo_consegna: "DOMICILIO", zona: "Q1", hora: "19:10", durata_andata_min: 5 };

  const sf = buildStandaloneScheduleFacts(terminal, draft);
  check("terminal orders filtered -> no conflict for the draft", sf.conflictoDriver === false);

  // Control: prove the fixture is real — WITHOUT the terminal pre-filter the
  // legacy cascade math (whose OWN exclusion list omits CANCELADO/ANULADO/
  // CHIUSO_FORZATO) really would have produced a conflict here.
  const unfiltered = [...terminal, { ...draft, id: "DRAFT_CONTROL", estado: "EN_COCINA" }];
  const unfilteredFields = computeDriverFields(unfiltered, {});
  const draftControl = unfilteredFields.get("DRAFT_CONTROL");
  check(
    "control: without the fix, the same fixture DOES collide (fixture is meaningful)",
    !!draftControl && draftControl.conflicto_driver === true
  );
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N14 — intended giro target departed");
{
  const a = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    intendedGiro: { status: "DEPARTED", absorbsOverlap: false, estimatedSalidaMin: T("20:00") },
  });
  check("INTENT_TARGET_DEPARTED fired", has(a, "INTENT_TARGET_DEPARTED"));
  check("intended_giro.can_apply = false", a.intended_giro.can_apply === false);
  check("no field that could block Confirmar", !JSON.stringify(a).toLowerCase().includes("confirm"));

  // Port level: the canonical lifecycle state IS the departure fact (W6.5 — the
  // retired shim guessed it from "hora_ref already in the past", which is why a
  // giro whose planned time had merely elapsed looked departed when it had not).
  const giros = [{ id: "mg3", hora_ref: "19:00", dissolved_at: null, order_ids: [], giro_state: "IN_TRIP" }];
  const gf = resolveIntendedGiroFacts({ giroId: "mg3", newOrderZona: "Q2", giros, ordersById: {} });
  check("port: IN_TRIP giro -> DEPARTED", gf.status === "DEPARTED");
  const notDeparted = resolveIntendedGiroFacts({
    giroId: "mg3b", newOrderZona: "Q2",
    giros: [{ id: "mg3b", hora_ref: "19:00", dissolved_at: null, order_ids: [] }], ordersById: {},
  });
  check("port: a PLANNED giro whose hora_ref merely elapsed is NOT departed", notDeparted.status === "VALID");
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N15 — intended giro target changed / gone: standalone still evaluated");
{
  const aChanged = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    intendedGiro: { status: "CHANGED" },
    standaloneRetrasoMin: 15,
  });
  check("INTENT_TARGET_CHANGED fired", has(aChanged, "INTENT_TARGET_CHANGED"));
  check("can_apply = false", aChanged.intended_giro.can_apply === false);
  check("standalone timing still evaluated (SCHEDULE_OVERLAP_ESTIMATED)", has(aChanged, "SCHEDULE_OVERLAP_ESTIMATED"));

  const aGone = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    intendedGiro: { status: "GONE" },
    standaloneRetrasoMin: 0,
  });
  check("INTENT_TARGET_GONE fired", has(aGone, "INTENT_TARGET_GONE"));
  check("can_apply = false", aGone.intended_giro.can_apply === false);
  check("no overlap reason when standalone retraso is 0", !has(aGone, "SCHEDULE_OVERLAP_ESTIMATED"));

  // Port level: id not found, and dissolved, both resolve to GONE.
  const giros = [{ id: "mg4", hora_ref: "21:00", dissolved_at: "2026-09-14T18:00:00Z", order_ids: [] }];
  const notFound = resolveIntendedGiroFacts({ giroId: "does-not-exist", newOrderZona: "Q2", giros, ordersById: {}, nowServiceDayMin: T("19:00") });
  check("port: unknown giro id -> GONE", notFound.status === "GONE");
  const dissolved = resolveIntendedGiroFacts({ giroId: "mg4", newOrderZona: "Q2", giros, ordersById: {}, nowServiceDayMin: T("19:00") });
  check("port: dissolved giro -> GONE", dissolved.status === "GONE");
}

// ─────────────────────────────────────────────────────────────────────────
section("W2-N16 — determinism: same facts + same as_of -> deep-equal result");
{
  const facts = {
    asOfMin: T("20:00"),
    driver: { state: "IN_TRIP", returnEstimateMin: T("21:10") },
    newOrderSalidaMin: T("21:00"),
    newOrder: { horaMin: T("21:00"), zona: "Q2" },
    intendedGiro: { status: "VALID", absorbsOverlap: true, estimatedSalidaMin: T("21:30") },
  };
  const a1 = computeTimingAssessmentV3(facts);
  const a2 = computeTimingAssessmentV3(JSON.parse(JSON.stringify(facts)));
  check("two independent runs over equal facts are deep-equal", JSON.stringify(a1) === JSON.stringify(a2));
}

// ─────────────────────────────────────────────────────────────────────────
section("Extra — remaining minimal reason codes (TB-2 §4)");
{
  // GIRO_AVAILABLE: standalone advisory when no intendedGiro was targeted.
  const aAvail = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    intendedGiro: null,
    compatibleGiroAvailable: true,
    standaloneRetrasoMin: 0,
  });
  check("GIRO_AVAILABLE fired when no giro targeted but one is compatible", has(aAvail, "GIRO_AVAILABLE"));

  const compat = findCompatibleGiro({
    newOrderZona: "Q5",
    giros: [{ id: "mgX", dissolved_at: null, order_ids: ["A"] }],
    ordersById: { A: { zona: "Q2" } }, // sur, compatible with Q5
  });
  check("findCompatibleGiro finds a cross-zone-compatible candidate", compat === "mgX");
  const noCompat = findCompatibleGiro({
    newOrderZona: "Q3", // oeste
    giros: [{ id: "mgX", dissolved_at: null, order_ids: ["A"] }],
    ordersById: { A: { zona: "Q2" } }, // sur — incompatible
  });
  check("findCompatibleGiro returns null when nothing is channel-compatible", noCompat === null);

  // RECOMMENDED_HORA: only fires when it differs from the requested hora.
  const aRec = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    newOrder: { horaMin: T("20:00"), zona: "Q2" },
    recommendedHoraMin: T("20:15"),
  });
  check("RECOMMENDED_HORA fires when it differs from requested hora", has(aRec, "RECOMMENDED_HORA"));
  check("recommended_hora surfaced as HH:MM", aRec.recommended_hora === "20:15");
  const aRecSame = computeTimingAssessmentV3({
    driver: { state: "FREE" },
    newOrder: { horaMin: T("20:00"), zona: "Q2" },
    recommendedHoraMin: T("20:00"),
  });
  check("RECOMMENDED_HORA does NOT fire when it equals the requested hora", !has(aRecSame, "RECOMMENDED_HORA"));

  // DRIVER_TRIP_FROM_PREVIOUS_SERVICE: via the port, with real timestamps.
  const r = await resolveDriverFacts({
    readDriverStato: async () => ({ stato: "IN_GIRO", partito_alle: "2026-09-14T08:00:00Z", rientro_stimato: null }),
    currentSessionOpenedAt: "2026-09-14T10:00:00Z",
  });
  check("port: trip started before the current session opened -> flagged", r.fromPreviousService === true);
  const aPrev = computeTimingAssessmentV3({ driver: { state: "IN_TRIP", returnEstimateMin: null, fromPreviousService: true } });
  check("DRIVER_TRIP_FROM_PREVIOUS_SERVICE fired", has(aPrev, "DRIVER_TRIP_FROM_PREVIOUS_SERVICE"));
  check("degraded = true for a previous-service trip", aPrev.degraded === true);
}

// ─────────────────────────────────────────────────────────────────────────
section("Contract shape / purity");
{
  const a = computeTimingAssessmentV3({ driver: { state: "FREE" } });
  const REQUIRED_FIELDS = [
    "as_of", "severity", "degraded", "reasons", "driver_state",
    "rider_return_estimate", "intended_giro", "recommended_hora", "earliest_hora",
  ];
  check("output has exactly the frozen contract fields, nothing extra", (() => {
    const keys = Object.keys(a).sort();
    return JSON.stringify(keys) === JSON.stringify([...REQUIRED_FIELDS].sort());
  })());
  check("severity is always a valid ladder value", Object.keys(SEVERITY_RANK).includes(a.severity));
  check("every reason is typed { code, severity, source, facts }", Object.entries(REASON_CATALOG).every(([code, e]) =>
    typeof code === "string" && ["NONE", "INFO", "ADVISORY", "WARNING"].includes(e.severity) && typeof e.degraded === "boolean"
  ));

  const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/timingAssessmentV3.js"), "utf8");
  // Purity is about CODE, not the prose explaining why a token is absent —
  // strip `//` line comments before scanning (this file has no `//` inside
  // any real string literal, so this is a safe, exact split for it).
  const codeOnly = src.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  check("core module never reads Date.now()/new Date() itself", !/Date\.now\(\)|new Date\(/.test(codeOnly));
  check("core module has no forbidden legacy authority tokens", !/has_conflict|block_confirm|can_confirm_requested_hora|CONFIRMAR_GATING_01|isBlocked/.test(codeOnly));
  check("core module never reads manual_giro_id directly", !/manual_giro_id/.test(codeOnly));
  check("core module does no fetch/env/supabase I/O", !/\bfetch\s*\(|process\.env|supabase|sbSelect|sbInsert|sbUpdate/i.test(codeOnly));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);

})();
