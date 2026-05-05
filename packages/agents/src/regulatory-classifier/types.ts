export { RegulatoryClassification } from './prompts/regulatory-classify@1.0.0.js';
export type { RegulatoryClassification as RegulatoryClassificationType } from './prompts/regulatory-classify@1.0.0.js';

/**
 * Input to the regulatory-classify agent.
 */
export interface ClassifyEventInput {
  event_id: string;
  raw_title: string;
  raw_content: string;
  source_name: string;
  source_url?: string;
}
