"use strict";
// Real staging rows (project tdikhfeinufaahagmpjz), captured read-only on
// 2026-08-21 for I-1 acceptance. Verbatim values — nothing invented, nothing
// rounded. Two Operational Services share business_date 2026-08-20:
//   4f260f1e  09:18-11:34 Madrid  CLOSED  (the certified UAT closeout)
//   480eca89  19:06-      Madrid  OPEN    (the preserved forensic service)
// Plus the three `#001` rows that prove order ids are per-service, not unique.
const S = Object.freeze({
  UAT: "4f260f1e-8e1c-46f2-9db5-86f3446ff759",
  FORENSIC: "480eca89-33cd-43ba-ac7f-5ed0a0473639",
  A: "1cfaabf8-4d76-48fa-ae5e-187bfe337ffd",
  B: "9fe2f3c1-7716-4817-bd98-03f51ecdf415",
  C: "33174121-4f95-4ff5-a67e-aa5dde803d31",
});

const sessions = [
  { id: S.A, business_date: "2026-08-06", status: "closed", opened_at: "2026-08-06T13:09:24.893722+00:00", closed_at: "2026-08-06T17:29:56.94123+00:00", service_kind: "PRANZO" }, // language-guard: allow-legacy PRANZO is the existing service_kind enum value copied verbatim from the live row, not new vocabulary
  { id: S.B, business_date: "2026-08-06", status: "closed", opened_at: "2026-08-06T17:44:33.949832+00:00", closed_at: "2026-08-06T22:19:58.468907+00:00", service_kind: "SERA" },
  { id: S.C, business_date: "2026-08-07", status: "closed", opened_at: "2026-08-07T07:01:07.66404+00:00", closed_at: "2026-08-10T08:07:41.541687+00:00", service_kind: "PRANZO" }, // language-guard: allow-legacy PRANZO is the existing service_kind enum value copied verbatim from the live row, not new vocabulary
  { id: S.UAT, business_date: "2026-08-20", status: "closed", opened_at: "2026-08-20T07:18:52.39594+00:00", closed_at: "2026-08-20T09:34:44.324613+00:00", service_kind: null },
  { id: S.FORENSIC, business_date: "2026-08-20", status: "open", opened_at: "2026-08-20T17:06:44.405219+00:00", closed_at: null, service_kind: null },
];

const O = (id, estado, totale, metodo, paid, session, at) => ({
  id, estado, totale, metodo_pago: metodo, cobrado: paid, ya_pagado: paid,
  service_session_id: session, created_at: at,
});

const ordenes = [
  // The UAT service (closed by V3 operator Finalizar -> rows stay in `ordenes`).
  O("#999006", "CANCELADO", 10, "", false, S.UAT, "2026-08-20T07:18:52.39594+00:00"),
  O("#999007", "RETIRADO", 27, "efectivo", true, S.UAT, "2026-08-20T09:04:47.197176+00:00"),
  O("#999008", "POR_CONFIRMAR", 19.5, "", false, S.UAT, "2026-08-20T09:06:09.859181+00:00"),
  O("#999009", "RETIRADO", 34.5, "efectivo", true, S.UAT, "2026-08-20T09:10:27.411813+00:00"),
  O("#999010", "RETIRADO", 12, "tarjeta", true, S.UAT, "2026-08-20T09:12:50.278627+00:00"),
  O("#999011", "RETIRADO", 11, "efectivo", true, S.UAT, "2026-08-20T09:15:49.828046+00:00"),
  O("#999012", "RETIRADO", 39.5, "bizum", true, S.UAT, "2026-08-20T09:20:15.913711+00:00"),
  // The preserved forensic service.
  O("#999013", "RETIRADO", 10, "efectivo", true, S.FORENSIC, "2026-08-20T18:43:13.946292+00:00"),
  O("#999014", "RETIRADO", 79, "tarjeta", true, S.FORENSIC, "2026-08-20T19:09:49.913324+00:00"),
  O("#999015", "RETIRADO", 101, "MIXTO", true, S.FORENSIC, "2026-08-20T19:13:33.744532+00:00"),
  O("#999016", "RETIRADO", 45, "efectivo", true, S.FORENSIC, "2026-08-20T19:21:17.950315+00:00"),
  O("#999017", "RETIRADO", 27.5, "bizum", true, S.FORENSIC, "2026-08-20T19:27:11.043635+00:00"),
  // Collision proof: a THIRD `#001`, in a third service, still live in `ordenes`.
  O("#001", "RETIRADO", 16, "efectivo", true, S.C, "2026-08-07T07:04:18.048359+00:00"),
];

