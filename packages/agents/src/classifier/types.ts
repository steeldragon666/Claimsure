/**
 * Evidence-kind taxonomy for the R&D Tax Incentive (R&DTI) classifier.
 *
 * Anchored on Australian Income Tax Assessment Act 1997, Division 355. The
 * full taxonomy includes synthetic kinds emitted by reviewers (`OVERRIDE`)
 * that the model itself never produces; {@link CLASSIFIABLE_KINDS} is the
 * narrower set the classifier is allowed to return.
 */
export const EVIDENCE_KINDS = [
  'HYPOTHESIS',
  'DESIGN',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'UNCERTAINTY',
  'TIME_LOG',
  'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE',
  'SUPPORTING',
  'INELIGIBLE',
  'OVERRIDE',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Subset of {@link EVIDENCE_KINDS} that the classifier can output. `OVERRIDE`
 * is excluded because it represents a human reviewer decision, not a model
 * classification.
 */
export const CLASSIFIABLE_KINDS = [
  'HYPOTHESIS',
  'DESIGN',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'UNCERTAINTY',
  'TIME_LOG',
  'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE',
  'SUPPORTING',
  'INELIGIBLE',
] as const;
export type ClassifiableKind = (typeof CLASSIFIABLE_KINDS)[number];

export type ClassifierInput = { raw_text: string };

export type ClassifierOutput = {
  kind: ClassifiableKind;
  confidence: number;
  rationale: string;
  statutory_anchor: string | null;
  model: string;
  prompt_version: string;
  tokens_in: number;
  tokens_out: number;
};

export interface Classifier {
  classify(input: ClassifierInput): Promise<ClassifierOutput>;
}
