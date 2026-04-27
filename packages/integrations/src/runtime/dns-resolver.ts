import dns from 'node:dns/promises';

/**
 * Thin wrapper around `dns.promises.resolveCname` (T-C7).
 *
 * Hosted in @cpa/integrations/runtime so callers in apps/api don't
 * import `node:dns` directly — keeps the dependency surface there
 * tidy and makes mocking trivial: tests pass an alternate
 * implementation through `advanceCustomDomainState`'s `deps` argument
 * rather than reaching for module-level mocking.
 *
 * Returns the array of CNAME targets the resolver returned (typically
 * just one). Throws on resolver errors (NXDOMAIN, ENODATA, network
 * timeouts) — callers decide whether the absence of a record means
 * "not yet propagated" (retry) or "user typo" (transition to failed).
 */
export async function resolveCname(hostname: string): Promise<string[]> {
  return dns.resolveCname(hostname);
}

/**
 * Resolver type, exported so callers can declare dependency-injection
 * holes that take "anything that resolves CNAMEs" rather than the
 * concrete implementation. The state-machine job uses this to accept
 * a test stub without importing `node:dns`.
 */
export type CnameResolver = (hostname: string) => Promise<string[]>;
