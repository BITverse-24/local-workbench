export function redact(value: string): string {
  return value
    .replace(/sk-or-v1-[a-zA-Z0-9_-]+/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]");
}
export function safeJSON(value: unknown): string { return redact(JSON.stringify(value, null, 2)); }
