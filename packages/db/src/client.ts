import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getDatabaseUrl, getDatabasePoolMax } from './env.js';

// NB: caller is responsible for `await sql.end()` in short-lived scripts.
// Long-lived processes (apps/api) leave this open intentionally.
export const sql = postgres(getDatabaseUrl(), { max: getDatabasePoolMax() });
export const db = drizzle(sql);
export type Db = typeof db;
