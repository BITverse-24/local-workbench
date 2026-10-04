// Phase DB.2 — Settings store (backend/src/main/persistence/settings-store.ts).
// Single row per key; upsert on change. Never stores secrets. Values are JSON-encoded.

import { getDb, prepareCached } from "./db.js";

/** Read a setting; JSON-decodes the stored value. Returns undefined when missing. */
export function getSetting<T = unknown>(key: string): T | undefined {
  const db = getDb();
  const row = prepareCached(db, "SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

/** Upsert a setting (JSON-encoded) + bump updated_at. */
export function setSetting(key: string, value: unknown): void {
  const db = getDb();
  prepareCached(
    db,
    "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), new Date().toISOString());
}
