import crypto from 'node:crypto';
import { privilegedSql } from '@cpa/db/client';
import type { RegulatoryClassificationType } from '@cpa/agents/regulatory-classifier';

/**
 * Input for dispatching a classified regulatory event to downstream systems.
 */
export interface DispatchInput {
  /** The regulatory_event row id. */
  eventId: string;
  /** Tenant scope for the suggestion insert. */
  tenantId: string;
  /** User id to attribute the suggestion to (system user or tenant admin). */
  flaggedByUserId: string;
  /** The classification result from regulatory-classify@1.0.0. */
  classification: RegulatoryClassificationType;
}

export interface DispatchResult {
  /** Number of prompt_suggestion rows inserted. */
  suggestions_inserted: number;
  /** Whether a corpus refresh was signalled for AAT/ART decisions. */
  corpus_refresh_signalled: boolean;
}

/**
 * Dispatch a classified regulatory event to Theme B (prompt suggestion queue)
 * and Theme D (similarity corpus refresh / compliance field flags).
 *
 * ## Theme B: prompt_suggestion insert
 * Every classified event with severity 'high' or 'medium' generates a
 * prompt_suggestion row with source_kind='rif_event'. The first entry in
 * `affects_prompt_modules` becomes the `affected_prompt_module` column.
 *
 * ## Theme D: AAT/ART corpus refresh
 * Events with classification_kind IN ('aat_decision', 'art_decision')
 * signal that the multi-entity-similarity historical rejection corpus
 * should be refreshed on the next scan run. This is achieved by the
 * event's mere existence in regulatory_event — the corpus-loader query
 * in D.8 already reads from this table.
 *
 * ## Theme D: compliance field flags
 * Events with non-empty `affects_compliance_fields` generate an additional
 * prompt_suggestion with triage_classification='schema_change' to alert
 * the consultant that compliance data structures may need review.
 *
 * Uses privilegedSql — this runs from a cron context with no RLS session.
 */
export async function dispatchClassifiedEvent(input: DispatchInput): Promise<DispatchResult> {
  const { eventId, tenantId, flaggedByUserId, classification } = input;
  const result: DispatchResult = {
    suggestions_inserted: 0,
    corpus_refresh_signalled: false,
  };

  const severity = classification.severity;
  const isActionable = severity === 'high' || severity === 'medium';

  // Theme B: Insert prompt_suggestion for actionable events
  if (isActionable && classification.affects_prompt_modules.length > 0) {
    const sourcePayload = JSON.stringify({ regulatory_event_id: eventId });
    await privilegedSql`
      INSERT INTO prompt_suggestion (
        tenant_id, id, flagged_by_user_id, source_kind,
        source_payload, affected_prompt_module, issue_summary, status
      ) VALUES (
        ${tenantId},
        ${crypto.randomUUID()},
        ${flaggedByUserId},
        'rif_event',
        ${sourcePayload}::text::jsonb,
        ${classification.affects_prompt_modules[0] ?? null},
        ${classification.summary},
        'open'
      )
    `;
    result.suggestions_inserted++;
  }

  // Theme D: AAT/ART decisions refresh the corpus automatically
  // (the event's presence in regulatory_event is sufficient — corpus-loader
  // queries that table directly). We signal this in the result for logging.
  if (
    classification.classification_kind === 'aat_decision' ||
    classification.classification_kind === 'art_decision'
  ) {
    result.corpus_refresh_signalled = true;
  }

  // Theme D: compliance field change -> schema_change suggestion
  if (isActionable && classification.affects_compliance_fields.length > 0) {
    const fieldList = classification.affects_compliance_fields.join(', ');
    const sourcePayload = JSON.stringify({
      regulatory_event_id: eventId,
      affected_fields: classification.affects_compliance_fields,
    });
    await privilegedSql`
      INSERT INTO prompt_suggestion (
        tenant_id, id, flagged_by_user_id, source_kind,
        source_payload, issue_summary, status, triage_classification
      ) VALUES (
        ${tenantId},
        ${crypto.randomUUID()},
        ${flaggedByUserId},
        'rif_event',
        ${sourcePayload}::text::jsonb,
        ${'Regulatory change affects compliance fields: ' + fieldList + '. ' + classification.summary},
        'open',
        'schema_change'
      )
    `;
    result.suggestions_inserted++;
  }

  return result;
}
