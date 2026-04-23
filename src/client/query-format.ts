export function formatQuery(sql: string, values?: ReadonlyArray<unknown>): string {
  if (!values || values.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= values.length) return "?";
    return escape(values[i++]);
  });
}

export function escape(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : escapeString(String(v));
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return escapeString(v);
  if (v instanceof Date) return escapeString(formatDate(v));
  if (v instanceof Uint8Array) return escapeBytes(v);
  if (Array.isArray(v)) return `(${v.map(escape).join(", ")})`;
  return escapeString(JSON.stringify(v));
}

function escapeString(s: string): string {
  let out = "'";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x00:
        out += "\\0";
        continue;
      case 0x08:
        out += "\\b";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      case 0x1a:
        out += "\\Z";
        continue;
      case 0x22:
        out += '\\"';
        continue;
      case 0x27:
        out += "\\'";
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      default:
        out += s[i];
    }
  }
  out += "'";
  return out;
}

function escapeBytes(b: Uint8Array): string {
  let hex = "";
  for (const byte of b) hex += byte.toString(16).padStart(2, "0");
  return `X'${hex}'`;
}

function formatDate(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
