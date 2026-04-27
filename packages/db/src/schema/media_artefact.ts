import { bigint, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { event } from './event.js';
import { subjectTenant } from './subject_tenant.js';
import { subjectTenantEmployee } from './subject_tenant_employee.js';
import { tenant } from './tenant.js';

/**
 * Vault upload — photo / video / document / audio captured via mobile or
 * PWA. Content-addressed by hex SHA-256 (`content_hash`) so the same file
 * uploaded twice within a (tenant, subject_tenant) is deduped to a single
 * row pointing at one S3 object.
 *
 * `event_id` is nullable — uploads can land before the event is created
 * (e.g. queued offline) or independently as supporting material. When set,
 * the artefact is referenced as evidence by that event.
 *
 * `exif` jsonb captures camera metadata: GPS lat/long (if granted), capture
 * timestamp, device model, orientation. Used for evidence quality scoring
 * (P5 Assurance Report).
 *
 * `ocr_text` is populated asynchronously by the OCR worker (P3 swimlane B);
 * `ocr_status` tracks the pipeline state. Same shape for `virus_scan_status`
 * (ClamAV/Lambda scan).
 *
 * RLS-protected (T-F2): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const OCR_STATUSES = ['pending', 'complete', 'failed', 'skipped'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

export const VIRUS_SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'] as const;
export type VirusScanStatus = (typeof VIRUS_SCAN_STATUSES)[number];

export const mediaArtefact = pgTable(
  'media_artefact',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    eventId: uuid('event_id').references(() => event.id),
    uploadedByEmployeeId: uuid('uploaded_by_employee_id')
      .notNull()
      .references(() => subjectTenantEmployee.id),
    s3Key: text('s3_key').notNull(),
    // hex SHA-256 of the file bytes; partial-unique with (tenant, subject_tenant).
    contentHash: text('content_hash').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    exif: jsonb('exif'),
    ocrText: text('ocr_text'),
    ocrStatus: text('ocr_status', { enum: OCR_STATUSES }).notNull().default('pending'),
    virusScanStatus: text('virus_scan_status', { enum: VIRUS_SCAN_STATUSES })
      .notNull()
      .default('pending'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    contentDedupeUnique: uniqueIndex('media_artefact_content_dedupe_unique').on(
      t.tenantId,
      t.subjectTenantId,
      t.contentHash,
    ),
  }),
);
