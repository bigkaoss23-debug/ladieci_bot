"use strict";
// F-10.3C CI-ONLY: zero-dependency HS256 JWT minting for the ephemeral
// PostgREST instance. No new npm dependency added to the real backend
// package.json -- this uses only Node's built-in crypto module.
//
// Usage: node mintJwt.js <secret> <role>
// Prints the token to stdout ONLY. Never logs the secret.

const crypto = require("crypto");

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mint(secret, role) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { role, iat: now, exp: now + 3600 };
  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${sig}`;
}

if (require.main === module) {
  const [secret, role] = process.argv.slice(2);
  if (!secret || !role) {
    console.error("usage: node mintJwt.js <secret> <role>");
    process.exit(1);
  }
  process.stdout.write(mint(secret, role));
}

module.exports = { mint };
