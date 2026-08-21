"use strict";
// A deliberately small in-memory stand-in for sbSelect, understanding exactly
// the PostgREST filter grammar the economy reader emits and nothing else. Any
// unsupported operator throws rather than silently returning everything —
// a reader that starts emitting a filter this cannot honour must fail loudly
// in tests instead of quietly passing against unfiltered data.
function createMemorySelect(tables, { onCall = () => {} } = {}) {
  return async function select(table, query = "") {
    onCall({ table, query });
    const rows = Array.isArray(tables[table]) ? tables[table].slice() : [];
    let out = rows;
    let orderBy = null;
    for (const part of String(query).split("&").filter(Boolean)) {
      if (part.startsWith("select=")) continue;
      const eq = part.indexOf("=");
      const column = part.slice(0, eq);
      const rest = part.slice(eq + 1);
      if (column === "order") {
        const [col, dir] = rest.split(".");
        orderBy = { column: col, descending: String(dir || "asc").toLowerCase() === "desc" };
        continue;
      }
      if (column === "limit") { out = out.slice(0, Number(rest)); continue; }
      const dot = rest.indexOf(".");
      const op = rest.slice(0, dot);
      const raw = rest.slice(dot + 1);
      if (op === "in") {
        const set = new Set(raw.replace(/^\(|\)$/g, "").split(",").map((v) => decodeURIComponent(v)));
        out = out.filter((r) => set.has(String(r[column])));
      } else if (op === "eq") {
        const value = decodeURIComponent(raw);
        out = out.filter((r) => String(r[column]) === value);
      } else if (op === "gte" || op === "lt" || op === "gt" || op === "lte") {
        const bound = new Date(decodeURIComponent(raw)).getTime();
        out = out.filter((r) => {
          const t = new Date(r[column]).getTime();
          if (!Number.isFinite(t)) return false;
          return op === "gte" ? t >= bound : op === "lt" ? t < bound : op === "gt" ? t > bound : t <= bound;
        });
      } else {
        throw new Error(`postgrestMemorySelect: unsupported operator "${op}" on ${table}.${column}`);
      }
    }
    if (orderBy) {
      out.sort((a, b) => String(a[orderBy.column]).localeCompare(String(b[orderBy.column])));
      if (orderBy.descending) out.reverse();
    }
    return out;
  };
}
module.exports = { createMemorySelect };
