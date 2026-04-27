import crypto from 'node:crypto';

/**
 * Generic HMAC-SHA256 webhook signature verifier.
 *
 * `signature_header` is expected as a hex-encoded string (lowercased
 * before comparison). Uses constant-time comparison to avoid timing
 * side channels; returns false on any decode error rather than
 * throwing, so callers can treat all "not valid" cases uniformly.
 */
export function verifyHmacSha256(opts: {
  payload: Buffer | string;
  signature_header: string;
  secret: string;
}): boolean {
  const expected = crypto
    .createHmac('sha256', opts.secret)
    .update(opts.payload)
    .digest('hex');
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(opts.signature_header.toLowerCase(), 'hex');
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * DocuSign Connect webhook signature verifier.
 *
 * DocuSign signs the raw request body with HMAC-SHA256 and sends the
 * result as a base64 string in headers like `X-DocuSign-Signature-1`.
 * The HMAC key is configured in the DocuSign Connect listener.
 *
 * See: https://developers.docusign.com/platform/webhooks/connect/hmac/
 */
export function verifyDocuSignSignature(opts: {
  payload: Buffer;
  signature_header: string;
  secret: string;
}): boolean {
  const expected = crypto
    .createHmac('sha256', opts.secret)
    .update(opts.payload)
    .digest('base64');
  try {
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(opts.signature_header);
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}
