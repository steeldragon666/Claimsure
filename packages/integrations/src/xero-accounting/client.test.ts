import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { parseXeroDate, xeroAccountingGet, type XeroAccountingClientOptions } from './client.js';

const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const XERO_API_HOST = 'https://api.xero.com';
const XERO_API_PATH = '/api.xro/2.0';

const opts = (): XeroAccountingClientOptions => ({
  access_token: 'fake-xero-access',
  xero_tenant_id: TENANT_ID,
});

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

// -- xeroAccountingGet: header propagation ----------------------------

test('xeroAccountingGet: sends Authorization, Xero-tenant-id, Accept headers', async () => {
  let capturedAuth: string | undefined;
  let capturedTenant: string | undefined;
  let capturedAccept: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Invoices`)
    .matchHeader('authorization', (val: string | string[]) => {
      capturedAuth = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .matchHeader('xero-tenant-id', (val: string | string[]) => {
      capturedTenant = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .matchHeader('accept', (val: string | string[]) => {
      capturedAccept = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, { Invoices: [] });

  await xeroAccountingGet(opts(), '/Invoices');
  assert.equal(capturedAuth, 'Bearer fake-xero-access');
  assert.equal(capturedTenant, TENANT_ID);
  assert.equal(capturedAccept, 'application/json');
});

// -- xeroAccountingGet: query string handling -------------------------

test('xeroAccountingGet: builds query string from query map (special chars)', async () => {
  let capturedUrl: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Invoices`)
    .query(true)
    .reply(200, function (uri) {
      capturedUrl = uri;
      return { Invoices: [] };
    });

  await xeroAccountingGet(opts(), '/Invoices', {
    where: 'Status=="AUTHORISED" AND Date>=DateTime(2026,1,1)',
    order: 'Date DESC',
  });
  assert.ok(capturedUrl, 'url captured');
  // URL.searchParams encodes spaces as + and special chars; just verify
  // both keys made it onto the wire.
  assert.match(capturedUrl, /where=/);
  assert.match(capturedUrl, /order=/);
  // Spot-check that the value round-trips through URLSearchParams encoding.
  const u = new URL(`${XERO_API_HOST}${capturedUrl}`);
  assert.equal(u.searchParams.get('where'), 'Status=="AUTHORISED" AND Date>=DateTime(2026,1,1)');
  assert.equal(u.searchParams.get('order'), 'Date DESC');
});

test('xeroAccountingGet: builds query string with multiple keys', async () => {
  let capturedUrl: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query(true)
    .reply(200, function (uri) {
      capturedUrl = uri;
      return { Contacts: [] };
    });

  await xeroAccountingGet(opts(), '/Contacts', {
    page: '2',
    includeArchived: 'true',
    summaryOnly: 'false',
  });
  assert.ok(capturedUrl);
  const u = new URL(`${XERO_API_HOST}${capturedUrl}`);
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('includeArchived'), 'true');
  assert.equal(u.searchParams.get('summaryOnly'), 'false');
});

// -- xeroAccountingGet: extraHeaders ----------------------------------

test('xeroAccountingGet: extraHeaders are forwarded', async () => {
  let capturedIfModified: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Invoices`)
    .matchHeader('if-modified-since', (val: string | string[]) => {
      capturedIfModified = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, { Invoices: [] });

  const since = new Date('2026-04-20T00:00:00Z').toUTCString();
  await xeroAccountingGet(opts(), '/Invoices', undefined, {
    'If-Modified-Since': since,
  });
  assert.equal(capturedIfModified, since);
});

test('xeroAccountingGet: extraHeaders override defaults on overlap', async () => {
  // The spread `{ ...defaults, ...extraHeaders }` means an extraHeader
  // with the same key replaces the default. Document this behaviour.
  let capturedAccept: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Invoices`)
    .matchHeader('accept', (val: string | string[]) => {
      capturedAccept = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, { Invoices: [] });

  await xeroAccountingGet(opts(), '/Invoices', undefined, {
    Accept: 'application/xml',
  });
  assert.equal(capturedAccept, 'application/xml');
});

// -- xeroAccountingGet: error surfacing -------------------------------

