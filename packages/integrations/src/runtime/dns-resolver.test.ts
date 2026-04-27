import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCname } from './dns-resolver.js';

/**
 * resolveCname is a one-line passthrough to `dns.promises.resolveCname`.
 * The substantive testing happens at the state-machine layer (C7) via
 * dependency injection — see custom-domain-state-machine.test.ts.
 *
 * Here we just lock the signature: it must reject on a hostname that
 * has no CNAME (Node's resolver throws ENODATA / ENOTFOUND in that case).
 * `localhost` doesn't have a CNAME, so this is stable across CI envs
 * without hitting the network.
 */
test('resolveCname: rejects when hostname has no CNAME record', async () => {
  await assert.rejects(
    () => resolveCname('localhost'),
    (err: NodeJS.ErrnoException) => {
      // Node's DNS error codes: ENODATA / ENOTFOUND / EBADRESP — all
      // acceptable here. We just need to confirm we got a structured
      // error, not a successful resolve.
      assert.ok(typeof err.code === 'string', 'expected a DNS error code');
      return true;
    },
  );
});
