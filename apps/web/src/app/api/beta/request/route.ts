/**
 * POST /api/beta/request
 *
 * Body: { email: string }
 *
 * Always returns 200 (generic "check your email" body) regardless of
 * whether the email is on the allowlist — prevents enumeration. Rate
 * limited per-IP. Sends a magic-link via existing @cpa/email/Resend
 * infra when the email IS on the allowlist.
 *
 * Test-only injection seam: globalThis.__test_send is called instead
 * of the real Resend when defined. See route.test.ts.
 */
import { z } from 'zod';
import { mintMagicLinkToken, parseAllowlist } from '@/lib/beta-auth';

export const runtime = 'nodejs';

const BodySchema = z.object({
  email: z.string().email(),
});

// In-memory rate limit. 5 requests / IP / hour. Restarts blow this away
// which is fine for closed beta.
const buckets = new Map<string, { resetAt: number; count: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') ?? '';
  return xff.split(',')[0]?.trim() || 'unknown';
}

function takeRateLimitToken(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { resetAt: now + WINDOW_MS, count: 1 });
    return { ok: true };
  }
  if (bucket.count >= MAX_PER_WINDOW) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { ok: true };
}

interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function sendMagicLinkEmail(toEmail: string, link: string): Promise<void> {
  const testSend = (globalThis as unknown as { __test_send?: (input: EmailInput) => Promise<void> })
    .__test_send;
  if (testSend) {
    await testSend({
      to: toEmail,
      subject: 'Your ArchiveOne beta access link',
      html: link,
      text: link,
    });
    return;
  }
  await realSend(toEmail, link);
}

async function realSend(toEmail: string, link: string): Promise<void> {
  const { createResendClient, createEmailSender } = await import('@cpa/email');
  const client = createResendClient({ apiKey: process.env.RESEND_API_KEY! });
  const sender = createEmailSender(client, {
    fromAddress: process.env.BETA_FROM_ADDRESS!,
  });
  await sender.send({
    to: toEmail,
    subject: 'Your ArchiveOne beta access link',
    text: `Click to access the ArchiveOne beta:\n\n${link}\n\nThis link expires in 15 minutes.`,
    html: `<p>Click to access the ArchiveOne beta:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`,
  });
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  const rl = takeRateLimitToken(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfter) },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const allowlist = parseAllowlist(process.env.BETA_ALLOWLIST ?? '');
  if (allowlist.has(email)) {
    const token = await mintMagicLinkToken(email, process.env.BETA_AUTH_SECRET!);
    const origin = new URL(req.url).origin;
    const link = `${origin}/api/beta/verify?token=${encodeURIComponent(token)}`;
    try {
      await sendMagicLinkEmail(email, link);
    } catch (err) {
      console.error('[beta] email send failed', err instanceof Error ? err.message : String(err));
    }
  }

  return new Response(
    JSON.stringify({ message: 'If your email is on the beta allowlist, check your inbox.' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
