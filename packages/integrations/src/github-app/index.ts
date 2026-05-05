// GitHub App auth surface (Task B.2 / P7).
//
// Two-tier auth model: mint a short-lived App JWT, exchange it for a
// per-installation access token, cache the result. See module-level
// docs in jwt.ts and installation-token.ts.
export { createAppJwt, type CreateAppJwtOptions } from './jwt.js';
export { getInstallationToken, type GetInstallationTokenOptions } from './installation-token.js';
export {
  getGitHubAppHeaders,
  type CreateOctokitOptions,
  type GitHubAppHeaders,
} from './octokit-factory.js';

// PR-creation choreography (Task B.5 / P7). Atomic multi-file commit
// with rollback on any failure between branch-creation and PR-open.
// The single trusted code path that turns a B.4 evaluator's
// PromptSuggestionEvaluation into a real branch + draft PR.
export {
  generatePullRequest,
  renderSuggestionPrBody,
  branchNameFor,
  ChoreographyError,
  type ChoreographyOptions,
  type ChoreographyResult,
  type ChoreographyChangedFile,
  type ChoreographyStage,
  type ContractTestResult,
  type ContractTestRunner,
  type PromptSuggestionForChoreography,
} from './pr-choreography.js';
