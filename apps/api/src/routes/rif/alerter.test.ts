import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendRifAlert, type RifAlertInput, type RifAlertChannels } from './alerter.js';

const makeInput = (severity: RifAlertInput['severity']): RifAlertInput => ({
  severity,
  source: 'ATO Guidance',
  summary: 'New R&DTI eligible-activity ruling published',
  url: 'https://www.ato.gov.au/law/view/document?DocID=RUL/RD2024-1',
});

const makeSpyChannels = (): {
  channels: RifAlertChannels;
  calls: (keyof RifAlertChannels)[];
} => {
  const calls: (keyof RifAlertChannels)[] = [];
  const channels: RifAlertChannels = {
    sendToPagerDuty: (_p) => {
      calls.push('sendToPagerDuty');
      return Promise.resolve();
    },
    sendToSentry: (_p) => {
      calls.push('sendToSentry');
      return Promise.resolve();
    },
    sendToEmailDigest: (_p) => {
      calls.push('sendToEmailDigest');
      return Promise.resolve();
    },
  };
  return { channels, calls };
};

test('sendRifAlert: severity=high routes to page channel', async () => {
  const { channels, calls } = makeSpyChannels();
  await sendRifAlert(makeInput('high'), channels);
  assert.ok(calls.includes('sendToPagerDuty'), 'high must page PagerDuty');
  assert.ok(calls.includes('sendToSentry'), 'high must notify Sentry');
  assert.ok(!calls.includes('sendToEmailDigest'), 'high must NOT email digest');
});

test('sendRifAlert: severity=medium routes to email + sentry', async () => {
  const { channels, calls } = makeSpyChannels();
  await sendRifAlert(makeInput('medium'), channels);
  assert.ok(calls.includes('sendToSentry'), 'medium must notify Sentry');
  assert.ok(calls.includes('sendToEmailDigest'), 'medium must email digest');
  assert.ok(!calls.includes('sendToPagerDuty'), 'medium must NOT page PagerDuty');
});

test('sendRifAlert: severity=low routes to email digest only', async () => {
  const { channels, calls } = makeSpyChannels();
  await sendRifAlert(makeInput('low'), channels);
  assert.ok(calls.includes('sendToEmailDigest'), 'low must email digest');
  assert.ok(!calls.includes('sendToPagerDuty'), 'low must NOT page PagerDuty');
  assert.ok(!calls.includes('sendToSentry'), 'low must NOT notify Sentry');
});
