"use strict";
// F-10.3C Phase 11 — TRUE OVERLAP CONTROL PROBE. Proves two genuinely
// distinct Node OS processes, over real HTTP, through the real proxy, into
// real PostgREST, into real Postgres lock contention -- BEFORE any
// lifecycle concurrency scenario below is trusted.
const { fork } = require("child_process");
const path = require("path");

async function runOverlapProbe() {
  const a = fork(path.join(__dirname, "childOverlapProbe.js"), ["A", "3"]);
  const b = fork(path.join(__dirname, "childOverlapProbe.js"), ["B", "0"]);

  const aResult = new Promise((resolve, reject) => {
    a.on("message", resolve);
    a.on("error", reject);
  });
  const bResult = new Promise((resolve, reject) => {
    b.on("message", resolve);
    b.on("error", reject);
  });

  // Let both children finish installing their 'message' listener before we
  // release the barrier (fork() IPC is set up synchronously by the time
  // fork() returns, so a short delay is generous, not load-bearing).
  await new Promise((r) => setTimeout(r, 300));
  a.send("GO");
  b.send("GO");

  const [ra, rb] = await Promise.all([aResult, bResult]);

  const pidsDiffer = ra.pid !== rb.pid;
  const bAttemptBeforeARelease = rb.sendAt < ra.body.released_at;
  const bAcquireAfterARelease = rb.body.acquired_at >= ra.body.released_at;
  const overlapProven = pidsDiffer && bAttemptBeforeARelease && bAcquireAfterARelease;

  return {
    processAPid: ra.pid,
    processBPid: rb.pid,
    pidsDiffer,
    a: { sendAt: ra.sendAt, recvAt: ra.recvAt, acquiredAt: ra.body.acquired_at, releasedAt: ra.body.released_at },
    b: { sendAt: rb.sendAt, recvAt: rb.recvAt, acquiredAt: rb.body.acquired_at, releasedAt: rb.body.released_at },
    bAttemptBeforeARelease,
    bAcquireAfterARelease,
    overlapProven,
  };
}

if (require.main === module) {
  runOverlapProbe()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.overlapProven ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { runOverlapProbe };
