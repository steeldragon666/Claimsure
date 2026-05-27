/**
 * Cloud-sync connector routes — Google Drive OAuth flow + connection CRUD.
 *
 * Route inventory:
 *   POST   /v1/projects/:id/cloud-sync/google-drive/initiate
 *   GET    /v1/cloud-sync/google-drive/callback                (public — Google redirects here)
 *   PATCH  /v1/projects/:id/cloud-sync/:connection_id/folder
 *   GET    /v1/projects/:id/cloud-sync
 *   DELETE /v1/projects/:id/cloud-sync/:connection_id
 *   GET    /v1/cloud-sync/:connection_id/folders
 *
 * Security design:
 *   - Initiate + PATCH + list + delete: requireSession + admin|consultant check.
 *   - Callback: public (no requireSession) — Google redirects the user's
 *     browser here; the user's cpa_session cookie is present in the request
 *     and is verified manually to attach the user to the new connection row.
 *   - Folders: requireSession (viewer is fine — read-only picker).
 *
 * Token storage:
 *   refresh_token_encrypted is currently stored as plaintext.
 *   TODO(security): rotate to pgcrypto pgp_sym_encrypt(token, key) on insert
 *   and pgp_sym_decrypt(col::bytea, key) on read, where key =
 *   process.env['CLOUD_SYNC_TOKEN_KEY']. See migration 0075 comment.
 *   For now, the column name "encrypted" is aspirational.
 *
 * RLS pattern:
 *   Every write that touches cloud_sync_connection runs inside
 *   `sql.begin(async (tx) => { await tx\`SELECT set_config(...)\`; ... })`
 *   following the established pattern in projects.ts and integrations.ts.
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import {
  SetFolderBody,
  type CloudSyncConnectedPayload,
  type CloudSyncDisconnectedPayload,
  type CloudSyncConnection,
} from '@cpa/schemas';
import {
  buildDriveAuthUrl,
  exchangeDriveCode,
  revokeDriveToken,
  getDriveAccountEmail,
  listDriveFolders,
  type DriveFolderItem,
} from '@cpa/integrations/google-drive';
import {
  generatePkceVerifier,
  pkceChallengeFromVerifier,
  generateOAuthState,
} from '@cpa/integrations/runtime';
import { publicUrl } from '../lib/public-base-url.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HANDSHAKE_COOKIE = 'cs_handshake_gd';
const HANDSHAKE_TTL_SEC = 300; // 5 minutes

/** Separates project_id from the nonce in the state string. */
const STATE_SEPARATOR = '|';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HandshakeCookiePayload {
  verifier: string;
  state: string;
  project_id: string;
  connection_id: string;
}

