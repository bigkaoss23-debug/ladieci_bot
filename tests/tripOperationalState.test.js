// tests/tripOperationalState.test.js — Planner W6.6 Trip Operational HTTP wire
// bridge. Offline: readProjection/readGiro/select/now are all injected, no DB,
// no network. This module adds no new authority: it only serializes what
// tripProjectionPort.activeTripFacts() already computes (proven separately by
// tests/plannerW65FinalBackendV1.static.test.js) into the wire DTO.
// Run: node tests/tripOperationalState.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const {
  getTripOperationalState,
  _internal: { resolveGiroSalida },
} = require("../src/core/delivery/tripOperationalState");

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); } };

const NOW = "2026-09-16T12:30:00.000Z";
const noGiro = async () => ({ scope_valid: true, degraded: false, giros: [], orders: [] });

// ── 14. projection unavailable -> DEGRADED, never empty/free ────────────────
(async () => {
  {
    const r = await getTripOperationalState({ readProjection: async () => null, readGiro: noGiro, now: () => NOW });
    check("14: unavailable projection -> available:false", r.available === false, r);
    check("14: unavailable -> degraded:true", r.degraded === true, r);
    check("14: unavailable -> has_active_trip is null, NOT false (never implies rider free)", r.has_active_trip === null, r);
    check("14: unavailable -> reason TRIP_PROJECTION_MISSING", r.reason === "TRIP_PROJECTION_MISSING", r);
  }
  {
    const r = await getTripOperationalState({ readProjection: async () => ({ ok: false, code: "SCOPE_UNAVAILABLE" }), readGiro: noGiro, now: () => NOW });
    check("14b: SCOPE_UNAVAILABLE -> degraded, reason preserved", r.available === false && r.reason === "SCOPE_UNAVAILABLE", r);
    check("14b: SCOPE_UNAVAILABLE -> has_active_trip null", r.has_active_trip === null, r);
  }

  // ── 11. ETA DEGRADED reaches the wire on an unavailable projection ────────
  {
    const r = await getTripOperationalState({ readProjection: async () => null, readGiro: noGiro, now: () => NOW });
    check("11: eta_status DEGRADED on unavailable projection", r.eta_status === "DEGRADED", r);
    check("11: eta_reason TRIP_FACTS_UNAVAILABLE", r.eta_reason === "TRIP_FACTS_UNAVAILABLE", r);
  }

  // ── no active trip: VALID_EMPTY, distinct from DEGRADED ──────────────────
  {
    const r = await getTripOperationalState({ readProjection: async () => ({ ok: true, active: false }), readGiro: noGiro, now: () => NOW });
    check("no-trip: available:true, degraded:false", r.available === true && r.degraded === false, r);
    check("no-trip: has_active_trip === false (only here, never on a degraded read)", r.has_active_trip === false, r);
    check("no-trip: stops all zero, members empty", r.stops_total === 0 && r.members.length === 0, r);
    // ── 10. ETA UNKNOWN reaches the wire ───────────────────────────────────
    check("10: eta_status UNKNOWN, eta_reason NO_ACTIVE_TRIP", r.eta_status === "UNKNOWN" && r.eta_reason === "NO_ACTIVE_TRIP", r);
    check("13: rider_actor null / rider_known false on no-trip too", r.rider_actor === null && r.rider_known === false, r);
    check("no fake numeric ETA field anywhere on the DTO", !("eta" in r) && typeof r.eta_status === "string", r);
  }

  // ── 3,4,5,8,9,12,13: full active-trip shape ──────────────────────────────
  const ACTIVE_PROJECTION = {
    ok: true, active: true,
    trip_id: "t-1", giro_id: "g-1", anchor_order_uid: "u-a",
    departed_at: "2026-09-16T12:00:00.000Z",
    members: [
      { order_uid: "u-a", stop_seq: 1 },
      { order_uid: "u-b", stop_seq: 2 },
      { order_uid: "u-c", stop_seq: 3 },
    ],
  };
  const ORDER_ROWS = [
    { order_uid: "u-a", id: "A", estado: "RETIRADO", zona: "Q1", durata_andata_min: 12 },
    { order_uid: "u-b", id: "B", estado: "EN_ENTREGA", zona: "Q2", durata_andata_min: 18 },
    // u-c deliberately absent from the order query result -> known:false, still a member
  ];
  const GIRO_PROJECTION_DEPARTED = {
    scope_valid: true, degraded: false,
    giros: [{ giro_id: "g-1", giro_state: "IN_TRIP", salida: "12:00", salida_source: "DEPARTED", effective_members: [] }],
    orders: [],
  };

  {
    const r = await getTripOperationalState({
      readProjection: async () => ACTIVE_PROJECTION,
      select: async (table, q) => { check("scoped ordenes query names the table", table === "ordenes"); check("scoped query is order_uid=in.(...) — never a broad scan", /^order_uid=in\.\(/.test(q), q); return ORDER_ROWS; },
      readGiro: async () => GIRO_PROJECTION_DEPARTED,
      now: () => NOW,
    });
    check("3: has_active_trip true, trip_id/giro_id/trip_state serialize", r.has_active_trip === true && r.trip_id === "t-1" && r.giro_id === "g-1" && r.trip_state === "IN_TRIP", r);
    // 4. immutable/frozen membership: all 3 members present, including the unresolved one
    check("4: members preserves ALL 3 frozen members (u-c unresolved, not dropped)", r.members.length === 3 && r.members.some((m) => m.order_uid === "u-c" && m.known === false), r);
    // 5. completed/outstanding correct: u-a RETIRADO=completed, u-b/u-c outstanding
    check("5: completed_members == [A]", JSON.stringify(r.completed_members) === JSON.stringify(["A"]), r);
    check("5: outstanding_members == [B] (u-c unknown -> no order_id, excluded from the id list but still a member)", JSON.stringify(r.outstanding_members) === JSON.stringify(["B"]), r);
    check("stops_total 3 / stops_completed 1 / stops_remaining 2", r.stops_total === 3 && r.stops_completed === 1 && r.stops_remaining === 2, r);
    // 8. departed_at
    check("8: departed_at reaches the wire", r.departed_at === "2026-09-16T12:00:00.000Z", r);
    check("elapsed_min computed from departed_at vs injected now (30 min)", r.elapsed_min === 30, r);
    // 9. salida_source reaches the wire, sourced from the REAL Giro Authority
    // projection field (migration 135: derive_giros_v1 sets 'DEPARTED'), never invented
    check("9: salida_source == 'DEPARTED' (real Giro Authority field, not fabricated)", r.salida_source === "DEPARTED", r);
    check("9: salida == the giro projection's own salida value", r.salida === "12:00", r);
    // 12. no fake numeric ETA
    check("12: eta_status never a number", typeof r.eta_status === "string" && r.eta_status === "UNKNOWN", r);
    check("12: eta_reason NO_ARRIVAL_ESTIMATE_PROVIDER (no ETA provider exists)", r.eta_reason === "NO_ARRIVAL_ESTIMATE_PROVIDER", r);
    // 13. rider_actor unavailable from this projection -> explicit null, not invented
    check("13: rider_actor null / rider_known false (not carried by trip_projection_v1)", r.rider_actor === null && r.rider_known === false, r);
  }

  // ── 6. all-delivered state still preserves full members ──────────────────
  {
    const ALL_DELIVERED_ROWS = [
      { order_uid: "u-a", id: "A", estado: "RETIRADO", zona: "Q1", durata_andata_min: 12 },
      { order_uid: "u-b", id: "B", estado: "COMPLETADO", zona: "Q2", durata_andata_min: 18 },
      { order_uid: "u-c", id: "C", estado: "ENTREGADO", zona: "Q3", durata_andata_min: 9 },
    ];
    const r = await getTripOperationalState({
      readProjection: async () => ACTIVE_PROJECTION,
      select: async () => ALL_DELIVERED_ROWS,
      readGiro: noGiro,
      now: () => NOW,
    });
    check("6: all-delivered -> still has_active_trip true (not yet formally closed)", r.has_active_trip === true, r);
    check("6: all-delivered -> members.length still 3 (never shrinks)", r.members.length === 3, r);
    check("6: all-delivered -> stops_completed==stops_total, stops_remaining==0", r.stops_completed === 3 && r.stops_remaining === 0 && r.stops_total === 3, r);
    check("6: completed_members has all 3 ids", JSON.stringify(r.completed_members.sort()) === JSON.stringify(["A", "B", "C"]), r);
  }

  // ── 7. CLOSED/DONE (giro-side DONE) preserves full members ───────────────
  {
    const DONE_GIRO_PROJECTION = {
      scope_valid: true, degraded: false,
      giros: [{ giro_id: "g-1", giro_state: "DONE", salida: "12:00", salida_source: "DEPARTED", effective_members: [] }],
      orders: [],
    };
    const ALL_DELIVERED_ROWS = [
      { order_uid: "u-a", id: "A", estado: "RETIRADO", zona: "Q1", durata_andata_min: 12 },
      { order_uid: "u-b", id: "B", estado: "COMPLETADO", zona: "Q2", durata_andata_min: 18 },
      { order_uid: "u-c", id: "C", estado: "ENTREGADO", zona: "Q3", durata_andata_min: 9 },
    ];
    const r = await getTripOperationalState({
      readProjection: async () => ACTIVE_PROJECTION,
      select: async () => ALL_DELIVERED_ROWS,
      readGiro: async () => DONE_GIRO_PROJECTION,
      now: () => NOW,
    });
    check("7: giro-side DONE -> trip_state stays the real 'IN_TRIP' literal (never a fabricated CLOSED/DONE trip_state)", r.trip_state === "IN_TRIP", r);
    check("7: giro-side DONE -> members.length still 3 (never dropped)", r.members.length === 3, r);
    check("7: giro-side DONE -> salida_source still the real 'DEPARTED' value", r.salida_source === "DEPARTED", r);
  }

  // ── membership fetch failure: members stay resolvable (known:false), never dropped ──
  {
    const r = await getTripOperationalState({
      readProjection: async () => ACTIVE_PROJECTION,
      select: async () => { throw new Error("boom"); },
      readGiro: noGiro,
      now: () => NOW,
    });
    check("ordenes read failure -> still has_active_trip true, DEGRADED never used for a partial-fetch hiccup", r.available === true && r.has_active_trip === true, r);
    check("ordenes read failure -> all 3 members still present, all known:false", r.members.length === 3 && r.members.every((m) => m.known === false), r);
  }

  // ── resolveGiroSalida: unit-level, giro unavailable / not found -> null pair ──
  {
    const a = await resolveGiroSalida(null, { readGiro: noGiro });
    check("resolveGiroSalida(null giroId) -> {null,null} (no active trip)", a.salida === null && a.salida_source === null, a);
    const b = await resolveGiroSalida("g-404", { readGiro: async () => ({ scope_valid: true, degraded: false, giros: [], orders: [] }) });
    check("resolveGiroSalida(unknown giro) -> {null,null}, never fabricated", b.salida === null && b.salida_source === null, b);
    const c = await resolveGiroSalida("g-1", { readGiro: async () => null });
    check("resolveGiroSalida(giro projection unavailable) -> {null,null}, degrades locally only", c.salida === null && c.salida_source === null, c);
  }

  // ── 15/16/17: static source-scope guards (no DRIVER_STATO, no manual_giro_id
  // membership rebuild, no money/economy mutation) ─────────────────────────
  // Executable code only: `//` line comments stripped, same convention as
  // plannerW65FinalBackendV1.static.test.js's jsCode() — headers legitimately
  // DESCRIBE the very legacy this module deliberately avoids reading.
  const rawSrc = fs.readFileSync(path.join(__dirname, "..", "src", "core", "delivery", "tripOperationalState.js"), "utf8");
  const src = rawSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  check("15: no DRIVER_STATO canonical fallback anywhere in this module's code", !/DRIVER_STATO/.test(src));
  check("16: no raw manual_giro_id membership rebuild in this module's code", !/manual_giro_id/.test(src));
  check("16b: no raw manual_giros table read in this module's code", !/manual_giros/.test(src));
  check("17: no money/economy mutation — module performs zero writes", !/sbInsert|sbUpdate|sbUpsert|sbDelete/.test(src));

  // ── index.js wiring + auth registration (source-verified, offline) ───────
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  check("index.js registers getTripOperationalState as a GET action", /action === "getTripOperationalState"/.test(idx));
  // 2. trusted operational scope only — the live call site passes NO argument
  // at all (no req.query/req.body forwarded), so scope can only ever come from
  // readTripProjection's own internal getOperationalSessionIds() resolution.
  check("2: live call site invokes getTripOperationalState() with zero arguments (no client-controlled scope)",
    /getTripOperationalState\(\)/.test(idx) && !/getTripOperationalState\(\s*req\./.test(idx));
  const { isAllowed, ALL_ACTIONS } = require("../src/auth/legacyActionRoles");
  check("1: getTripOperationalState is a known, authenticated action (guard-covered)", ALL_ACTIONS.includes("getTripOperationalState"));
  check("1b: admin allowed", isAllowed("admin", "getTripOperationalState"));
  check("1c: operator allowed (Planner/TabEntregas staff)", isAllowed("operator", "getTripOperationalState"));
  check("1d: rider allowed (RepartidorPage self-service)", isAllowed("rider", "getTripOperationalState"));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
