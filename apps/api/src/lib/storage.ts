import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object-storage adapter (MinIO / S3-compatible).
 *
 * Two surfaces depend on this:
 *   - Presigned upload/download URLs for the media vault + brand logos
 *     (browser/mobile PUTs bytes directly; consultant GETs a short-lived
 *     download URL).
 *   - Direct `putObject` for server-rendered artefacts (engagement-letter
 *     and IP-search verdict PDFs), which generate bytes inside a job and
 *     must persist them before their media_artefact download URL resolves.
 *
 * Configuration follows the same prod-vs-dev contract as
 * `production-secrets.ts`: when the S3 env is present we talk to the real
 * bucket; when it is absent we fall back to the historical
 * `placeholder.s3.amazonaws.com` URL (dev) and make `putObject` a no-op so
 * the live-DB integration suite runs without a MinIO instance. In
 * production, missing config is a hard error rather than a silent stub.
 *
 * Path-style addressing (`forcePathStyle`) is the default so a single
 * `s3.<domain>` host serves every bucket — no wildcard DNS / TLS needed.
 */

const PRESIGN_PUT_TTL_SECONDS = 15 * 60; // upload window
const PRESIGN_GET_TTL_SECONDS = 5 * 60; // download window

const DEV_PLACEHOLDER_HOST = 'https://placeholder.s3.amazonaws.com';

interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Returns the resolved S3 config, or `null` when storage is unconfigured.
 * All four of endpoint/key/secret/bucket are required for "configured";
 * region + path-style have sensible defaults (MinIO ignores region but the
 * SDK requires one).
 */
function readConfig(): StorageConfig | null {
  const endpoint = readEnv('S3_ENDPOINT');
  const accessKeyId = readEnv('S3_ACCESS_KEY_ID');
  const secretAccessKey = readEnv('S3_SECRET_ACCESS_KEY');
  const bucket = readEnv('S3_BUCKET');
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    endpoint,
    region: readEnv('S3_REGION') ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    bucket,
    forcePathStyle: readEnv('S3_FORCE_PATH_STYLE') !== 'false',
  };
}

let cached: { client: S3Client; bucket: string } | null = null;

function getClient(config: StorageConfig): { client: S3Client; bucket: string } {
  if (cached) return cached;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  cached = { client, bucket: config.bucket };
  return cached;
}

function unconfiguredError(): Error {
  return new Error(
    'Object storage is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, ' +
      'S3_SECRET_ACCESS_KEY and S3_BUCKET (required in production).',
  );
}

export function isStorageConfigured(): boolean {
  return readConfig() !== null;
}

/**
 * Presigned PUT URL the browser/mobile client uploads bytes to. We do not
 * bind Content-Type into the signature, so the client may send any
 * content-type without a signature-mismatch failure.
 */
export async function presignUploadUrl(s3Key: string): Promise<string> {
  const config = readConfig();
  if (!config) {
    if (isProduction()) throw unconfiguredError();
    return `${DEV_PLACEHOLDER_HOST}/${s3Key}`;
  }
  const { client, bucket } = getClient(config);
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: s3Key }), {
    expiresIn: PRESIGN_PUT_TTL_SECONDS,
  });
}

/**
 * Short-lived presigned GET URL for downloading an artefact.
 */
export async function presignDownloadUrl(s3Key: string): Promise<string> {
  const config = readConfig();
  if (!config) {
    if (isProduction()) throw unconfiguredError();
    return `${DEV_PLACEHOLDER_HOST}/${s3Key}`;
  }
  const { client, bucket } = getClient(config);
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: s3Key }), {
    expiresIn: PRESIGN_GET_TTL_SECONDS,
  });
}

/**
 * Server-side upload for job-rendered artefacts. No-op in dev/test when
 * storage is unconfigured so jobs run end-to-end without MinIO; hard error
 * in production.
 */
export async function putObject(args: {
  s3Key: string;
  body: Uint8Array | Buffer;
  contentType: string;
}): Promise<void> {
  const config = readConfig();
  if (!config) {
    if (isProduction()) throw unconfiguredError();
    return;
  }
  const { client, bucket } = getClient(config);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: args.s3Key,
      Body: args.body,
      ContentType: args.contentType,
    }),
  );
}
