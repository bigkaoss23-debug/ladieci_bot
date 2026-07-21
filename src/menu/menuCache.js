function createMenuCache({ loader, ttlMs = 120000, now = () => Date.now() } = {}) {
  if (typeof loader !== "function") throw new TypeError("menu cache loader is required");
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(loader).then((value) => {
      if (!value || typeof value !== "object") throw new TypeError("invalid menu cache value");
      cached = value;
      cachedAt = now();
      return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function get() {
    if (cached && now() - cachedAt < ttlMs) return { value: cached, state: "fresh" };
    try {
      return { value: await refresh(), state: "fresh" };
    } catch (error) {
      if (cached) return { value: cached, state: "stale", error };
      throw error;
    }
  }

  function clear() { cached = null; cachedAt = 0; }
  return { get, refresh, clear };
}

module.exports = { createMenuCache };
