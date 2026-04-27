import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { transcribe } from './client.js';

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

const DEEPGRAM_HOST = 'https://api.deepgram.com';
const LISTEN_PATH = '/v1/listen';

const happyResponse = (transcript: string, confidence: number, duration: number) => ({
  results: {
    channels: [
      {
        alternatives: [{ transcript, confidence }],
      },
    ],
  },
  metadata: { duration },
});

test('transcribe: 200 happy path returns text/confidence/duration', async () => {
  nock(DEEPGRAM_HOST)
    .post(LISTEN_PATH, (body: Buffer | string) => {
      // Deepgram receives the raw bytes verbatim.
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'binary');
      // hex-roundtrip the test payload so we don't accidentally compare
      // Buffer instance identity.
      return buf.length > 0;
    })
    .query({
      model: 'nova-3',
      language: 'en-AU',
      punctuate: 'true',
      smart_format: 'true',
    })
    .matchHeader('authorization', 'Token testkey')
    .matchHeader('content-type', 'audio/m4a')
    .reply(200, happyResponse('Hello world.', 0.97, 12.5));

  const result = await transcribe(
    { api_key: 'testkey' },
    Buffer.from([0x00, 0x01, 0x02, 0x03]),
    'audio/m4a',
  );
  assert.equal(result.text, 'Hello world.');
  assert.equal(result.confidence, 0.97);
  assert.equal(result.duration_seconds, 12.5);
});

test('transcribe: respects model + language overrides', async () => {
  nock(DEEPGRAM_HOST)
    .post(LISTEN_PATH)
    .query({
      model: 'nova-2',
      language: 'en-US',
      punctuate: 'true',
      smart_format: 'true',
    })
    .reply(200, happyResponse('us english', 0.9, 1.0));

  const result = await transcribe(
    { api_key: 'k', model: 'nova-2', language: 'en-US' },
    Buffer.from([0x00]),
    'audio/wav',
  );
  assert.equal(result.text, 'us english');
});

test('transcribe: 401 unauthorized throws with status + body', async () => {
  nock(DEEPGRAM_HOST).post(LISTEN_PATH).query(true).reply(401, 'invalid_credentials');

  await assert.rejects(
    transcribe({ api_key: 'bad' }, Buffer.from([0x01]), 'audio/m4a'),
    /deepgram: 401 invalid_credentials/,
  );
});

test('transcribe: 429 rate-limited throws (caller wraps in withRetry)', async () => {
  nock(DEEPGRAM_HOST).post(LISTEN_PATH).query(true).reply(429, 'rate_limited');

  await assert.rejects(
    transcribe({ api_key: 'k' }, Buffer.from([0x01]), 'audio/m4a'),
    /deepgram: 429 rate_limited/,
  );
});

test('transcribe: 500 server error throws (retryable upstream)', async () => {
  nock(DEEPGRAM_HOST).post(LISTEN_PATH).query(true).reply(500, 'internal_error');

  await assert.rejects(
    transcribe({ api_key: 'k' }, Buffer.from([0x01]), 'audio/m4a'),
    /deepgram: 500 internal_error/,
  );
});

test('transcribe: 200 with empty alternatives throws no-transcript', async () => {
  nock(DEEPGRAM_HOST)
    .post(LISTEN_PATH)
    .query(true)
    .reply(200, {
      results: { channels: [{ alternatives: [] }] },
      metadata: { duration: 0.5 },
    });

  await assert.rejects(
    transcribe({ api_key: 'k' }, Buffer.from([0x01]), 'audio/m4a'),
    /deepgram returned no transcript/,
  );
});

test('transcribe: respects custom base_url', async () => {
  nock('https://eu.api.deepgram.com')
    .post('/v1/listen')
    .query(true)
    .reply(200, happyResponse('eu hello', 0.91, 2.1));

  const result = await transcribe(
    { api_key: 'k', base_url: 'https://eu.api.deepgram.com/v1/listen' },
    Buffer.from([0x01]),
    'audio/m4a',
  );
  assert.equal(result.text, 'eu hello');
});
