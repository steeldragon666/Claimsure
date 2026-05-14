/**
 * Public surface of the application-drafter module.
 *
 * Consumers in apps/api import the factory + types via @cpa/agents and
 * never reach into the implementation files directly.
 */
export { makeApplicationDrafter } from './factory.js';
export {
  HypothesisRegisterEntry,
  FailureRegisterEntry,
  NewKnowledgeRegisterEntry,
} from './types.js';
export type {
  ApplicationDraft,
  ApplicationDrafter,
  ApplicationDrafterInput,
  ApplicationDrafterResult,
  ApplicationDrafterUsage,
  CoreActivityRecord,
  SupportingActivityRecord,
  HypothesisRegisterEntry as HypothesisRegisterEntryType,
  FailureRegisterEntry as FailureRegisterEntryType,
  NewKnowledgeRegisterEntry as NewKnowledgeRegisterEntryType,
} from './types.js';
