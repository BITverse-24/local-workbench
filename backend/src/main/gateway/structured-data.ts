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

function extractOutermostJson(str: string): string {
  let text = str.trim();
  if (text.startsWith("```")) return text;
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket) && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1);
  }
  return text;
}

/** Decode a complete data value without evaluating code or changing string escapes. */
export function parseStructuredData(raw: string): unknown {
  const parseWithRepairs = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      try {
        return JSON5.parse(text);
      } catch {
        try {
          return JSON5.parse(stripHashComments(text));
        } catch {
          const repaired = text
            .replace(/\}\]\}\]\}\],/g, "}]}],")
            .replace(/\}\}\],/g, "}],");
          try {
            return JSON5.parse(repaired);
          } catch {
            return JSON5.parse(stripHashComments(repaired));
          }
        }
      }
    }
  };

  let value: unknown;
  try {
    value = parseWithRepairs(raw);
  } catch (originalErr) {
    const extracted = extractOutermostJson(raw);
    if (extracted !== raw.trim()) {
      try {
        value = parseWithRepairs(extracted);
      } catch {
        throw originalErr;
      }
    } else {
      throw originalErr;
    }
  }
  const check = (item: unknown): void => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite JSON value");
    if (item !== null && typeof item === "object") Object.values(item).forEach(check);
  };
  check(value);
  return value;
}
