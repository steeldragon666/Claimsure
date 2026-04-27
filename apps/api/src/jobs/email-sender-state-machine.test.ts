import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { advanceEmailSenderState } from './email-sender-state-machine.js';

const TENANT_ID = '00000000-0000-4000-8000-0000000c9001';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_ID}`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_ID}, 'C9 Test Firm', 'c9-test', 'mixed')`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const setRow = async (
  email_sender_domain: string | null,
  email_sender_dkim_status: 'unconfigured' | 'pending' | 'verified' | 'failed',
): Promise<void> => {
  await privilegedSql`
    INSERT INTO brand_config (tenant_id, display_name, email_sender_domain, email_sender_dkim_status)
    VALUES (${TENANT_ID}, 'C9 Test', ${email_sender_domain}, ${email_sender_dkim_status})
    ON CONFLICT (tenant_id) DO UPDATE
       SET email_sender_domain = EXCLUDED.email_sender_domain,
           email_sender_dkim_status = EXCLUDED.email_sender_dkim_status
  `;
};

test('pending → transitions to verified (stub)', async () => {
  await setRow('mail.acme.example.com', 'pending');
  const result = await advanceEmailSenderState(TENANT_ID);
  assert.equal(result.status, 'verified');
  assert.equal(result.transitioned, true);

  const rows = await privilegedSql<{ email_sender_dkim_status: string }[]>`
    SELECT email_sender_dkim_status FROM brand_config WHERE tenant_id = ${TENANT_ID}
  `;
  assert.equal(rows[0]?.email_sender_dkim_status, 'verified');
});

test('verified → no-op', async () => {
  await setRow('mail.acme.example.com', 'verified');
  const result = await advanceEmailSenderState(TENANT_ID);
  assert.equal(result.status, 'verified');
  assert.equal(result.transitioned, false);
});

test('failed → no-op', async () => {
  await setRow('mail.acme.example.com', 'failed');
  const result = await advanceEmailSenderState(TENANT_ID);
  assert.equal(result.status, 'failed');
  assert.equal(result.transitioned, false);
});

test('unconfigured (NULL email_sender_domain) → no-op', async () => {
  await setRow(null, 'unconfigured');
  const result = await advanceEmailSenderState(TENANT_ID);
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.transitioned, false);
});

test('no row at all → returns unconfigured', async () => {
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id = ${TENANT_ID}`;
  const result = await advanceEmailSenderState(TENANT_ID);
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.transitioned, false);
});
