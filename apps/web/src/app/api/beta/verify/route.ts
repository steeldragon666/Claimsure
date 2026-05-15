/**
 * GET /api/beta/verify?token=<JWT>&next=<path>
 *
 * Validates the magic-link JWT. On success:
 *   - Sets `beta_session` cookie (30-day TTL, HttpOnly, Secure, SameSite=Lax)
 *   - 302 to sanitized `next` param (or `/`)
 *
 * On failure (missing/tampered/expired): 302 to /beta-access with
 * appropriate ?error= param so the page can render a hint.
 */
import { mintSessionToken, verifyToken } from '@/lib/beta-auth';

export const runtime = 'nodejs';

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function sanitizeNext(next: string | null): string {
  if (!next) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  return next;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const next = sanitizeNext(url.searchParams.get('next'));

  if (!token) {
    return new Response(null, {
      status: 302,
      headers: { location: '/beta-access' },
    });
  }

  let email: string;
  try {
    const verified = await verifyToken(token, 'beta-link', process.env.BETA_AUTH_SECRET!);
    email = verified.email;
  } catch (err) {
    const errorKind = (err as Error).message.includes('expired') ? 'expired' : 'invalid';
    const dest = new URL('/beta-access', url);
    dest.searchParams.set('error', errorKind);
    if (next !== '/') dest.searchParams.set('next', next);
    return new Response(null, {
      status: 302,
      headers: { location: `${dest.pathname}${dest.search}` },
    });
  }

  const sessionToken = await mintSessionToken(email, process.env.BETA_AUTH_SECRET!);
  const cookie = [
    `beta_session=${sessionToken}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');

  console.log(JSON.stringify({ event: 'beta.verified', email, ts: new Date().toISOString() }));

  return new Response(null, {
    status: 302,
    headers: {
      location: next,
      'set-cookie': cookie,
    },
  });
}
