/**
 * pg-boss cron job: google-drive-poll
 *
 * Runs every 15 minutes. For each active cloud_sync_connection with a
 * folder selected, lists the Drive folder, downloads new files, computes
 * their SHA-256, emits EVIDENCE_UPLOADED chain events, and inserts
 * cloud_sync_synced_file rows to prevent re-ingestion.
 *
 * Pattern mirrors `rif-daily-scrape.ts`:
 *   - Exports `registerGoogleDrivePollJob` consumed by server.ts.
 *   - createQueue → work → schedule.
 *   - Per-connection error isolation: one bad connection doesn't abort
 *     the others.
 *
 * Token storage note:
 *   refresh_token_encrypted is currently stored as plaintext.
 *   TODO(security): decrypt with CLOUD_SYNC_TOKEN_KEY via pgcrypto before
 *   using the token, once the encryption migration lands.
 */

import type { PgBoss } from 'pg-boss';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { listDriveFiles, downloadDriveFile } from '@cpa/integrations/google-drive';
import type { DriveClientOptions } from '@cpa/integrations/google-drive';
import type { EvidenceUploadedPayload } from '@cpa/schemas';
import { publicUrl } from '../lib/public-base-url.js';

export const GOOGLE_DRIVE_POLL_JOB_NAME = 'google-drive-poll';
/** Every 15 minutes. */
export const GOOGLE_DRIVE_POLL_CRON = '*/15 * * * *';

/** Google Docs / Sheets / Slides etc. cannot be downloaded via alt=media. */
const GOOGLE_DOCS_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.script',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.folder',
]);

interface ActiveConnection {
  id: string;
  tenant_id: string;
  project_id: string;
  provider_folder_id: string;
  provider_account_email: string;
  refresh_token_encrypted: string;
  access_token_cached: string | null;
  access_token_expires_at: Date | string | null;
}

interface ProjectInfo {
  subject_tenant_id: string;
}

/** Read the Google Drive OAuth config from env. Returns null if not configured. */
function getDriveOAuthConfig(): {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
} | null {
  const client_id = process.env['GOOGLE_DRIVE_OAUTH_CLIENT_ID'];
  const client_secret = process.env['GOOGLE_DRIVE_OAUTH_CLIENT_SECRET'];
  if (!client_id || !client_secret) return null;
  return {
    client_id,
    client_secret,
    redirect_uri:
      process.env['GOOGLE_DRIVE_OAUTH_REDIRECT_URI'] ??
      publicUrl('/v1/cloud-sync/google-drive/callback'),
  };
}

/**
 * Process a single active Drive connection.
 * On success: updates last_synced_at, last_sync_status='success'.
 * On error: logs the error, sets last_sync_status='error' + last_sync_error.
 * In neither case does this throw — one bad connection must not abort the run.
 */
