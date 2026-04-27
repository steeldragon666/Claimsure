import { MIGRATIONS } from './schema.js';
import { getDb } from './client.js';

/**
 * Idempotent migration runner — call on every app boot.
 *
 * Tracks the highest applied migration index in `_migrations`. Anything
 * after that gets executed and recorded; if the array shrinks (which
 * never legitimately happens — migrations are append-only), nothing
 * tries to "undo".
 *
 * Each migration string can contain multiple statements; expo-sqlite's
 * `execAsync` runs them as a batch. The INSERT into `_migrations` is a
 * separate `runAsync` so we still record progress if a single migration
 * has multiple statements.
 */
export async function runMigrations(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS _migrations (
      idx INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const result = await db.getFirstAsync<{ max_idx: number | null }>(
    'SELECT MAX(idx) as max_idx FROM _migrations',
  );
  const lastApplied = result?.max_idx ?? -1;
  for (let i = lastApplied + 1; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!;
    await db.execAsync(sql);
    await db.runAsync('INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)', i, Date.now());
  }
}
