import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Module-level singleton for the on-device SQLite handle.
 *
 * Mirrors the @cpa/db client.ts pattern: open once, reuse the handle
 * across the process. SQLite on iOS/Android is happy to multi-read on
 * a single handle; expo-sqlite serializes writes for us.
 *
 * Caller is responsible for `await getDb()` early in the app boot —
 * F15 wires it into the root layout's effect.
 */
export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('cpa-scribe.db');
  return db;
}
