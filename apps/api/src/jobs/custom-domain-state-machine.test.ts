import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import type { CnameResolver } from '@cpa/integrations/runtime';
import { advanceCustomDomainState } from './custom-domain-state-machine.js';

const TENANT_ID = '00000000-0000-4000-8000-0000000c7001';
const EXPECTED_TARGET = 'platform-cnames.platform.com.au';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_ID}`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_ID}, 'C7 Test Firm', 'c7-test', 'mixed')`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const setRow = async (
  custom_domain: string | null,
  custom_domain_status: 'unconfigured' | 'cname_pending' | 'cert_pending' | 'active' | 'failed',
): Promise<void> => {
  await privilegedSql`
    INSERT INTO brand_config (tenant_id, display_name, custom_domain, custom_domain_status)
    VALUES (${TENANT_ID}, 'C7 Test', ${custom_domain}, ${custom_domain_status})
    ON CONFLICT (tenant_id) DO UPDATE
       SET custom_domain = EXCLUDED.custom_domain,
           custom_domain_status = EXCLUDED.custom_domain_status,
           custom_domain_acm_arn = NULL
  `;
};

const stubResolver =
  (cnames: string[]): CnameResolver =>
  () =>
    Promise.resolve(cnames);
const errorResolver = (): CnameResolver => () => Promise.reject(new Error('ENODATA'));

test('cname_pending + matching CNAME → transitions to cert_pending', async () => {
  await setRow('platform.acme.example.com', 'cname_pending');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver([EXPECTED_TARGET]),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'cert_pending');
  assert.equal(result.transitioned, true);

  const rows = await privilegedSql<{ custom_domain_status: string }[]>`
    SELECT custom_domain_status FROM brand_config WHERE tenant_id = ${TENANT_ID}
  `;
  assert.equal(rows[0]?.custom_domain_status, 'cert_pending');
});

test('cname_pending + matching CNAME with trailing dot → transitions to cert_pending', async () => {
  await setRow('platform.acme.example.com', 'cname_pending');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver([`${EXPECTED_TARGET}.`]),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'cert_pending');
  assert.equal(result.transitioned, true);
});

test('cname_pending + non-matching CNAME → stays', async () => {
  await setRow('platform.acme.example.com', 'cname_pending');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver(['some-other-host.example.com']),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'cname_pending');
  assert.equal(result.transitioned, false);
});

test('cname_pending + DNS error → stays', async () => {
  await setRow('platform.acme.example.com', 'cname_pending');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: errorResolver(),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'cname_pending');
  assert.equal(result.transitioned, false);
});

test('cert_pending → transitions to active with placeholder ARN', async () => {
  await setRow('platform.acme.example.com', 'cert_pending');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver([]),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'active');
  assert.equal(result.transitioned, true);

  const rows = await privilegedSql<
    {
      custom_domain_status: string;
      custom_domain_acm_arn: string | null;
    }[]
  >`
    SELECT custom_domain_status, custom_domain_acm_arn
      FROM brand_config WHERE tenant_id = ${TENANT_ID}
  `;
  assert.equal(rows[0]?.custom_domain_status, 'active');
  assert.equal(rows[0]?.custom_domain_acm_arn, `arn:aws:acm:placeholder:tenant/${TENANT_ID}`);
});

test('active → no-op', async () => {
  await setRow('platform.acme.example.com', 'active');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver([]),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'active');
  assert.equal(result.transitioned, false);
});

test('failed → no-op', async () => {
  await setRow('platform.acme.example.com', 'failed');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver([]),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.transitioned, false);
});

test('unconfigured (NULL custom_domain) → no-op', async () => {
  await setRow(null, 'unconfigured');
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver([]),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.transitioned, false);
});

test('no row at all → returns unconfigured', async () => {
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id = ${TENANT_ID}`;
  const result = await advanceCustomDomainState(TENANT_ID, {
    resolveCname: stubResolver([]),
    expectedTarget: EXPECTED_TARGET,
  });
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.transitioned, false);
});
