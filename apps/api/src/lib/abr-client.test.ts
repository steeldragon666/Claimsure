import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupAbrMatchingNames } from './abr-client.js';

/**
 * The ABR client uses a fetchImpl seam rather than nock so we don't have to
 * bring nock into apps/api just for these tests. Each test supplies its own
 * fake fetch.
 */

function fakeFetch(responder: (url: string) => Response | Promise<Response>): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  };
  return impl;
}

test('lookupAbrMatchingNames: returns skipped when no GUID provided', async () => {
  const out = await lookupAbrMatchingNames('Acme R&D', { guid: undefined });
  assert.equal(out.skipped, true);
  assert.deepEqual(out.matches, []);
  assert.equal(out.error, null);
});

test('lookupAbrMatchingNames: parses PascalCase Names array', async () => {
  const body = JSON.stringify({
    Names: [
      {
        Name: 'Acme Pty Ltd',
        Abn: '12345678901',
        EntityType: 'Australian Private Company',
        AbnStatus: 'Active',
        State: 'NSW',
      },
      {
        Name: 'Acme Holdings Pty Ltd',
        Abn: '99999999999',
        EntityType: 'Trust',
        AbnStatus: 'Active',
        State: 'VIC',
      },
    ],
  });
  const out = await lookupAbrMatchingNames('Acme', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => new Response(body, { status: 200 })),
  });
  assert.equal(out.skipped, false);
  assert.equal(out.matches.length, 2);
  assert.equal(out.matches[0]?.matched_name, 'Acme Pty Ltd');
  assert.equal(out.matches[0]?.abn, '12345678901');
  assert.equal(out.matches[0]?.entity_type, 'Australian Private Company');
  assert.equal(out.matches[0]?.abn_status, 'Active');
  assert.equal(out.matches[0]?.registration_state, 'NSW');
  assert.equal(out.error, null);
});

test('lookupAbrMatchingNames: strips JSONP wrapper if present', async () => {
  const body = `callback(${JSON.stringify({ Names: [{ Name: 'Wrapped Pty Ltd' }] })})`;
  const out = await lookupAbrMatchingNames('Wrapped', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => new Response(body, { status: 200 })),
  });
  assert.equal(out.error, null);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0]?.matched_name, 'Wrapped Pty Ltd');
});

test('lookupAbrMatchingNames: strips JSONP wrapper with trailing semicolon', async () => {
  // Real ABR deployments return either `callback(<json>)` or `callback(<json>);`.
  // The original regex matched only the no-semicolon form; this test guards the
  // fix that tolerates both.
  const body = `callback(${JSON.stringify({ Names: [{ Name: 'Trailing Pty Ltd' }] })});`;
  const out = await lookupAbrMatchingNames('Trailing', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => new Response(body, { status: 200 })),
  });
  assert.equal(out.error, null);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0]?.matched_name, 'Trailing Pty Ltd');
});

test('lookupAbrMatchingNames: URL includes callback=callback so JSONP-strip is exercised', async () => {
  let capturedUrl = '';
  await lookupAbrMatchingNames('Acme', {
    guid: 'test-guid',
    fetchImpl: fakeFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ Names: [] }), { status: 200 });
    }),
  });
  // ABR returns JSONP whenever callback=<name> is set, so we send `callback`
  // explicitly to make the parse path stable.
  assert.ok(
    capturedUrl.includes('callback=callback'),
    `URL should request JSONP wrap; got ${capturedUrl}`,
  );
});

test('lookupAbrMatchingNames: returns error on non-200 status (matches empty)', async () => {
  const out = await lookupAbrMatchingNames('Acme', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => new Response('upstream error', { status: 503 })),
  });
  assert.equal(out.skipped, false);
  assert.deepEqual(out.matches, []);
  assert.ok(out.error?.includes('HTTP 503'));
});

test('lookupAbrMatchingNames: returns error on unparseable body', async () => {
  const out = await lookupAbrMatchingNames('Acme', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => new Response('not-json-at-all', { status: 200 })),
  });
  assert.equal(out.skipped, false);
  assert.deepEqual(out.matches, []);
  assert.ok(out.error?.includes('did not parse'));
});

test('lookupAbrMatchingNames: returns error on fetch throw (network failure)', async () => {
  const out = await lookupAbrMatchingNames('Acme', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => {
      throw new Error('ENETUNREACH');
    }),
  });
  assert.equal(out.skipped, false);
  assert.deepEqual(out.matches, []);
  assert.ok(out.error?.includes('ENETUNREACH'));
});

test('lookupAbrMatchingNames: empty Names array → empty matches, no error', async () => {
  const out = await lookupAbrMatchingNames('Nonexistent', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => new Response(JSON.stringify({ Names: [] }), { status: 200 })),
  });
  assert.equal(out.error, null);
  assert.deepEqual(out.matches, []);
});

test('lookupAbrMatchingNames: missing Names key in response → empty matches', async () => {
  const out = await lookupAbrMatchingNames('Anything', {
    guid: 'test-guid',
    fetchImpl: fakeFetch(() => new Response(JSON.stringify({ foo: 'bar' }), { status: 200 })),
  });
  assert.equal(out.error, null);
  assert.deepEqual(out.matches, []);
});

test('lookupAbrMatchingNames: encodes special characters in firm name', async () => {
  let capturedUrl = '';
  await lookupAbrMatchingNames('Acme R&D / Co.', {
    guid: 'test-guid',
    fetchImpl: fakeFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ Names: [] }), { status: 200 });
    }),
  });
  assert.ok(capturedUrl.includes('name=Acme%20R%26D%20%2F%20Co.'));
  assert.ok(capturedUrl.includes('maxResults=5'));
  assert.ok(capturedUrl.includes('guid=test-guid'));
});
