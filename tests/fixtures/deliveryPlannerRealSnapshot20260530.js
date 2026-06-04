// tests/fixtures/deliveryPlannerRealSnapshot20260530.js
// ===============================================================
// SNAPSHOT REALE STATICO — serata 2026-05-30 (LaDieci10App)
// Fonte: backup_serata.ordini (SELECT READ-ONLY, congelato). Nessun dato personale.
// 26 ordini: 20 RITIRO + 6 DOMICILIO. Forno SOTTO STRESS. Cluster Q1 20:30 (#003+#008,
// #008=4 pizze), cluster Q1 22:40 (#022+#024), Q5 lunga #018 (andata 28). forno_out baseline.
// ===============================================================
"use strict";
const orders = [
  // RITIRI
  { id: "#001", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:15", andata_min: null, n_pizze: 2, forno_out_db: "20:15" },
  { id: "#002", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:25", andata_min: null, n_pizze: 3, forno_out_db: "20:25" },
  { id: "#004", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:30", andata_min: null, n_pizze: 1, forno_out_db: "20:30" },
  { id: "#006", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:35", andata_min: null, n_pizze: 1, forno_out_db: "20:35" },
  { id: "#010", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "20:44", andata_min: null, n_pizze: 1, forno_out_db: "20:44" },
  { id: "#013", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:10", andata_min: null, n_pizze: 1, forno_out_db: "21:10" },
  { id: "#009", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:15", andata_min: null, n_pizze: 1, forno_out_db: "21:15" },
  { id: "#012", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:20", andata_min: null, n_pizze: 1, forno_out_db: "21:20" },
  { id: "#005", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:30", andata_min: null, n_pizze: 1, forno_out_db: "21:30" },
  { id: "#015", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:35", andata_min: null, n_pizze: 2, forno_out_db: "21:35" },
  { id: "#014", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:40", andata_min: null, n_pizze: 1, forno_out_db: "21:40" },
  { id: "#020", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:40", andata_min: null, n_pizze: 1, forno_out_db: "21:40" },
  { id: "#007", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:45", andata_min: null, n_pizze: 2, forno_out_db: "21:45" },
  { id: "#019", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:50", andata_min: null, n_pizze: 2, forno_out_db: "21:50" },
  { id: "#023", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:50", andata_min: null, n_pizze: 1, forno_out_db: "21:50" },
  { id: "#025", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:52", andata_min: null, n_pizze: 2, forno_out_db: "21:52" },
  { id: "#021", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "21:55", andata_min: null, n_pizze: 1, forno_out_db: "21:55" },
  { id: "#016", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:15", andata_min: null, n_pizze: 5, forno_out_db: "22:15" }, // mega-ritiro 5 pizze
  { id: "#026", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:15", andata_min: null, n_pizze: 0, forno_out_db: "22:15" }, // solo bevanda
  { id: "#027", tipo_consegna: "RITIRO", estado_db: "RETIRADO", zona: null, hora: "22:16", andata_min: null, n_pizze: 2, forno_out_db: "22:16" },
  // DOMICILIO — cluster Q1 20:30 (#008 = 4 pizze!), cluster Q1 22:40, Q5 lunga
  { id: "#008", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "20:30", andata_min: 8, n_pizze: 4, forno_out_db: "20:22" },
  { id: "#003", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "20:30", andata_min: 8, n_pizze: 2, forno_out_db: "20:22" },
  { id: "#011", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "21:10", andata_min: 8, n_pizze: 2, forno_out_db: "21:02" },
  { id: "#018", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q5", hora: "22:00", andata_min: 28, n_pizze: 2, forno_out_db: "21:32" },
  { id: "#022", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:40", andata_min: 8, n_pizze: 2, forno_out_db: "22:32" },
  { id: "#024", tipo_consegna: "DOMICILIO", estado_db: "RETIRADO", zona: "Q1", hora: "22:40", andata_min: 8, n_pizze: 1, forno_out_db: "22:32" },
];
module.exports = { fecha: "2026-05-30", source: "backup_serata.ordini (read-only)", manual_giros: [], driver: null, orders };
