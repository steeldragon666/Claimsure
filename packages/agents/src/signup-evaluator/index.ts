/**
 * Public surface of the signup-evaluator module.
 *
 * Re-exports types, factory, and the concrete classes (the classes are
 * exported so test code in `apps/api` can construct mock evaluators
 * directly rather than going through the env-dispatch factory).
 */

export { makeSignupEvaluator } from './factory.js';
export { OpusSignupEvaluator } from './opus.js';
export { StubSignupEvaluator } from './stub.js';
export type {
  SignupEvaluator,
  SignupEvaluatorInput,
  SignupEvaluatorOutput,
  AbrMatchEntry,
} from './types.js';
