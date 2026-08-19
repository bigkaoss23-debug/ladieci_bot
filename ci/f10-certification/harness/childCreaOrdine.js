"use strict";
// F-10.3C CI-ONLY child process (Phase 15 -- THE DECISIVE TEST). Waits for
// the parent's 'GO' barrier message, then calls the REAL, unmodified
// creaOrdine(...) from the certified backend checkout. Never calls the
// resolver or recovery manually -- creaOrdine's own real retry logic is
// exercised exactly as a live client would trigger it.

const backendDir = process.env.F10_BACKEND_DIR;
if (!backendDir) {
  console.error("F10_BACKEND_DIR not set");
  process.exit(1);
}

const label = process.argv[2];
const clientReqId = process.argv[3];

const { creaOrdine } = require(require("path").join(backendDir, "src/agents/agentOrdini"));

process.on("message", async (msg) => {
  if (msg !== "GO") return;
  const sendAt = new Date().toISOString();
  let result;
  try {
    result = await creaOrdine({
      operatorManual: true,
      tipo_consegna: "RITIRO",
      canal: "MANUAL",
      hora: "13:00",
      nombre: `F10 CI ${label}`,
      tel: "",
      client_req_id: clientReqId,
      items: [{ n: `F10 CI Test Item ${label}`, p: 10 }],
    });
  } catch (e) {
    result = { success: false, error: "CHILD_THREW", detail: String((e && e.message) || e) };
  }
  const recvAt = new Date().toISOString();
  process.send({ label, pid: process.pid, clientReqId, sendAt, recvAt, result });
  process.exit(0);
});
