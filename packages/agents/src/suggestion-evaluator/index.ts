/**
 * `@cpa/agents/suggestion-evaluator` barrel.
 *
 * Re-exports types, repo-tool implementations, and the read-only Anthropic
 * tool definitions. The side-effect import at the bottom registers the
 * `prompt-suggestion-evaluate@1.0.0` prompt module on package import so
 * downstream consumers (Task B.5 choreography) don't have to remember to
 * import the prompt file themselves.
 */

export * from './types.js';
export {
  repoTools,
  assertPathInsideRepo,
  sanitiseSubprocessArg,
  readFile,
  listDirectory,
  searchCode,
  runContractTestSubprocess,
  dispatchRepoTool,
  SUBPROCESS_TIMEOUT_MS,
} from './repo-tools.js';
export type { RepoToolName } from './repo-tools.js';
export { SYSTEM_PROMPT } from './prompts/prompt-suggestion-evaluate@1.0.0.js';

// Side-effect import: registers `prompt-suggestion-evaluate@1.0.0` in the
// runtime prompt registry. Mirrors the pattern in
// `classifier-expenditure/index.ts` and `synthesizer-register/index.ts`.
import './prompts/prompt-suggestion-evaluate@1.0.0.js';
