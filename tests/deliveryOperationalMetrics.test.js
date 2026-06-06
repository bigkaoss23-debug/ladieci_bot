// tests/deliveryOperationalMetrics.test.js
// ===============================================================
// Metriche operative delivery (LISTO → EN_ENTREGA) — offline, no DB.
// Fixture sintetiche basate sui casi reali del live 05/06/2026.
// Run: node tests/deliveryOperationalMetrics.test.js
// ===============================================================
"use strict";

const {
  computeDeliveryOperationalMetric,
  summarizeDeliveryOperationalMetrics,
} = require("../src/core/delivery/deliveryOperationalMetrics");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

console.log("══ #019-like: ready_to_exit ~5.4 (watch borderline), trip reale 12 ══");
{
  const m = computeDeliveryOperationalMetric({
    id: "#019", estado: "RETIRADO", zona: "Q1", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T21:55:37",
    en_entrega_at: "2026-06-05T22:01:00",
    retirado_at: "2026-06-05T22:13:02",
    durata_andata_min: 4,
    hora: "22:00",
  });
  check("ready_to_rider_exit_min ≈ 5.4", m.ready_to_rider_exit_min === 5.4, JSON.stringify(m));
  check("status watch", m.ready_to_rider_exit_status === "watch", m.ready_to_rider_exit_status);
  check("consegna stimata 22:05", m.estimated_customer_delivery_from_exit === "22:05", m.estimated_customer_delivery_from_exit);
  check("ritardo cliente ≈ +5", m.estimated_customer_delay_from_exit_min === 5, String(m.estimated_customer_delay_from_exit_min));
  check("giro reale ≈ 12", m.real_trip_min === 12, String(m.real_trip_min));
  check("trip_status closed", m.trip_status === "closed", m.trip_status);
  check("trip_expected ≈ 8 (durata*2)", m.trip_expected_min === 8, String(m.trip_expected_min));
}

console.log("\n══ #006-like: ready_to_exit >10 → late_dispatch_risk ══");
{
  const m = computeDeliveryOperationalMetric({
    id: "#006", estado: "RETIRADO", zona: "Q5", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T20:53:23",
    en_entrega_at: "2026-06-05T21:05:34",
    retirado_at: "2026-06-05T21:15:09",
    durata_andata_min: 13,
    hora: "21:05",
  });
  check("ready_to_rider_exit_min > 10", m.ready_to_rider_exit_min > 10, String(m.ready_to_rider_exit_min));
  check("status late_dispatch_risk", m.ready_to_rider_exit_status === "late_dispatch_risk", m.ready_to_rider_exit_status);
  check("ritardo cliente ≈ +13", m.estimated_customer_delay_from_exit_min === 13.6, String(m.estimated_customer_delay_from_exit_min));
  check("wording operativo non accusatorio rider", /dispatch|attesa|monitorare/i.test(m.ready_to_rider_exit_label), m.ready_to_rider_exit_label);
}

console.log("\n══ Missing en_entrega_at: usa now iniettato ══");
{
  // LISTO da ~12 min, rider non ancora uscito, now iniettato → late_dispatch_risk.
  const late = computeDeliveryOperationalMetric({
    id: "#L", estado: "LISTO", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T20:53:00", durata_andata_min: 13, hora: "21:05",
  }, { now: "21:05" });
  check("LISTO da 12min senza uscita → late_dispatch_risk", late.ready_to_rider_exit_status === "late_dispatch_risk", JSON.stringify(late));
  check("ready_to_rider_exit_min ≈ 12 (attesa accumulata)", late.ready_to_rider_exit_min === 12, String(late.ready_to_rider_exit_min));
  check("trip in_progress non valido (rider non uscito)", late.trip_status === "unknown", late.trip_status);

  // LISTO appena pronto, now iniettato vicino → pending (no late).
  const fresh = computeDeliveryOperationalMetric({
    id: "#F", estado: "LISTO", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T21:04:00", durata_andata_min: 8, hora: "21:10",
  }, { now: "21:05" });
  check("LISTO appena pronto → pending", fresh.ready_to_rider_exit_status === "pending", JSON.stringify(fresh));

  // Senza now → pending/unknown, nessun crash.
  const noNow = computeDeliveryOperationalMetric({
    id: "#N", estado: "LISTO", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T21:04:00", durata_andata_min: 8, hora: "21:10",
  });
  check("LISTO senza now → pending", noNow.ready_to_rider_exit_status === "pending", JSON.stringify(noNow));
}