async function processConnection(
  conn: ActiveConnection,
  oauthConfig: { client_id: string; client_secret: string; redirect_uri: string },
): Promise<{ files_ingested: number }> {
  let filesIngested = 0;

  // Fetch the project's subject_tenant_id (needed for chain events).
  // Uses privileged SQL (no RLS context needed here — the polling job
  // is a server-side background task, not a user request).
  const projectRows = await sql<ProjectInfo[]>`
    SELECT subject_tenant_id FROM project WHERE id = ${conn.project_id}
  `;
  if (projectRows.length === 0) {
    throw new Error(`project ${conn.project_id} not found`);
  }
  const subjectTenantId = projectRows[0]!.subject_tenant_id;

  const clientOpts: DriveClientOptions = {
    access_token: conn.access_token_cached ?? '',
    access_token_expires_at: conn.access_token_expires_at
      ? new Date(conn.access_token_expires_at)
      : new Date(0),
    refresh_token: conn.refresh_token_encrypted,
    oauth_config: oauthConfig,
  };

  // Page through files in the folder.
  let pageToken: string | undefined;
  do {
    const result = await listDriveFiles(clientOpts, conn.provider_folder_id, pageToken);

    // Persist any token update.
    if (result.token_update) {
      const tu = result.token_update;
      const expiresIso = tu.access_token_expires_at.toISOString();
      clientOpts.access_token = tu.access_token;
      clientOpts.access_token_expires_at = tu.access_token_expires_at;
      if (tu.refresh_token) {
        clientOpts.refresh_token = tu.refresh_token;
        await sql`
          UPDATE cloud_sync_connection
          SET access_token_cached = ${tu.access_token},
              access_token_expires_at = ${expiresIso}::timestamptz,
              refresh_token_encrypted = ${tu.refresh_token},
              updated_at = now()
          WHERE id = ${conn.id}
        `;
      } else {
        await sql`
          UPDATE cloud_sync_connection
          SET access_token_cached = ${tu.access_token},
              access_token_expires_at = ${expiresIso}::timestamptz,
              updated_at = now()
          WHERE id = ${conn.id}
        `;
      }
    }

    for (const file of result.data.files) {
      // Skip Google Workspace native formats that can't be downloaded.
      if (GOOGLE_DOCS_MIME_TYPES.has(file.mimeType)) {
        continue;
      }

      // Check whether we've already ingested this file (by provider_file_id).
      // Using INSERT ... ON CONFLICT DO NOTHING as a single atomic operation
      // prevents races between concurrent poll runs.
      // First check to avoid downloading unnecessarily.
      const alreadySeen = await sql<{ id: string }[]>`
        SELECT id FROM cloud_sync_synced_file
        WHERE connection_id = ${conn.id}
          AND provider_file_id = ${file.id}
      `;
      if (alreadySeen.length > 0) continue;

      // Download the file and compute SHA-256.
      let sha256_hex: string;
      let bytes: Uint8Array;
      try {
        const downloadResult = await downloadDriveFile(clientOpts, file.id);
        sha256_hex = downloadResult.sha256_hex;
        bytes = downloadResult.bytes;

        // Persist any token update from the download.
        if (downloadResult.token_update) {
          const tu = downloadResult.token_update;
          const expiresIso = tu.access_token_expires_at.toISOString();
          clientOpts.access_token = tu.access_token;
          clientOpts.access_token_expires_at = tu.access_token_expires_at;
          if (tu.refresh_token) {
            clientOpts.refresh_token = tu.refresh_token;
            await sql`
              UPDATE cloud_sync_connection
              SET access_token_cached = ${tu.access_token},
                  access_token_expires_at = ${expiresIso}::timestamptz,
                  refresh_token_encrypted = ${tu.refresh_token},
                  updated_at = now()
              WHERE id = ${conn.id}
            `;
          } else {
            await sql`
              UPDATE cloud_sync_connection
              SET access_token_cached = ${tu.access_token},
                  access_token_expires_at = ${expiresIso}::timestamptz,
                  updated_at = now()
              WHERE id = ${conn.id}
            `;
          }
        }
      } catch (err) {
        // Log per-file error but continue to other files.
        console.error(
          `[google-drive-poll] download failed file_id=${file.id} conn=${conn.id}:`,
          err,
        );
        continue;
      }

      // Suppress unused variable warning — bytes are downloaded to compute SHA-256
      // and would be used for further processing (S3 upload, etc.) in future.
      void bytes;

      // Emit EVIDENCE_UPLOADED chain event.
      const payload: EvidenceUploadedPayload = {
        source: 'google_drive',
        connection_id: conn.id,
        filename: file.name,
        sha256: sha256_hex,
        mime_type: file.mimeType,
        size_bytes: file.size != null ? parseInt(file.size, 10) : 0,
        drive_file_id: file.id,
        drive_modified_time: file.modifiedTime,
      };

      let eventId: string;
      try {
        const inserted = await insertEventWithChain({
          tenant_id: conn.tenant_id,
          subject_tenant_id: subjectTenantId,
          project_id: conn.project_id,
          kind: 'EVIDENCE_UPLOADED',
          payload,
          classification: null,
          captured_at: new Date(),
          // System-authored events use the agent_b system user pattern.
          // captured_by_user_id is required by the DB constraint but no
          // real user triggered this. We use a well-known sentinel UUID that
          // matches the 'agent_b' system user seeded in migration 0033.
          // If that user doesn't exist (fresh DB without seed), this will FK-fail
          // and we'll fall through to the catch below and skip this file.
          captured_by_user_id: await getSystemUserId(),
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
        eventId = inserted.id;
      } catch (err) {
        console.error(
          `[google-drive-poll] chain event failed file_id=${file.id} conn=${conn.id}:`,
          err,
        );
        continue;
      }

      // Insert the synced_file row (idempotent: ON CONFLICT DO NOTHING).
      await sql`
        INSERT INTO cloud_sync_synced_file (connection_id, provider_file_id, sha256_hex, event_id)
        VALUES (${conn.id}, ${file.id}, ${sha256_hex}, ${eventId})
        ON CONFLICT (connection_id, provider_file_id) DO NOTHING
      `;

      filesIngested++;
    }

    pageToken = result.data.nextPageToken;
  } while (pageToken);

  // Update files_synced_count (increment by how many we ingested this run).
  if (filesIngested > 0) {
    await sql`
      UPDATE cloud_sync_connection
      SET files_synced_count = files_synced_count + ${filesIngested},
          updated_at = now()
      WHERE id = ${conn.id}
    `;
  }

  return { files_ingested: filesIngested };
}

/**
 * Cache for the system user ID lookup — looked up once per process lifetime.
 *
 * The system user is seeded by migration 0032/0033 with a well-known email.
 * If none exists we fall back to a randomly-chosen real user from the tenant
 * (not ideal but avoids a hard failure).
 */
let _systemUserId: string | null | undefined = undefined;

async function getSystemUserId(): Promise<string> {
  if (_systemUserId !== undefined) return _systemUserId ?? '00000000-0000-4000-8000-000000000000';
  // Try to find agent_b system user (migration 0033).
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM "user"
    WHERE email IN ('agent-b@system.cpa', 'agent-a@system.cpa')
    LIMIT 1
  `;
  _systemUserId = rows[0]?.id ?? null;
  // If not found, return a stable fallback UUID that will likely FK-fail and
  // be caught in the caller's try/catch. This is preferable to silently
  // corrupting the chain with a bad user reference.
  return _systemUserId ?? '00000000-0000-4000-8000-000000000000';
}

/**
 * Register the Google Drive poll cron with pg-boss.
 * Called from server.ts after getBoss() succeeds.
 */
export async function registerGoogleDrivePollJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(GOOGLE_DRIVE_POLL_JOB_NAME);

  await boss.work(GOOGLE_DRIVE_POLL_JOB_NAME, async () => {
    const oauthConfig = getDriveOAuthConfig();
    if (!oauthConfig) {
      console.log('[google-drive-poll] skipped — GOOGLE_DRIVE_OAUTH_CLIENT_ID/SECRET not set');
      return;
    }

    // Load all active connections with a folder selected.
    const connections = await sql<ActiveConnection[]>`
      SELECT
        id, tenant_id, project_id, provider_folder_id, provider_account_email,
        refresh_token_encrypted, access_token_cached, access_token_expires_at
      FROM cloud_sync_connection
      WHERE deleted_at IS NULL
        AND status = 'active'
        AND provider_folder_id <> ''
      ORDER BY last_synced_at ASC NULLS FIRST
    `;

    console.log(`[google-drive-poll] processing ${connections.length} active connections`);

    let totalIngested = 0;
    let totalErrors = 0;

    for (const conn of connections) {
      try {
        const { files_ingested } = await processConnection(conn, oauthConfig);
        totalIngested += files_ingested;

        // Update last_synced_at + last_sync_status='success'.
        await sql`
          UPDATE cloud_sync_connection
          SET last_synced_at   = now(),
              last_sync_status = 'success',
              last_sync_error  = NULL,
              updated_at       = now()
          WHERE id = ${conn.id}
        `;
      } catch (err) {
        totalErrors++;
        const errMsg = (err as Error).message ?? String(err);
        console.error(`[google-drive-poll] connection ${conn.id} failed: ${errMsg}`);
        // Per-connection error: set error status + message, continue.
        await sql`
          UPDATE cloud_sync_connection
          SET last_synced_at   = now(),
              last_sync_status = 'error',
              last_sync_error  = ${errMsg.slice(0, 2000)},
              status           = 'error',
              updated_at       = now()
          WHERE id = ${conn.id}
        `;
      }
    }

    console.log(
      `[google-drive-poll] done connections=${connections.length} ingested=${totalIngested} errors=${totalErrors}`,
    );
  });

  await boss.schedule(GOOGLE_DRIVE_POLL_JOB_NAME, GOOGLE_DRIVE_POLL_CRON, null, {
    tz: 'UTC',
  });
}
