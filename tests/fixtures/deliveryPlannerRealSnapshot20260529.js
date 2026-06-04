// tests/fixtures/deliveryPlannerRealSnapshot20260529.js
// ===============================================================
// SNAPSHOT REALE STATICO — serata 2026-05-29 (LaDieci10App)
// Fonte: backup_serata.ordini (SELECT READ-ONLY, congelato). Nessun dato personale.
// 29 ordini: 23 RITIRO + 6 DOMICILIO. Forno SOTTO STRESS (ritiri densi, #012 = 6 pizze).
// Cluster Q1 21:35/21:40; cluster Q5 22:15/22:20 (#023 = 5 pizze). Solo forno_out baseline.
// ===============================================================
"use strict";
const orders = [
  // RITIRI (occupano forno) — densi, alcuni multi-pizza
  { id: "#001", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:00", andata_min: null, n_pizze: 2, forno_out_db: "20:00" },
  { id: "#003", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:20", andata_min: null, n_pizze: 3, forno_out_db: "20:20" },
  { id: "#004", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:30", andata_min: null, n_pizze: 1, forno_out_db: "20:30" },
  { id: "#007", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:40", andata_min: null, n_pizze: 2, forno_out_db: "20:40" },
  { id: "#008", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:45", andata_min: null, n_pizze: 2, forno_out_db: "20:45" },
  { id: "#006", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:50", andata_min: null, n_pizze: 1, forno_out_db: "20:50" },
  { id: "#005", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:00", andata_min: null, n_pizze: 3, forno_out_db: "21:00" },
  { id: "#012", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:04", andata_min: null, n_pizze: 6, forno_out_db: "21:04" }, // mega-ritiro 6 pizze
  { id: "#013", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:20", andata_min: null, n_pizze: 2, forno_out_db: "21:20" },
  { id: "#009", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:30", andata_min: null, n_pizze: 1, forno_out_db: "21:30" },
  { id: "#015", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:40", andata_min: null, n_pizze: 1, forno_out_db: "21:40" },
  { id: "#017", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:40", andata_min: null, n_pizze: 1, forno_out_db: "21:40" },
  { id: "#018", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:45", andata_min: null, n_pizze: 2, forno_out_db: "21:45" },
  { id: "#002", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:45", andata_min: null, n_pizze: 1, forno_out_db: "21:45" },
  { id: "#016", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:50", andata_min: null, n_pizze: 2, forno_out_db: "21:50" },
  { id: "#020", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:55", andata_min: null, n_pizze: 1, forno_out_db: "21:55" },
  { id: "#022", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:00", andata_min: null, n_pizze: 2, forno_out_db: "22:00" },
  { id: "#019", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:00", andata_min: null, n_pizze: 2, forno_out_db: "22:00" },
  { id: "#024", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:10", andata_min: null, n_pizze: 1, forno_out_db: "22:10" },
  { id: "#026", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:10", andata_min: null, n_pizze: 2, forno_out_db: "22:10" },
  { id: "#025", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:15", andata_min: null, n_pizze: 1, forno_out_db: "22:15" },
  { id: "#031", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:52", andata_min: null, n_pizze: 3, forno_out_db: "22:52" },
  { id: "#029", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:56", andata_min: null, n_pizze: 1, forno_out_db: "22:56" },
  // DOMICILIO
  { id: "#010", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "21:35", andata_min: 8, n_pizze: 2, forno_out_db: "21:27" },
  { id: "#011", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "21:40", andata_min: 8, n_pizze: 1, forno_out_db: "21:27" },
  { id: "#014", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "22:15", andata_min: 26, n_pizze: 2, forno_out_db: "21:49" },
  { id: "#023", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "22:20", andata_min: 18, n_pizze: 5, forno_out_db: "21:49" }, // 5 pizze in un solo ordine
  { id: "#021", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:52", andata_min: 8, n_pizze: 2, forno_out_db: "22:44" },
  { id: "#028", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "23:07", andata_min: 4, n_pizze: 2, forno_out_db: "23:03" },
];
module.exports = { fecha: "2026-05-29", source: "backup_serata.ordini (read-only)", manual_giros: [], driver: null, orders };
