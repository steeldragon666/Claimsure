import { getInstallationToken } from './installation-token.js';

/**
 * GitHub App HTTP-headers factory (Task B.2 / P7).
 *
 * Lazy/minimal factory: returns the HTTP headers a GitHub-API caller
 * needs (Authorization, Accept, version). We deliberately do *not*
 * pull in `@octokit/rest` here — it's not currently in the workspace
 * dep tree, and Task B.5 (the PR-creation task that actually exercises
 * this code) will own the decision about whether to add it.
 *
 * Until then, downstream code can:
 *   const headers = await getGitHubAppHeaders({...});
 *   await fetch('https://api.github.com/repos/...', { headers });
 *
 * If/when B.5 adds `@octokit/rest`, swap this for an Octokit-instance
 * factory backed by `@octokit/auth-app`. The interface boundary
 * (`{ appId, privateKey, installationId } -> auth-bearing client`)
 * stays the same.
 */

export interface CreateOctokitOptions {
  appId: string;
  privateKey: string;
  installationId: string;
  /** DI seam — passed through to `getInstallationToken`. */
  fetch?: typeof globalThis.fetch;
}

export interface GitHubAppHeaders {
  Authorization: string;
  Accept: string;
  'X-GitHub-Api-Version': string;
}

export async function getGitHubAppHeaders(opts: CreateOctokitOptions): Promise<GitHubAppHeaders> {
  const token = await getInstallationToken(opts);
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
