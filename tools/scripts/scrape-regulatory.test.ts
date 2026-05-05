import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../packages/integrations/src/regulatory/error-classifier.js';

/**
 * D.9 -- RIF daily-cron framework tests.
 *
 * Unit tests for the error classifier. The integration test for the
 * full scrape loop requires DB + registered connectors (D.13); for
 * now we test the framework's classification logic in isolation.
 */

describe('classifyError', () => {
  test('classifies HTTP 429 as rate_limited', () => {
    assert.equal(classifyError(new Error('HTTP 429 Too Many Requests')), 'rate_limited');
  });

  test('classifies rate limit message as rate_limited', () => {
    assert.equal(classifyError(new Error('rate limit exceeded')), 'rate_limited');
  });

  test('classifies parse failures as parse_error', () => {
    assert.equal(classifyError(new Error('Unexpected token < in JSON')), 'parse_error');
  });

  test('classifies syntax errors as parse_error', () => {
    assert.equal(classifyError(new Error('SyntaxError: invalid JSON')), 'parse_error');
  });

  test('classifies ECONNREFUSED as network_error', () => {
    assert.equal(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443')), 'network_error');
  });

  test('classifies ENOTFOUND as network_error', () => {
    assert.equal(classifyError(new Error('getaddrinfo ENOTFOUND example.com')), 'network_error');
  });

  test('classifies ETIMEDOUT as network_error', () => {
    assert.equal(classifyError(new Error('connect ETIMEDOUT')), 'network_error');
  });

  test('classifies fetch failed as network_error', () => {
    assert.equal(classifyError(new Error('fetch failed')), 'network_error');
  });

  test('classifies unknown errors as network_error', () => {
    assert.equal(classifyError(new Error('something totally unexpected')), 'network_error');
  });

  test('classifies non-Error values as network_error', () => {
    assert.equal(classifyError('string error'), 'network_error');
    assert.equal(classifyError(42), 'network_error');
    assert.equal(classifyError(null), 'network_error');
  });
});
