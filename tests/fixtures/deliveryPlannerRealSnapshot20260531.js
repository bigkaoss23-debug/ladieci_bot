// tests/fixtures/deliveryPlannerRealSnapshot20260531.js
// ===============================================================
// SNAPSHOT REALE STATICO — serata 2026-05-31 (LaDieci10App)
// ===============================================================
// Fonte: backup_serata.ordini (jsonb) — SELECT READ-ONLY, congelato qui come
// fixture statica. NESSUNA query live dentro i test. Nessun dato personale:
// niente nombre/tel/direccion/cliente_id. Solo fatti grezzi + derivato persistito.
//
// Estrazione (read-only):
//   SELECT da backup_serata WHERE fecha='2026-05-31' (riga con più ordini).
//   n_pizze = somma q degli item con cat ILIKE '%pizza%' (carico forno).
//
// Note di fedeltà:
//   - Tutti gli ordini risultano `RETIRADO` (stato di fine serata, archiviato):
//     per il REPLAY li ripianifichiamo come fatti grezzi con un `now` iniziale.
//   - Nel backup è persistito SOLO `forno_out`. salida/entrega/retraso/conflicto
//     erano null al backup → il lato "vecchio" di quei campi si RICOSTRUISCE
//     eseguendo le funzioni pure di zones.js (computeDriverFields), dichiarato.
//   - Nessun manual_giro in questa serata (n_manual_giro = 0).
// ===============================================================

"use strict";

// 21 ordini (13 RITIRO + 8 DOMICILIO). zona=null per i RITIRO (occupano solo forno).
const orders = [
  // ── RITIRI (occupano il forno, non il rider) ──────────────────────────────
  { id: "#002", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:00", andata_min: null, n_pizze: 1, forno_out_db: "20:00" },
  { id: "#004", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:10", andata_min: null, n_pizze: 2, forno_out_db: "20:10" },
  { id: "#003", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:15", andata_min: null, n_pizze: 3, forno_out_db: "20:15" },
  { id: "#005", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:40", andata_min: null, n_pizze: 3, forno_out_db: "20:40" },
  { id: "#008", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:45", andata_min: null, n_pizze: 2, forno_out_db: "20:45" },
  { id: "#009", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:00", andata_min: null, n_pizze: 3, forno_out_db: "21:00" },
  { id: "#011", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:10", andata_min: null, n_pizze: 1, forno_out_db: "21:10" },
  { id: "#001", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:15", andata_min: null, n_pizze: 3, forno_out_db: "21:15" },
  { id: "#014", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:35", andata_min: null, n_pizze: 2, forno_out_db: "21:35" },
  { id: "#016", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:40", andata_min: null, n_pizze: 1, forno_out_db: "21:40" },
  { id: "#017", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:50", andata_min: null, n_pizze: 1, forno_out_db: "21:50" },
  { id: "#020", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:51", andata_min: null, n_pizze: 2, forno_out_db: "22:51" },
  { id: "#021", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "23:00", andata_min: null, n_pizze: 0, forno_out_db: "23:00" }, // solo bevanda

  // ── DOMICILIO (occupano forno + rider) ────────────────────────────────────
  // Cluster Q1 reale: 3 ordini stessa hora 22:00, andate 8/6/4 → forno_out_db 21:52 condiviso.
  { id: "#013", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:00", andata_min: 8, n_pizze: 2, forno_out_db: "21:52" },
  { id: "#015", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:00", andata_min: 6, n_pizze: 1, forno_out_db: "21:52" },
  { id: "#018", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:00", andata_min: 4, n_pizze: 1, forno_out_db: "21:52" },
  { id: "#019", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:10", andata_min: 8, n_pizze: 2, forno_out_db: "22:11" }, // forno spinto +9 (driver cascade reale)
  { id: "#010", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "23:21", andata_min: 8, n_pizze: 1, forno_out_db: "23:13" },
  // Q5 zona lunga, after-midnight (service-day): forno_out reale spinto dalla cascade rider.
  { id: "#012", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "00:11", andata_min: 12, n_pizze: 1, forno_out_db: "00:00" },
  { id: "#006", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "00:22", andata_min: 23, n_pizze: 1, forno_out_db: "00:27" },
  { id: "#007", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "00:25", andata_min: 26, n_pizze: 2, forno_out_db: "01:16" }, // forno reale 01:16 (driver molto in ritardo)
];

module.exports = {
  fecha: "2026-05-31",
  source: "backup_serata.ordini (read-only SELECT, congelato)",
  note_persisted: "Solo forno_out persistito nel backup; salida/entrega/retraso/conflicto erano null.",
  manual_giros: [], // nessuno in questa serata
  driver: null,     // nessuno stato rider reale (partito_alle) salvato nel backup
  orders,
};