console.log("\n══ Missing listo_at → unknown ══");
{
  const m = computeDeliveryOperationalMetric({
    id: "#NL", estado: "EN_ENTREGA", tipo_consegna: "DOMICILIO",
    en_entrega_at: "2026-06-05T22:01:00", durata_andata_min: 4, hora: "22:00",
  });
  check("ready status unknown", m.ready_to_rider_exit_status === "unknown", m.ready_to_rider_exit_status);
  check("ready_min null", m.ready_to_rider_exit_min === null, String(m.ready_to_rider_exit_min));
  // consegna stimata resta calcolabile da en_entrega + durata.
  check("consegna stimata comunque calcolata", m.estimated_customer_delivery_from_exit === "22:05", m.estimated_customer_delivery_from_exit);
}

console.log("\n══ RETIRADO prima di EN_ENTREGA → invalid_timing, no crash ══");
{
  const m = computeDeliveryOperationalMetric({
    id: "#BAD", estado: "RETIRADO", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T21:00:00",
    en_entrega_at: "2026-06-05T21:10:00",
    retirado_at: "2026-06-05T21:05:00", // PRIMA dell'uscita
    durata_andata_min: 5, hora: "21:15",
  });
  check("trip_status invalid_timing", m.trip_status === "invalid_timing", m.trip_status);
  check("real_trip_min resta null (no negativo)", m.real_trip_min === null, String(m.real_trip_min));
  // EN_ENTREGA prima di LISTO → ready invalid_timing
  const m2 = computeDeliveryOperationalMetric({
    id: "#BAD2", estado: "EN_ENTREGA", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T21:10:00", en_entrega_at: "2026-06-05T21:00:00",
    durata_andata_min: 5, hora: "21:15",
  });
  check("ready invalid_timing se uscita prima di pronto", m2.ready_to_rider_exit_status === "invalid_timing", m2.ready_to_rider_exit_status);
}

console.log("\n══ No PII in output ══");
{
  const m = computeDeliveryOperationalMetric({
    id: "#019", estado: "RETIRADO", zona: "Q1", tipo_consegna: "DOMICILIO",
    listo_at: "2026-06-05T21:55:37", en_entrega_at: "2026-06-05T22:01:00",
    retirado_at: "2026-06-05T22:13:02", durata_andata_min: 4, hora: "22:00",
    nombre: "Cliente Secreto", telefono: "+34666111222", direccion: "Calle Privada 9",
    items: [{ n: "Diavola", q: 1 }], wa_id: "wa-secret",
  });
  const out = JSON.stringify(m);
  check("output non contiene nome/tel/indirizzo/items/wa_id",
    !/Cliente Secreto|\+34666111222|Calle Privada|Diavola|wa-secret/.test(out), out);
  check("output espone solo campi operativi (id/zona/estado/numeri)",
    m.orderId === "#019" && m.zona === "Q1" && m.estado === "RETIRADO" &&
      Object.keys(m).every((k) => !/nombre|tel|direccion|items|wa_id|cliente/i.test(k)),
    Object.keys(m).join(","));
}

console.log("\n══ Non-DOMICILIO escluso, RITIRO non applicabile ══");
{
  const m = computeDeliveryOperationalMetric({ id: "#R", tipo_consegna: "RITIRO", estado: "RETIRADO" });
  check("RITIRO applicable:false", m.applicable === false && m.reason === "not_domicilio", JSON.stringify(m));
}

console.log("\n══ Aggregato summarize conta late_dispatch_risk ══");
{
  const s = summarizeDeliveryOperationalMetrics([
    { id: "#006", tipo_consegna: "DOMICILIO", listo_at: "2026-06-05T20:53:23", en_entrega_at: "2026-06-05T21:05:34", retirado_at: "2026-06-05T21:15:09", durata_andata_min: 13, hora: "21:05" },
    { id: "#019", tipo_consegna: "DOMICILIO", listo_at: "2026-06-05T21:55:37", en_entrega_at: "2026-06-05T22:01:00", retirado_at: "2026-06-05T22:13:02", durata_andata_min: 4, hora: "22:00" },
    { id: "#R", tipo_consegna: "RITIRO", estado: "RETIRADO" },
  ], {});
  check("deliveryCount = 2 (RITIRO escluso)", s.deliveryCount === 2, String(s.deliveryCount));
  check("lateDispatchRiskCount = 1 (#006)", s.lateDispatchRiskCount === 1, JSON.stringify(s.readyToExitStatusCounts));
  check("watch count = 1 (#019)", s.readyToExitStatusCounts.watch === 1, JSON.stringify(s.readyToExitStatusCounts));
}

console.log("\n══ Static safety: helper puro (no DB/fetch/env/PII-leak) ══");
{
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../src/core/delivery/deliveryOperationalMetrics"), "utf8");
  const strip = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("nessun require di supabase/fetch/axios", !/supabase|node-fetch|axios/.test(strip), "");
  check("nessun process.env", !/process\.env/.test(strip), "");
  check("nessun metodo di scrittura DB", !/\b(ins|up|del)(ert|date|sert|ete)\b/i.test(strip.replace(/update_at|updated_at/gi, "")), "");
  check("nessun fetch(", !/\bfetch\s*\(/.test(strip), "");
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
