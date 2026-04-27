import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { subjectTenant } from './subject_tenant.js';
import { subjectTenantEmployee } from './subject_tenant_employee.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * DocuSign envelope state per claimant-side document (engagement letter,
 * representation letter, RFI response, custom).
 *
 * Initiated by a consultant from the firm portal; recipient is either an
 * existing `subject_tenant_employee` (preferred — links the signed PDF
 * back to the employee for assurance reporting) or a one-off email.
 *
 * `docusign_envelope_id` is the DocuSign-side ID (returned from the
 * Envelopes::create call) and is globally unique — used as the lookup key
 * in the webhook handler (per design doc §5.4).
 *
 * Status transitions are driven by the DocuSign webhook (HMAC-verified at
 * /v1/integrations/docusign/webhook). On `completed`, the worker downloads
 * the signed PDF to S3 and populates `signed_pdf_s3_key` +
 * `signed_pdf_content_hash`, then optionally appends a `SUPPORTING` event
 * to the per-claimant chain referencing the artefact.
 *
 * RLS-protected (T-F2): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const SIGNING_DOCUMENT_KINDS = [
  'engagement_letter',
  'representation_letter',
  'rfi_response',
  'custom',
] as const;
export type SigningDocumentKind = (typeof SIGNING_DOCUMENT_KINDS)[number];

export const SIGNING_STATUSES = [
  'sent',
  'delivered',
  'completed',
  'declined',
  'voided',
  'expired',
] as const;
export type SigningStatus = (typeof SIGNING_STATUSES)[number];

export const signingRequest = pgTable('signing_request', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  subjectTenantId: uuid('subject_tenant_id')
    .notNull()
    .references(() => subjectTenant.id),
  initiatedByUserId: uuid('initiated_by_user_id')
    .notNull()
    .references(() => user.id),
  recipientEmployeeId: uuid('recipient_employee_id').references(() => subjectTenantEmployee.id),
  recipientEmail: text('recipient_email').notNull(),
  documentKind: text('document_kind', { enum: SIGNING_DOCUMENT_KINDS }).notNull(),
  documentTemplateId: text('document_template_id'),
  docusignEnvelopeId: text('docusign_envelope_id').notNull().unique(),
  status: text('status', { enum: SIGNING_STATUSES }).notNull().default('sent'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signedPdfS3Key: text('signed_pdf_s3_key'),
  // hex SHA-256 of the downloaded signed PDF; populated on webhook 'completed'.
  signedPdfContentHash: text('signed_pdf_content_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
