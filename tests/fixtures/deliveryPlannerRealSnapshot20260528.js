// tests/fixtures/deliveryPlannerRealSnapshot20260528.js
// ===============================================================
// SNAPSHOT REALE STATICO — serata 2026-05-28 (LaDieci10App)
// Fonte: backup_serata.ordini (SELECT READ-ONLY, congelato). Nessun dato personale.
// 11 ordini: 4 RITIRO + 7 DOMICILIO. Zone: Q1,Q2,Q3,Q5 (mix più ricco).
// Solo `forno_out` persistito (baseline); salida/entrega/retraso/conflicto erano null.
// Replay: tutti RETIRADO → ripianificati come fatti grezzi (MOVIBILE) con `now` iniziale.
// ===============================================================
"use strict";
const orders = [
  // RITIRI (occupano forno)
  { id: "#002", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:10", andata_min: null, n_pizze: 2, forno_out_db: "20:10" },
  { id: "#003", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:10", andata_min: null, n_pizze: 2, forno_out_db: "20:10" },
  { id: "#007", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:15", andata_min: null, n_pizze: 2, forno_out_db: "21:15" },
  { id: "#011", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:00", andata_min: null, n_pizze: 3, forno_out_db: "22:00" },
  // DOMICILIO — cluster Q5 stessa hora 21:00 (andate lunghe 26/28)
  { id: "#004", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "21:00", andata_min: 26, n_pizze: 2, forno_out_db: "20:32" },
  { id: "#005", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "21:00", andata_min: 28, n_pizze: 2, forno_out_db: "20:32" },
  { id: "#008", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q2", hora: "21:39", andata_min: 10, n_pizze: 1, forno_out_db: "21:29" },
  { id: "#009", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q3", hora: "22:05", andata_min: 9, n_pizze: 1, forno_out_db: "21:56" },
  { id: "#001", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:18", andata_min: 8, n_pizze: 1, forno_out_db: "22:10" },
  { id: "#010", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:25", andata_min: 8, n_pizze: 1, forno_out_db: "22:17" },
  { id: "#006", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q3", hora: "22:56", andata_min: 8, n_pizze: 2, forno_out_db: "22:48" },
];
module.exports = { fecha: "2026-05-28", source: "backup_serata.ordini (read-only)", manual_giros: [], driver: null, orders };
