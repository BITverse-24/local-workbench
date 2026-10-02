import JSON5 from "json5";

/** Decode a complete data value without evaluating code or changing string escapes. */
export function parseStructuredData(raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = JSON5.parse(raw); }
  const check = (item: unknown): void => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite JSON value");
    if (item !== null && typeof item === "object") Object.values(item).forEach(check);
  };
  check(value);
  return value;
}
