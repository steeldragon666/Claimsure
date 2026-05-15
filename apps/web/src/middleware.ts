/**
 * Beta access gate — runs at the Vercel edge before every request.
 *
 * Reads beta_session cookie. If missing/invalid AND the path isn't a
 * gate-bypass (the /beta-access page, /api/beta/*, or static assets),
 * 302s to /beta-access?next=<original-path>.
 *
 * Toggles:
 *   BETA_GATE_ENABLED=0   -> pass through entirely (kill switch)
 *   NODE_ENV=development  -> pass through (no magic link needed locally)
 *
 * Uses jose (Edge-compatible). DO NOT import jsonwebtoken here — it
 * needs Node's crypto and won't run in the Edge runtime.
 */
import { verifyToken } from '@/lib/beta-auth';

const BYPASS_PREFIXES = ['/beta-access', '/api/beta/'];

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

function passThrough(): Response {
  return new Response(null, { status: 200, headers: { 'x-mw': 'pass' } });
}

export async function middleware(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (process.env.BETA_GATE_ENABLED === '0') return passThrough();
  if (process.env.NODE_ENV !== 'production') return passThrough();
  if (BYPASS_PREFIXES.some((p) => path.startsWith(p))) return passThrough();

  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)beta_session=([^;]+)/);
  const token = cookieMatch?.[1];

  if (token) {
    try {
      await verifyToken(token, 'beta-session', process.env.BETA_AUTH_SECRET!);
      return passThrough();
    } catch {
      /* fall through to redirect */
    }
  }

  const dest = new URL('/beta-access', url);
  dest.searchParams.set('next', path);
  return Response.redirect(dest, 302);
}
