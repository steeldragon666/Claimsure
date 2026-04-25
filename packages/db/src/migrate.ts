import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { getDatabaseUrl } from './env.js';

const migrationClient = postgres(getDatabaseUrl(), { max: 1 });

try {
  await migrate(drizzle(migrationClient), { migrationsFolder: './migrations' });
  console.log('migrations applied');
} catch (err) {
  console.error('migration failed:', err);
  process.exitCode = 1;
} finally {
  await migrationClient.end();
}
