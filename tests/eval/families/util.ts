import type { FileMap } from "../core/task-spec.js";

/** JSON string literal suitable for embedding in generated source. */
export const lit = (value: unknown): string => JSON.stringify(value);

export const pyLit = (value: unknown): string => {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyLit).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${pyLit(v)}`).join(", ")}}`;
  return String(value);
};

export const jsPackage = (name: string, test: string): string =>
  `${JSON.stringify({ name, version: "1.0.0", private: true, scripts: { test } }, null, 2)}\n`;

/** Replace exactly one occurrence of `from` in `source`; throws if it is absent or ambiguous. */
export function mutate(source: string, from: string, to: string): string {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + 1) >= 0) throw new Error(`mutation anchor must occur exactly once: ${from}`);
  return source.replace(from, to);
}

export function overlay(base: FileMap, patch: FileMap): FileMap {
  return { ...base, ...patch };
}

/** JS Math.round for positive numbers, used to mirror generated JS in TypeScript. */
export const round2 = (v: number): number => Math.round(v * 100) / 100;

export const money = (v: number): string => v.toFixed(2);
