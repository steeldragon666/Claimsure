import { test, after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nock from 'nock';
import { insertEventWithChain } from '@cpa/db';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildTranscribedPayload, runTranscribeJob } from './transcribe.js';
import * as transcribeMod from './transcribe.js';

// Test isolation IDs — pinned UUIDs so cleanup is precise without
// having to enumerate.
const TENANT = '00000000-0000-4000-8000-0000000a3001';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a3010';
const SUBJECT = '00000000-0000-4000-8000-0000000a3021';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id = ${SUBJECT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  // Deepgram API key needed by runTranscribeJob — set a dummy value;
  // nock intercepts the actual HTTP call so the key isn't sent
  // anywhere.
  process.env['DEEPGRAM_API_KEY'] = 'test-deepgram-key';

  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Firm A', 'firm-a-a3', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a3-admin@example.com', 'microsoft', 'microsoft:a3-admin', 'A3 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme Co', 'claimant')`;
});

after(async () => {
  nock.cleanAll();
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

test('buildTranscribedPayload: returns the v2 voice shape', () => {
  const out = buildTranscribedPayload({
    audio_s3_key: 's3://bucket/abc.m4a',
    text: 'hello world',
    confidence: 0.95,
    duration_seconds: 12.5,
  });
  assert.deepEqual(out, {
    _v: 2,
    source: 'voice',
    audio_s3_key: 's3://bucket/abc.m4a',
    raw_text: 'hello world',
    transcript_confidence: 0.95,
    transcript_duration_seconds: 12.5,
  });
});

test('runTranscribeJob: patches event payload with deepgram transcript', async () => {
  // Seed a placeholder voice_pending event mirroring what /v1/mobile/events
  // (A4) writes at ingest time.
  const audio_s3_key = 's3://bucket/' + crypto.randomUUID() + '.m4a';
  const event = await insertEventWithChain({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    kind: 'SUPPORTING',
    payload: {
      _v: 1,
      source: 'voice_pending',
      audio_s3_key,
      captured_at_local: Date.now(),
    },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: null,
  });

  // Stub getMediaBytes — the placeholder throws by design; tests
  // monkey-patch it via mock.method on the module export.
  const stub = mock.method(transcribeMod, 'getMediaBytes', () =>
    Promise.resolve(Buffer.from([0x00, 0x01, 0x02, 0x03])),
  );

  // Mock Deepgram with nock.
  nock('https://api.deepgram.com')
    .post('/v1/listen')
    .query(true)
    .reply(200, {
      results: { channels: [{ alternatives: [{ transcript: 'we tested X', confidence: 0.93 }] }] },
      metadata: { duration: 8.2 },
    });

  await runTranscribeJob({
    audio_s3_key,
    event_id: event.id,
    audio_mime_type: 'audio/m4a',
  });

  // Verify the payload was patched in place.
  const rows = await privilegedSql<{ payload: { source: string; raw_text: string; transcript_confidence: number; transcript_duration_seconds: number; _v: number } }[]>`
    SELECT payload FROM event WHERE id = ${event.id}
  `;
  assert.equal(rows[0]?.payload.source, 'voice');
  assert.equal(rows[0]?.payload.raw_text, 'we tested X');
  assert.equal(rows[0]?.payload.transcript_confidence, 0.93);
  assert.equal(rows[0]?.payload.transcript_duration_seconds, 8.2);
  assert.equal(rows[0]?.payload._v, 2);

  stub.mock.restore();
});

test('runTranscribeJob: throws when event_id missing', async () => {
  const stub = mock.method(transcribeMod, 'getMediaBytes', () =>
    Promise.resolve(Buffer.from([0x00])),
  );
  nock('https://api.deepgram.com')
    .post('/v1/listen')
    .query(true)
    .reply(200, {
      results: { channels: [{ alternatives: [{ transcript: 'x', confidence: 0.9 }] }] },
      metadata: { duration: 1 },
    });

  await assert.rejects(
    runTranscribeJob({
      audio_s3_key: 's3://bucket/missing.m4a',
      event_id: '00000000-0000-4000-8000-00000000dead',
    }),
    /transcribe: event .* not found/,
  );
  stub.mock.restore();
});

test('runTranscribeJob: surfaces deepgram errors verbatim', async () => {
  const stub = mock.method(transcribeMod, 'getMediaBytes', () =>
    Promise.resolve(Buffer.from([0x00])),
  );
  nock('https://api.deepgram.com')
    .post('/v1/listen')
    .query(true)
    .reply(401, 'unauthorized');

  await assert.rejects(
    runTranscribeJob({
      audio_s3_key: 's3://bucket/x.m4a',
      event_id: '00000000-0000-4000-8000-00000000beef',
    }),
    /deepgram: 401 unauthorized/,
  );
  stub.mock.restore();
});