test('xeroAccountingGet: 4xx surfaces with descriptive error', { timeout: 60_000 }, async () => {
  // 4xx is non-retryable per Xero's contract — withRetry retries on any
  // thrown error, so a persistent 4xx still exhausts the budget. Use
  // .times(5) to cover all retry attempts.
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Invoices`).times(5).reply(404, 'Resource not found');

  await assert.rejects(
    xeroAccountingGet(opts(), '/Invoices'),
    /xero accounting GET \/Invoices: 404 Resource not found/,
  );
});

test(
  'xeroAccountingGet: persistent 5xx throws after retry budget',
  { timeout: 60_000 },
  async () => {
    nock(XERO_API_HOST).get(`${XERO_API_PATH}/Invoices`).times(5).reply(503, 'service unavailable');

    await assert.rejects(
      xeroAccountingGet(opts(), '/Invoices'),
      /xero accounting GET \/Invoices: 503 service unavailable/,
    );
  },
);

test('xeroAccountingGet: network error surfaces after retries', { timeout: 60_000 }, async () => {
  // A pure network error (replyWithError) IS thrown by fetch, so
  // withRetry exhausts its budget then rethrows the underlying error.
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Invoices`).times(5).replyWithError('ECONNRESET');

  await assert.rejects(xeroAccountingGet(opts(), '/Invoices'), /ECONNRESET/);
});

// -- xeroAccountingGet: success returns parsed JSON -------------------

test('xeroAccountingGet: returns parsed JSON body', async () => {
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Invoices`)
    .reply(200, { Invoices: [{ InvoiceID: 'inv-1', Total: 100 }] });

  const data = (await xeroAccountingGet(opts(), '/Invoices')) as {
    Invoices: Array<{ InvoiceID: string; Total: number }>;
  };
  assert.equal(data.Invoices.length, 1);
  assert.equal(data.Invoices[0]?.InvoiceID, 'inv-1');
  assert.equal(data.Invoices[0]?.Total, 100);
});

// -- parseXeroDate ----------------------------------------------------

test('parseXeroDate: Microsoft JSON Date with UTC offset parses to correct Date', () => {
  // 1640995200000 = 2022-01-01T00:00:00.000Z
  const d = parseXeroDate('/Date(1640995200000+0000)/');
  assert.ok(d instanceof Date);
  assert.equal(d?.toISOString(), '2022-01-01T00:00:00.000Z');
});

test('parseXeroDate: Microsoft JSON Date without offset parses to correct Date', () => {
  const d = parseXeroDate('/Date(1640995200000)/');
  assert.ok(d instanceof Date);
  assert.equal(d?.toISOString(), '2022-01-01T00:00:00.000Z');
});

test('parseXeroDate: Microsoft JSON Date with negative offset uses absolute millis', () => {
  // The +/-NNNN suffix is informational; the millis are absolute.
  const d = parseXeroDate('/Date(1640995200000-0500)/');
  assert.equal(d?.toISOString(), '2022-01-01T00:00:00.000Z');
});

test('parseXeroDate: ISO 8601 fallback', () => {
  const d = parseXeroDate('2022-01-01T00:00:00.000Z');
  assert.ok(d instanceof Date);
  assert.equal(d?.toISOString(), '2022-01-01T00:00:00.000Z');
});

test('parseXeroDate: YYYY-MM-DD (interpreted as UTC midnight)', () => {
  const d = parseXeroDate('2022-01-01');
  assert.ok(d instanceof Date);
  assert.equal(d?.toISOString(), '2022-01-01T00:00:00.000Z');
});

test('parseXeroDate: null / undefined / empty / unparseable → null', () => {
  assert.equal(parseXeroDate(null), null);
  assert.equal(parseXeroDate(undefined), null);
  assert.equal(parseXeroDate(''), null);
  assert.equal(parseXeroDate('not-a-date'), null);
});

test('parseXeroDate: anchored regex rejects substring matches', () => {
  // Regression guard for the regex anchor fix. Pre-fix, the unanchored
  // pattern would substring-match this and silently return new Date(123)
  // (1970-01-01T00:00:00.123Z). Post-fix, the input falls through to
  // `new Date('PrefixGarbage/Date(123)/Suffix')` which is NaN → null.
  assert.equal(parseXeroDate('PrefixGarbage/Date(123)/Suffix'), null);
});

test('parseXeroDate: anchored regex rejects leading garbage before /Date(...)/', () => {
  assert.equal(parseXeroDate('garbage/Date(1640995200000+0000)/'), null);
});

test('parseXeroDate: anchored regex rejects trailing garbage after /Date(...)/', () => {
  assert.equal(parseXeroDate('/Date(1640995200000+0000)/trailing'), null);
});