// language-guard: allow-legacy storico is the existing archive table name these verbatim rows come from, not new vocabulary
const storico = [
  { id: 259, orden_id: "#001", estado: "RETIRADO", totale: 10, cobrado: true, ya_pagado: true, metodo_pago: "efectivo", service_session_id: S.A, created_at: "2026-08-06T17:29:56.342785+00:00" },
  { id: 260, orden_id: "#001", estado: "RETIRADO", totale: 13, cobrado: true, ya_pagado: true, metodo_pago: "efectivo", service_session_id: S.B, created_at: "2026-08-06T22:19:57.580091+00:00" },
];

const E = (id, order, amount, method, at, session, kind) => ({
  id, order_id: order, type: "payment", amount, payment_method: method,
  created_at: at, service_session_id: session, event_service_session_id: session,
  obligation_economic_period_kind: kind, event_economic_period_kind: kind,
});

const events = [
  E("b94ce9f5", "#999007", 27.0, "efectivo", "2026-08-20T09:23:30.800956+00:00", S.UAT, "PRANZO"), // language-guard: allow-legacy PRANZO is the existing stamp value copied verbatim from the live row, not new vocabulary
  E("d327e834", "#999009", 34.5, "efectivo", "2026-08-20T09:24:32.745348+00:00", S.UAT, "PRANZO"), // language-guard: allow-legacy PRANZO is the existing stamp value copied verbatim from the live row, not new vocabulary
  E("62a92403", "#999011", 11.0, "efectivo", "2026-08-20T09:24:32.745348+00:00", S.UAT, "PRANZO"), // language-guard: allow-legacy PRANZO is the existing stamp value copied verbatim from the live row, not new vocabulary
  E("19cbfe70", "#999010", 12.0, "tarjeta", "2026-08-20T09:27:42.888912+00:00", S.UAT, "PRANZO"), // language-guard: allow-legacy PRANZO is the existing stamp value copied verbatim from the live row, not new vocabulary
  E("424aa27d", "#999012", 39.5, "bizum", "2026-08-20T09:29:20.32847+00:00", S.UAT, "PRANZO"), // language-guard: allow-legacy PRANZO is the existing stamp value copied verbatim from the live row, not new vocabulary
  E("ae9b3454", "#999013", 10.0, "efectivo", "2026-08-20T18:47:22.177029+00:00", S.FORENSIC, "SERA"),
  E("0596b3ed", "#999014", 79.0, "tarjeta", "2026-08-20T19:22:35.619052+00:00", S.FORENSIC, "SERA"),
  E("858fc444", "#999015", 33.5, "tarjeta", "2026-08-20T19:23:34.2206+00:00", S.FORENSIC, "SERA"),
  E("6834aff5", "#999015", 20.0, "bizum", "2026-08-20T19:24:09.210419+00:00", S.FORENSIC, "SERA"),
  E("9319b609", "#999015", 30.0, "efectivo", "2026-08-20T19:25:12.624657+00:00", S.FORENSIC, "SERA"),
  E("ef46c219", "#999015", 17.5, "tarjeta", "2026-08-20T19:25:23.024498+00:00", S.FORENSIC, "SERA"),
  E("4bf64da3", "#999016", 45.0, "efectivo", "2026-08-20T19:29:30.964886+00:00", S.FORENSIC, "SERA"),
  E("ec5c2149", "#999017", 27.5, "bizum", "2026-08-20T19:29:54.811149+00:00", S.FORENSIC, "SERA"),
  // Three payments against three DIFFERENT orders all called `#001`.
  E("41bae4f7", "#001", 10.0, "efectivo", "2026-08-06T17:22:01.723791+00:00", S.A, null),
  E("a2bd69e0", "#001", 13.0, "efectivo", "2026-08-06T18:20:32.254958+00:00", S.B, null),
  E("03b2b61f", "#001", 16.0, "efectivo", "2026-08-10T09:43:39.252182+00:00", S.C, null),
];

// language-guard: allow-legacy storico is the existing archive table name this fixture mirrors, exported under its real name, not new vocabulary
module.exports = { S, sessions, ordenes, storico, events };
