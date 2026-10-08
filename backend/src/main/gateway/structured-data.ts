import JSON5 from "json5";

// Some local models put shell/Python comments between JSON tokens. Remove only
// that comment syntax, never characters inside strings or other comments.
function stripHashComments(raw: string): string {
  let output = "", quote = "", escaped = false, lineComment = false, blockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i], next = raw[i + 1];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (lineComment) {
      output += char;
      if (char === "\n" || char === "\r") lineComment = false;
    } else if (blockComment) {
      output += char;
      if (char === "*" && next === "/") { output += next; i++; blockComment = false; }
    } else if (char === '"' || char === "'") {
      quote = char; output += char;
    } else if (char === "/" && next === "/") {
      lineComment = true; output += char;
    } else if (char === "/" && next === "*") {
      blockComment = true; output += char;
    } else if (char === "#") {
      while (i + 1 < raw.length && raw[i + 1] !== "\n" && raw[i + 1] !== "\r") i++;
    } else output += char;
  }
  return output;
}

/** Decode a complete data value without evaluating code or changing string escapes. */
export function parseStructuredData(raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    try { value = JSON5.parse(raw); } catch { value = JSON5.parse(stripHashComments(raw)); }
  }
  const check = (item: unknown): void => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite JSON value");
    if (item !== null && typeof item === "object") Object.values(item).forEach(check);
  };
  check(value);
  return value;
}
