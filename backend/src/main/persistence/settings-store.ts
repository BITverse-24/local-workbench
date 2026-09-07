// Phase DB.2 — Settings store (backend/src/main/persistence/settings-store.ts).
// Single row per key; upsert on change. Never stores secrets. Values are JSON-encoded.

import { getDb } from "./db.js";

/** Read a setting; JSON-decodes the stored value. Returns undefined when missing. */
export function getSetting<T = unknown>(key: string): T | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

/** Upsert a setting (JSON-encoded) + bump updated_at. */
export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}
