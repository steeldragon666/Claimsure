/**
 * SQL migration list for the on-device SQLite database (`cpa-scribe.db`).
 *
 * Append-only — never edit a previous entry once it's shipped (the
 * runner uses index as the migration version key). New schema changes
 * land as a new entry at the end of the array.
 *
 * Tables:
 *   - mobile_event_queue: outbound queue for Events / MediaArtefacts /
 *     TimeEntries / SigningResponses captured offline. Drained by the
 *     F14 sync worker.
 *   - media_blob_cache: content-addressed cache of locally-captured
 *     media (photos, voice memos, document picks). Lets retries skip
 *     re-uploading a blob whose hash already landed remote.
 */
export const MIGRATIONS = [
  // Migration 1: mobile_event_queue
  `
  CREATE TABLE IF NOT EXISTS mobile_event_queue (
    local_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                    -- 'event' | 'media_artefact' | 'time_entry' | 'signing_response'
    payload TEXT NOT NULL,                 -- JSON
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'syncing' | 'synced' | 'failed'
    remote_id TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS mobile_queue_status_idx ON mobile_event_queue(status, created_at);
  `,
  // Migration 2: media_blob_cache (file path + content hash for retry)
  `
  CREATE TABLE IF NOT EXISTS media_blob_cache (
    content_hash TEXT PRIMARY KEY,
    file_uri TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    captured_at INTEGER NOT NULL,
    uploaded_remote_id TEXT
  );
  `,
];
