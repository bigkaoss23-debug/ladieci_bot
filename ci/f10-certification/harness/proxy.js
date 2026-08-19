"use strict";
// F-10.3C CI-ONLY: transparent path-prefix proxy.
//
// supabaseTransport.js (real application code, unmodified) always calls
// `${SUPABASE_URL}/rest/v1/${resource}`. Standalone PostgREST serves its
// API at its own root `/`, not `/rest/v1/`. This proxy exists SOLELY to
// translate that one path prefix so the REAL transport code can run
// against a REAL PostgREST instance unmodified.
//
// It does exactly one thing: strip a literal `/rest/v1/` (or `/rest/v1`)
// prefix from the incoming request path, then forward method/headers/body
// to PostgREST verbatim, and stream PostgREST's response back verbatim
// (status, headers, body) with ZERO interpretation. It never parses JSON,
// never inspects the body, never rewrites a status code, never invents a
// response. If PostgREST is unreachable, the proxy request itself fails
// the same way a direct connection would (ECONNREFUSED etc.) -- it does
// not convert that into a synthetic success or a synthetic DB-shaped
// error body.
//
// Also serves requests OUTSIDE the /rest/v1/ prefix (e.g. the CI-only
// overlap probe, which the harness calls directly) by forwarding them
// unprefixed, unchanged -- same pure passthrough, just no prefix to strip.
//
// PHASE 9 EVIDENCE (request-count proof): additionally appends one
// best-effort, sanitized JSON line per request to PROXY_LOG_FILE (if set) --
// method, stripped path, and, ONLY for a POST to ordenes, the client_req_id
// read out of the already-buffered body (read-only; the buffer that is
// actually forwarded upstream is never touched by this). Logging failures
// are swallowed and never affect the forwarded request -- this is
// observability bolted on AFTER the real proxying decision is already made,
// never a precondition for it.

const http = require("http");
const fs = require("fs");

const LISTEN_PORT = Number(process.env.PROXY_PORT || 8091);
const UPSTREAM = process.env.PROXY_UPSTREAM || "http://127.0.0.1:3000";
const LOG_FILE = process.env.PROXY_LOG_FILE || null;
const upstreamUrl = new URL(UPSTREAM);

function stripPrefix(path) {
  if (path === "/rest/v1" || path.startsWith("/rest/v1/")) {
    const rest = path.slice("/rest/v1".length);
    return rest === "" ? "/" : rest;
  }
  return path;
}

function logRequest(method, targetPath, body) {
  if (!LOG_FILE) return;
  try {
    const pathOnly = targetPath.split("?")[0];
    const entry = { ts: new Date().toISOString(), method, path: pathOnly };
    if (method === "POST" && pathOnly === "/ordenes" && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        entry.client_req_id = parsed && parsed.client_req_id ? parsed.client_req_id : null;
      } catch (_) { /* not JSON or not parseable -- omit client_req_id, still log the request itself */ }
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (_) { /* logging must never affect the real proxied request */ }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const targetPath = stripPrefix(req.url);
    logRequest(req.method, targetPath, body);

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    if (body.length > 0) headers["content-length"] = String(body.length);

    const options = {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      path: targetPath,
      method: req.method,
      headers,
    };

    const upstreamReq = http.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy upstream error: " + (err && err.message));
    });

    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[proxy] listening on 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM} (strips /rest/v1 prefix only)`);
});