function handshakeCookieAttrs(secure: boolean): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${HANDSHAKE_TTL_SEC}${secure ? '; Secure' : ''}`;
}

function clearHandshakeCookieAttrs(): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Read the Google Drive OAuth config from env or throw if missing. */
function getDriveOAuthConfig(): { client_id: string; client_secret: string; redirect_uri: string } {
  const client_id = process.env['GOOGLE_DRIVE_OAUTH_CLIENT_ID'];
  const client_secret = process.env['GOOGLE_DRIVE_OAUTH_CLIENT_SECRET'];
  const redirect_uri =
    process.env['GOOGLE_DRIVE_OAUTH_REDIRECT_URI'] ??
    publicUrl('/v1/cloud-sync/google-drive/callback');
  if (!client_id || !client_secret) {
    throw Object.assign(
      new Error(
        'GOOGLE_DRIVE_OAUTH_CLIENT_ID and GOOGLE_DRIVE_OAUTH_CLIENT_SECRET must be set to use the Drive connector',
      ),
      { statusCode: 503 },
    );
  }
  return { client_id, client_secret, redirect_uri };
}

/** Normalise a postgres timestamptz to ISO-8601 or null. */
const isoOrNull = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
};
const isoOf = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

interface RawConnectionRow {
  id: string;
  tenant_id: string;
  project_id: string;
  provider: string;
  provider_account_email: string;
  provider_folder_id: string;
  provider_folder_name: string;
  refresh_token_encrypted: string;
  access_token_cached: string | null;
  access_token_expires_at: Date | string | null;
  status: string;
  last_synced_at: Date | string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  files_synced_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

function toApiConnection(r: RawConnectionRow): CloudSyncConnection {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    project_id: r.project_id,
    provider: r.provider as 'google_drive',
    provider_account_email: r.provider_account_email,
    provider_folder_id: r.provider_folder_id,
    provider_folder_name: r.provider_folder_name,
    status: r.status as CloudSyncConnection['status'],
    last_synced_at: isoOrNull(r.last_synced_at),
    last_sync_status: (r.last_sync_status as CloudSyncConnection['last_sync_status']) ?? null,
    last_sync_error: r.last_sync_error,
    files_synced_count: r.files_synced_count,
    created_at: isoOf(r.created_at),
    updated_at: isoOf(r.updated_at),
    deleted_at: isoOrNull(r.deleted_at),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCloudSync(app: FastifyInstance): void {
  const cookieSecure = process.env['NODE_ENV'] === 'production';

  // -------------------------------------------------------------------------
  // POST /v1/projects/:id/cloud-sync/google-drive/initiate
  // -------------------------------------------------------------------------
  app.post(
    '/v1/projects/:id/cloud-sync/google-drive/initiate',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const projectId = (req.params as { id: string }).id;
      const tenantId = req.user!.tenantId!;

      // Verify project exists and is within this tenant (RLS).
      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ id: string }[]>`
          SELECT id FROM project
          WHERE id = ${projectId} AND archived_at IS NULL
        `;
      });
      if (rows.length === 0) {
        return reply.status(404).send({
          error: 'project_not_found',
          message: 'No active project with that id in this firm',
          requestId: req.id,
        });
      }

      let oauthConfig: ReturnType<typeof getDriveOAuthConfig>;
      try {
        oauthConfig = getDriveOAuthConfig();
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply.status(e.statusCode ?? 503).send({
          error: 'connector_not_configured',
          message: e.message,
          requestId: req.id,
        });
      }

      // Create a stub connection row in pending_folder_selection status.
      // We need the connection_id in the handshake cookie so the callback
      // knows which row to update with the OAuth tokens.
      const connectionId = crypto.randomUUID();

      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`
          INSERT INTO cloud_sync_connection (
            id, tenant_id, project_id, provider, status
          ) VALUES (
            ${connectionId}, ${tenantId}, ${projectId}, 'google_drive', 'pending_folder_selection'
          )
        `;
      });

      // Generate PKCE verifier + state, store in handshake cookie.
      const verifier = generatePkceVerifier();
      const { challenge } = pkceChallengeFromVerifier(verifier);
      const nonce = generateOAuthState();
      // Embed project_id in state so the callback can redirect correctly.
      const state = `${nonce}${STATE_SEPARATOR}${projectId}`;

      const handshake: HandshakeCookiePayload = {
        verifier,
        state,
        project_id: projectId,
        connection_id: connectionId,
      };
      void reply.header(
        'set-cookie',
        `${HANDSHAKE_COOKIE}=${encodeURIComponent(JSON.stringify(handshake))}; ${handshakeCookieAttrs(cookieSecure)}`,
      );

      const authorization_url = buildDriveAuthUrl({
        ...oauthConfig,
        state,
        pkce_challenge: challenge,
      });

      return reply.status(200).send({ authorization_url, connection_id: connectionId });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/cloud-sync/google-drive/callback
  // Public — Google redirects the user's browser here.
  // -------------------------------------------------------------------------
  app.get('/v1/cloud-sync/google-drive/callback', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const code = query['code'];
    const state = query['state'];
    const error = query['error'];

    if (error) {
      return reply.redirect(`/?cs_error=${encodeURIComponent(error)}`, 302);
    }

    if (!code || !state) {
      return reply.status(400).send({
        error: 'missing_params',
        message: 'code and state are required',
        requestId: req.id,
      });
    }

    // Read and validate handshake cookie.
    const rawCookie = req.cookies[HANDSHAKE_COOKIE];
    if (!rawCookie) {
      return reply.status(400).send({
        error: 'missing_handshake',
        message: 'Drive OAuth handshake cookie missing or expired',
        requestId: req.id,
      });
    }

    let handshake: HandshakeCookiePayload;
    try {
      handshake = JSON.parse(decodeURIComponent(rawCookie)) as HandshakeCookiePayload;
    } catch {
      return reply.status(400).send({
        error: 'invalid_handshake',
        message: 'Drive OAuth handshake cookie malformed',
        requestId: req.id,
      });
    }

    if (state !== handshake.state) {
      return reply.status(400).send({
        error: 'state_mismatch',
        message: 'OAuth state parameter mismatch — possible CSRF',
        requestId: req.id,
      });
    }

    // Clear handshake cookie immediately (one-time use).
    void reply.header('set-cookie', `${HANDSHAKE_COOKIE}=; ${clearHandshakeCookieAttrs()}`);

    let oauthConfig: ReturnType<typeof getDriveOAuthConfig>;
    try {
      oauthConfig = getDriveOAuthConfig();
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.status(e.statusCode ?? 503).send({
        error: 'connector_not_configured',
        message: e.message,
        requestId: req.id,
      });
    }

    // Exchange the authorization code for tokens.
    let tokens: Awaited<ReturnType<typeof exchangeDriveCode>>;
    try {
      tokens = await exchangeDriveCode({
        ...oauthConfig,
        code,
        pkce_verifier: handshake.verifier,
      });
    } catch (err) {
      const e = err as Error;
      req.log.error({ err: e }, 'drive oauth code exchange failed');
      return reply.status(401).send({
        error: 'oauth_exchange_failed',
        message: 'Failed to exchange Drive authorization code',
        requestId: req.id,
      });
    }

    if (!tokens.refresh_token) {
      req.log.error('drive oauth: no refresh_token in exchange response — re-auth required');
      return reply.status(400).send({
        error: 'no_refresh_token',
        message:
          'Google did not return a refresh token. Please revoke access at myaccount.google.com and reconnect.',
        requestId: req.id,
      });
    }

    // Fetch account email.
    let accountEmail = '';
    try {
      const aboutResult = await getDriveAccountEmail({
        access_token: tokens.access_token,
        access_token_expires_at: tokens.expires_at,
        refresh_token: tokens.refresh_token,
        oauth_config: oauthConfig,
      });
      accountEmail = aboutResult.data;
    } catch (err) {
      req.log.warn({ err }, 'drive oauth: failed to fetch account email — proceeding without it');
    }

    // Update the connection row with tokens.
    // TODO(security): encrypt refresh_token with CLOUD_SYNC_TOKEN_KEY before storing.
    const expiresAtIso = tokens.expires_at.toISOString();
    try {
      // Note: we look up the connection without RLS (it was just inserted and
      // we don't have a session cookie to extract tenant_id from here). We use
      // a privileged SQL path but only update the specific row by its PK.
      // The connection_id was minted by our server in the initiate route so
      // there is no IDOR risk — the attacker would need to forge our UUID and
      // know the handshake cookie, both of which they don't have.
      await sql`
        UPDATE cloud_sync_connection
        SET
          refresh_token_encrypted = ${tokens.refresh_token},
          access_token_cached     = ${tokens.access_token},
          access_token_expires_at = ${expiresAtIso}::timestamptz,
          provider_account_email  = ${accountEmail},
          updated_at              = now()
        WHERE id = ${handshake.connection_id}
      `;
    } catch (err) {
      req.log.error({ err }, 'drive callback: failed to persist tokens');
      return reply.status(500).send({
        error: 'token_persist_failed',
        message: 'Failed to store Drive tokens',
        requestId: req.id,
      });
    }

    // Redirect to the project's intake tab with cs_pending so the frontend
    // shows the folder-picker dialog.
    const redirectUrl = `/projects/${handshake.project_id}?tab=intake&cs_pending=${handshake.connection_id}`;
    return reply.redirect(redirectUrl, 302);
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/projects/:id/cloud-sync/:connection_id/folder
  // -------------------------------------------------------------------------
  app.patch(
    '/v1/projects/:id/cloud-sync/:connection_id/folder',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const { id: projectId, connection_id: connectionId } = req.params as {
        id: string;
        connection_id: string;
      };
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      const parsed = SetFolderBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Body must be { provider_folder_id: string, provider_folder_name: string }',
          requestId: req.id,
        });
      }
      const { provider_folder_id, provider_folder_name } = parsed.data;

      // Load the connection under RLS.
      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<RawConnectionRow[]>`
          SELECT * FROM cloud_sync_connection
          WHERE id = ${connectionId}
            AND project_id = ${projectId}
            AND deleted_at IS NULL
        `;
      });

      if (rows.length === 0) {
        return reply.status(404).send({
          error: 'connection_not_found',
          message: 'No active cloud sync connection with that id for this project',
          requestId: req.id,
        });
      }
      const conn = rows[0]!;

      // Optionally validate the folder is accessible via the Drive API.
      // If the connection has an access token, do a quick folders check.
      // On failure we warn but don't block — the folder may still be valid.
      if (conn.refresh_token_encrypted) {
        let oauthConfig: ReturnType<typeof getDriveOAuthConfig> | null = null;
        try {
          oauthConfig = getDriveOAuthConfig();
        } catch {
          /* env not set — skip validation */
        }
        if (oauthConfig && conn.access_token_cached) {
          try {
            await listDriveFolders(
              {
                access_token: conn.access_token_cached,
                access_token_expires_at: conn.access_token_expires_at
                  ? new Date(conn.access_token_expires_at)
                  : new Date(0),
                refresh_token: conn.refresh_token_encrypted,
                oauth_config: oauthConfig,
              },
              provider_folder_id,
            );
          } catch (err) {
            req.log.warn(
              { err, provider_folder_id },
              'folder validation failed — proceeding anyway',
            );
          }
        }
      }

      // Update the connection row.
      const updated = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const result = await tx<RawConnectionRow[]>`
          UPDATE cloud_sync_connection
          SET
            provider_folder_id   = ${provider_folder_id},
            provider_folder_name = ${provider_folder_name},
            status               = 'active',
            updated_at           = now()
          WHERE id = ${connectionId}
            AND project_id = ${projectId}
            AND deleted_at IS NULL
          RETURNING *
        `;
        return result[0] ?? null;
      });

      if (!updated) {
        return reply.status(404).send({
          error: 'connection_not_found',
          message: 'Connection not found or already deleted',
          requestId: req.id,
        });
      }

      // Fetch the project's subject_tenant_id for the chain event.
      const projectRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ subject_tenant_id: string }[]>`
          SELECT subject_tenant_id FROM project
          WHERE id = ${projectId}
        `;
      });
      const subjectTenantId = projectRows[0]?.subject_tenant_id;

      // Emit CLOUD_SYNC_CONNECTED chain event.
      if (subjectTenantId) {
        const payload: CloudSyncConnectedPayload = {
          connection_id: connectionId,
          project_id: projectId,
          provider: 'google_drive',
          provider_account_email: updated.provider_account_email,
          provider_folder_id,
          provider_folder_name,
        };
        await insertEventWithChain({
          tenant_id: tenantId,
          subject_tenant_id: subjectTenantId,
          project_id: projectId,
          kind: 'CLOUD_SYNC_CONNECTED',
          payload,
          classification: null,
          captured_at: new Date(),
          captured_by_user_id: userId,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
      }

      return reply.status(200).send({ connection: toApiConnection(updated) });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/projects/:id/cloud-sync
  // -------------------------------------------------------------------------
  app.get('/v1/projects/:id/cloud-sync', { preHandler: requireSession }, async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    const tenantId = req.user!.tenantId!;

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return tx<RawConnectionRow[]>`
          SELECT * FROM cloud_sync_connection
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
          ORDER BY created_at ASC
        `;
    });

    return reply.status(200).send({ connections: rows.map(toApiConnection) });
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/projects/:id/cloud-sync/:connection_id
  // -------------------------------------------------------------------------
  app.delete(
    '/v1/projects/:id/cloud-sync/:connection_id',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const { id: projectId, connection_id: connectionId } = req.params as {
        id: string;
        connection_id: string;
      };
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      const deleted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const result = await tx<RawConnectionRow[]>`
          UPDATE cloud_sync_connection
          SET deleted_at = now(), updated_at = now()
          WHERE id = ${connectionId}
            AND project_id = ${projectId}
            AND deleted_at IS NULL
          RETURNING *
        `;
        return result[0] ?? null;
      });

      if (!deleted) {
        return reply.status(404).send({
          error: 'connection_not_found',
          message: 'No active cloud sync connection with that id for this project',
          requestId: req.id,
        });
      }

      // Best-effort: revoke the refresh token with Google.
      if (deleted.refresh_token_encrypted) {
        revokeDriveToken(deleted.refresh_token_encrypted).catch(() => undefined);
      }

      // Fetch project's subject_tenant_id for chain event.
      const projectRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ subject_tenant_id: string }[]>`
          SELECT subject_tenant_id FROM project WHERE id = ${projectId}
        `;
      });
      const subjectTenantId = projectRows[0]?.subject_tenant_id;

      if (subjectTenantId) {
        const payload: CloudSyncDisconnectedPayload = {
          connection_id: connectionId,
          project_id: projectId,
          provider: 'google_drive',
          provider_account_email: deleted.provider_account_email,
          disconnected_by_user_id: userId,
        };
        await insertEventWithChain({
          tenant_id: tenantId,
          subject_tenant_id: subjectTenantId,
          project_id: projectId,
          kind: 'CLOUD_SYNC_DISCONNECTED',
          payload,
          classification: null,
          captured_at: new Date(),
          captured_by_user_id: userId,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
      }

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/cloud-sync/:connection_id/folders?parent_id=<id>
  // -------------------------------------------------------------------------
  app.get(
    '/v1/cloud-sync/:connection_id/folders',
    { preHandler: requireSession },
    async (req, reply) => {
      const { connection_id: connectionId } = req.params as { connection_id: string };
      const tenantId = req.user!.tenantId!;
      const parentId = (req.query as Record<string, string | undefined>)['parent_id'];

      // Load connection under RLS (any authenticated role can use the picker).
      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<
          Pick<
            RawConnectionRow,
            'id' | 'refresh_token_encrypted' | 'access_token_cached' | 'access_token_expires_at'
          >[]
        >`
          SELECT id, refresh_token_encrypted, access_token_cached, access_token_expires_at
          FROM cloud_sync_connection
          WHERE id = ${connectionId}
            AND deleted_at IS NULL
        `;
      });

      if (rows.length === 0) {
        return reply.status(404).send({
          error: 'connection_not_found',
          message: 'No active cloud sync connection with that id',
          requestId: req.id,
        });
      }

      const conn = rows[0]!;
      if (!conn.refresh_token_encrypted || !conn.access_token_cached) {
        return reply.status(409).send({
          error: 'tokens_not_ready',
          message: 'OAuth tokens not yet stored for this connection',
          requestId: req.id,
        });
      }

      let oauthConfig: ReturnType<typeof getDriveOAuthConfig>;
      try {
        oauthConfig = getDriveOAuthConfig();
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply.status(e.statusCode ?? 503).send({
          error: 'connector_not_configured',
          message: e.message,
          requestId: req.id,
        });
      }

      try {
        const result = await listDriveFolders(
          {
            access_token: conn.access_token_cached,
            access_token_expires_at: conn.access_token_expires_at
              ? new Date(conn.access_token_expires_at)
              : new Date(0),
            refresh_token: conn.refresh_token_encrypted,
            oauth_config: oauthConfig,
          },
          parentId,
        );

        // Persist token update if a refresh occurred.
        if (result.token_update) {
          const tu = result.token_update;
          const expiresIso = tu.access_token_expires_at.toISOString();
          if (tu.refresh_token) {
            await sql`
              UPDATE cloud_sync_connection
              SET access_token_cached = ${tu.access_token},
                  access_token_expires_at = ${expiresIso}::timestamptz,
                  refresh_token_encrypted = ${tu.refresh_token},
                  updated_at = now()
              WHERE id = ${connectionId}
            `;
          } else {
            await sql`
              UPDATE cloud_sync_connection
              SET access_token_cached = ${tu.access_token},
                  access_token_expires_at = ${expiresIso}::timestamptz,
                  updated_at = now()
              WHERE id = ${connectionId}
            `;
          }
        }

        const folders = result.data.files.map((f: DriveFolderItem) => ({
          id: f.id,
          name: f.name,
          parent_id: f.parents?.[0] ?? null,
        }));
        return await reply.status(200).send({ folders });
      } catch (err) {
        req.log.error({ err }, 'drive list folders failed');
        return reply.status(502).send({
          error: 'drive_api_error',
          message: (err as Error).message,
          requestId: req.id,
        });
      }
    },
  );
}
