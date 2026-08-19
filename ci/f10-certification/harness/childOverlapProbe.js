"use strict";
// F-10.3C CI-ONLY child process (Phase 11). Waits for the parent's 'GO'
// barrier message, then calls the CI-only overlap-probe RPC directly via
// fetch (through the /rest/v1 proxy, exactly like the real application
// would reach PostgREST -- but this specific RPC is CI-only harness
// plumbing, not part of any real application code path, so it is called
// directly rather than through supabaseTransport.js).

const label = process.argv[2];
const holdSeconds = Number(process.argv[3] || 0);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

process.on("message", async (msg) => {
  if (msg !== "GO") return;
  const sendAt = new Date().toISOString();
  let result;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/f10_cert_overlap_probe_v1`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: "Bearer " + supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_hold_seconds: holdSeconds, p_label: label }),
    });
    const body = await res.json();
    const recvAt = new Date().toISOString();
    result = { ok: res.ok, status: res.status, body, sendAt, recvAt };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e), sendAt, recvAt: new Date().toISOString() };
  }
  process.send({ label, pid: process.pid, ...result });
  process.exit(0);
});
