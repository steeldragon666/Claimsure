import crypto from 'node:crypto';

/**
 * Symmetric encryption helpers for OAuth tokens at rest (T-B3).
 *
 * AES-256-GCM with a fresh 96-bit IV per encrypt operation. The output
 * blob is `<iv-hex>.<authtag-hex>.<ciphertext-hex>` so a single varchar
 * column carries everything decrypt() needs — no separate IV/tag
 * columns required.
 *
 * Key handling: callers pass a 32-byte (64-char) hex string. Reading
 * `process.env.TOKEN_ENCRYPTION_KEY` is the responsibility of the
 * `getTokenEncryptionKey()` helper so tests can pin a fixture key
 * without touching the env.
 *
 * GCM authenticated encryption gives us tamper detection for free —
 * `decryptToken` rejects modified ciphertext via the auth tag, so a
 * Postgres bit-flip (or a malicious DBA) on `access_token_encrypted`
 * surfaces as a thrown error rather than a silently wrong plaintext.
 */
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function encryptToken(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes hex (64 chars)');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${authTag.toString('hex')}.${ciphertext.toString('hex')}`;
}

export function decryptToken(blob: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes hex (64 chars)');
  }
  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed encrypted token');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('malformed encrypted token');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Read TOKEN_ENCRYPTION_KEY from env. Throws if unset; production
 * boots will fail loudly rather than silently encrypting with a
 * weak fallback.
 */
export function getTokenEncryptionKey(): string {
  const key = process.env['TOKEN_ENCRYPTION_KEY'];
  if (!key) {
    throw new Error('TOKEN_ENCRYPTION_KEY env var required');
  }
  return key;
}
