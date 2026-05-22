import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import {
  listCompanyFiles,
  myobAccountingGet,
  type MyobAccountingClientOptions,
} from './client.js';

const MYOB_HOST = 'https://api.myob.com';
const MYOB_BASE_PATH = '/accountright';

const opts = (): MyobAccountingClientOptions => ({
  access_token: 'fake-myob-access',
  api_key: 'fake-developer-key',
});

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('myobAccountingGet: sends bearer token, API key, version, and accept headers', async () => {
  let capturedAuth: string | undefined;
  let capturedKey: string | undefined;
  let capturedVersion: string | undefined;
  let capturedAccept: string | undefined;

  nock(MYOB_HOST)
    .get(`${MYOB_BASE_PATH}/cf-1/GeneralLedger/Account`)
    .matchHeader('authorization', (val: string | string[]) => {
      capturedAuth = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .matchHeader('x-myobapi-key', (val: string | string[]) => {
      capturedKey = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .matchHeader('x-myobapi-version', (val: string | string[]) => {
      capturedVersion = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .matchHeader('accept', (val: string | string[]) => {
      capturedAccept = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, { Items: [] });

  await myobAccountingGet(opts(), '/cf-1/GeneralLedger/Account');

  assert.equal(capturedAuth, 'Bearer fake-myob-access');
  assert.equal(capturedKey, 'fake-developer-key');
  assert.equal(capturedVersion, 'v2');
  assert.equal(capturedAccept, 'application/json');
});

test('myobAccountingGet: forwards query string and company-file token', async () => {
  let capturedUrl: string | undefined;
  let capturedCompanyFileToken: string | undefined;

  nock(MYOB_HOST)
    .get(`${MYOB_BASE_PATH}/cf-1/Purchase/Bill/Item`)
    .query(true)
    .matchHeader('x-myobapi-cftoken', (val: string | string[]) => {
      capturedCompanyFileToken = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, function (uri) {
      capturedUrl = uri;
      return { Items: [] };
    });

  await myobAccountingGet(
    {
      ...opts(),
      company_file_username: 'Administrator',
      company_file_password: 'secret',
    },
    '/cf-1/Purchase/Bill/Item',
    { '$top': '100', '$skip': '200' },
  );

  assert.ok(capturedUrl);
  const url = new URL(`${MYOB_HOST}${capturedUrl}`);
  assert.equal(url.searchParams.get('$top'), '100');
  assert.equal(url.searchParams.get('$skip'), '200');
  assert.equal(
    capturedCompanyFileToken,
    Buffer.from('Administrator:secret', 'utf8').toString('base64'),
  );
});

test('myobAccountingGet: success returns parsed JSON', async () => {
  nock(MYOB_HOST)
    .get(`${MYOB_BASE_PATH}/cf-1/Sale/Invoice/Item`)
    .reply(200, { Items: [{ UID: 'invoice-1', TotalAmount: 123.45 }] });

  const data = (await myobAccountingGet(opts(), '/cf-1/Sale/Invoice/Item')) as {
    Items: Array<{ UID: string; TotalAmount: number }>;
  };

  assert.equal(data.Items[0]?.UID, 'invoice-1');
  assert.equal(data.Items[0]?.TotalAmount, 123.45);
});

test('myobAccountingGet: errors include provider and path', { timeout: 60_000 }, async () => {
  nock(MYOB_HOST)
    .get(`${MYOB_BASE_PATH}/cf-1/Sale/Invoice/Item`)
    .times(5)
    .reply(401, 'unauthorized');

  await assert.rejects(
    myobAccountingGet(opts(), '/cf-1/Sale/Invoice/Item'),
    /myob accounting GET \/cf-1\/Sale\/Invoice\/Item: 401 unauthorized/,
  );
});

test('listCompanyFiles: maps MYOB company files to internal snake_case shape', async () => {
  nock(MYOB_HOST).get(`${MYOB_BASE_PATH}/`).reply(200, [
    {
      Id: 'cf-1',
      Name: 'Acme R&D Pty Ltd',
      Uri: 'https://api.myob.com/accountright/cf-1',
      ProductId: 'accountright',
    },
  ]);

  const files = await listCompanyFiles(opts());

  assert.deepEqual(files, [
    {
      id: 'cf-1',
      name: 'Acme R&D Pty Ltd',
      uri: 'https://api.myob.com/accountright/cf-1',
      product_id: 'accountright',
    },
  ]);
});

