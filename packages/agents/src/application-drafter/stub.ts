/**
 * StubApplicationDrafter — deterministic output for tests + CI.
 *
 * Produces a minimal-but-schema-valid ApplicationDraft so consumers (the
 * generate-application API route, the document renderer) can exercise
 * the full code path without burning Sonnet tokens. Real prose is
 * obviously not produced — every field is short, descriptive of the
 * stub nature.
 */
import type {
  ApplicationDrafter,
  ApplicationDrafterInput,
  ApplicationDrafterResult,
} from './types.js';

export class StubApplicationDrafter implements ApplicationDrafter {
  // eslint-disable-next-line @typescript-eslint/require-await
  async draft(input: ApplicationDrafterInput): Promise<ApplicationDrafterResult> {
    const proposalsCount = input.events.reduce(
      (n, e) => n + (e.extracted_content?.activities.length ?? 0),
      0,
    );
    const output: ApplicationDrafterResult['output'] = {
      applicant: {
        name: input.applicant.name,
        abn: input.applicant.abn,
        anzsic_division_class: 'Division M — Professional, Scientific and Technical Services',
      },
      income_year: input.income_year,
      project: {
        name: input.project.name,
        description:
          input.project.description ??
          `Stub draft generated from ${input.events.length} events with ${proposalsCount} activity proposals.`,
        started_at: input.project.started_at,
        ended_at: input.project.ended_at,
      },
      core_activities: [
        {
          activity_id: 'CA-01',
          project_phases: 'Phase 1',
          period: 'Stub period',
          estimated_expenditure_aud_ex_gst: 0,
          hypothesis_ids: ['H1'],
          linked_supporting_activity_ids: [],
          field_1_activity_name: 'Stub core activity',
          field_2_describe:
            'Stub drafter output — set APPLICATION_DRAFTER_IMPL=sonnet to produce real content.',
          field_3_outcome_unknown_reasons: ['no_applicable_literature'],
          field_4_sources_investigated:
            'Stub drafter output — set APPLICATION_DRAFTER_IMPL=sonnet to produce real content.',
          field_5_competent_professional:
            'Stub drafter output — set APPLICATION_DRAFTER_IMPL=sonnet to produce real content.',
          field_6_hypothesis:
            'Stub drafter output — set APPLICATION_DRAFTER_IMPL=sonnet to produce real content.',
          field_7_experiment:
            'Stub drafter output — set APPLICATION_DRAFTER_IMPL=sonnet to produce real content.',
          field_8_evaluation:
            'Stub drafter output — set APPLICATION_DRAFTER_IMPL=sonnet to produce real content.',
          field_9_conclusions:
            'Stub drafter output — set APPLICATION_DRAFTER_IMPL=sonnet to produce real content.',
          field_10_evidence_kept: ['hypothesis_and_experiment_design'],
          field_11_new_knowledge_purpose: true,
          field_11_new_knowledge_description: 'Stub drafter output.',
          field_12_expenditure_breakdown: 'Stub.',
          field_13_related_supporting_activities_summary: '(none in stub)',
        },
      ],
      supporting_activities: [],
      hypothesis_register: [
        {
          id: 'H1',
          hypothesis_text: 'Stub hypothesis — replace with Sonnet draft.',
          pre_registered_at: input.project.started_at,
          falsifiable_criteria: 'Stub criteria.',
          validation_outcome: 'pending',
          validation_summary: 'Stub.',
          activity_id: 'CA-01',
        },
      ],
      failure_register: [],
      new_knowledge_register: [],
      submission_summary: `Stub submission summary for ${input.applicant.name}, ${input.income_year}.`,
      compliance_notes:
        'Stub drafter — not for submission. Set APPLICATION_DRAFTER_IMPL=sonnet in production.',
    };
    return { output, usage: null };
  }
}
