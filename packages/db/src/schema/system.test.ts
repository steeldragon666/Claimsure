import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, sql } from '../client.js';
import { system } from './system.js';

// NB on timestamptz handling: `client.ts` calls `drizzle(sql)`, which
// monkey-patches the postgres-js client by replacing the default parser
// for OIDs 1184/1082/1083/1114 with a passthrough (drizzle does its own
// Date conversion inside its ORM layer). So raw `sql\`...\`` queries on
// this shared client return timestamptz columns as ISO-ish strings, not
// Date objects. Tests assert the string shape; ORM-side reads (db.select)
// would yield Date objects.

const TIMESTAMPTZ_STR = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?\+\d{2}$/;

test('system table accepts an insert and round-trips the value', async () => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO system (id, key, value) VALUES (${id}, 'p0_check', 'ok')`;
  const rows =
    await sql`SELECT key, value, created_at, updated_at, deleted_at FROM system WHERE id = ${id}`;
  assert.equal(rows[0]?.key, 'p0_check');
  assert.equal(rows[0]?.value, 'ok');
  assert.match(rows[0]?.created_at as string, TIMESTAMPTZ_STR);
  assert.match(rows[0]?.updated_at as string, TIMESTAMPTZ_STR);
  assert.equal(rows[0]?.deleted_at, null);
  await sql`DELETE FROM system WHERE id = ${id}`;
});

test('system table id column is a v4 UUID generated app-side via crypto.randomUUID()', () => {
  // We don't insert (DB requires us to provide the id since the default is app-side).
  // This test just asserts that crypto.randomUUID() produces a v4 UUID matching our regex.
  const id = crypto.randomUUID();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('system table round-trips via ORM with Date objects', async () => {
  const id = crypto.randomUUID();
  // Insert via raw SQL (we'll exercise db.insert() once we have a write path that needs it)
  await sql`INSERT INTO system (id, key, value) VALUES (${id}, 'orm_check', 'ok')`;

  // Read via the ORM — drizzle should produce Date objects, not strings
  const rows = await db.select().from(system).where(eq(system.id, id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.key, 'orm_check');
  assert.equal(rows[0]?.value, 'ok');
  assert.ok(rows[0]?.createdAt instanceof Date, 'createdAt should be a Date on ORM read path');
  assert.ok(rows[0]?.updatedAt instanceof Date, 'updatedAt should be a Date on ORM read path');
  assert.equal(rows[0]?.deletedAt, null);

  await sql`DELETE FROM system WHERE id = ${id}`;
});

after(async () => {
  await sql.end();
});
