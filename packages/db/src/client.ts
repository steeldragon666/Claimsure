import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://cpa:cpa@localhost:5432/cpa_dev';

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql);
export type Db = typeof db;
