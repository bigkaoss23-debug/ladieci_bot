// ===============================================================
// menuCache.js — Phase 2A in-memory last-good cache (STAGING)
// - configurable TTL (default 120s)
// - concurrent callers share one in-flight fetch
// - successful fetch atomically replaces cache
// - malformed/failed fetch NEVER replaces last-good data
// - stale last-good may be served if the source fails
// - NO hardcoded fallback: cold start + failure fails clearly
// ===============================================================

// factory: loader() must resolve to a validated catalogue or throw.
function createMenuCache({ ttlMs = 120000, loader, now = () => Date.now() } = {}) {
  if (typeof loader !== "function") throw new Error("menuCache: loader required");

  let cached = null;        // last good catalogue
  let cachedAt = 0;         // ms timestamp of last good
  let inFlight = null;      // shared promise

  function meta(state) {
    return { state, age: cached ? now() - cachedAt : null, hasData: !!cached };
  }

  async function refresh() {
    if (inFlight) return inFlight; // share concurrent fetch
    inFlight = (async () => {
      try {
        const data = await loader();
        if (!data || typeof data !== "object") throw new Error("loader returned invalid catalogue");
        cached = data;            // atomic replace only on success
        cachedAt = now();
        return data;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  // Returns { catalogue, meta }. Serves fresh if within TTL; else tries
  // refresh; on refresh failure serves stale last-good if present; if no
  // data at all, throws (never invents a menu / no constants fallback).
  async function get() {
    const fresh = cached && now() - cachedAt < ttlMs;
    if (fresh) return { catalogue: cached, meta: meta("fresh") };
    try {
      const data = await refresh();
      return { catalogue: data, meta: meta("fresh") };
    } catch (err) {
      if (cached) return { catalogue: cached, meta: { ...meta("stale"), error: err.message } };
      throw err; // cold start + failure → fail clearly
    }
  }

  function peek() { return { catalogue: cached, meta: meta(cached ? "cached" : "empty") }; }
  function clear() { cached = null; cachedAt = 0; }

  return { get, refresh, peek, clear };
}

module.exports = { createMenuCache };
