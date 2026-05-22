/**
 * Beta access gate — runs at the Vercel edge before every request.
 *
 * Reads beta_session cookie. If missing/invalid AND the path isn't a
 * gate-bypass (public marketing/signup pages, /beta-access, /api/beta/*, or static assets),
 * 302s to /beta-access?next=<original-path>.
 *
 * Toggles:
 *   BETA_GATE_ENABLED=0   -> pass through entirely (kill switch)
 *   NODE_ENV=development  -> pass through (no magic link needed locally)
 *
 * Uses jose (Edge-compatible). DO NOT import jsonwebtoken here — it
 * needs Node's crypto and won't run in the Edge runtime.
 *
 * CRITICAL: in Next.js middleware, returning a plain `new Response(...)`
 * SHORT-CIRCUITS the request — the client gets that response instead of
 * the matched route. To pass control to the actual page handler we MUST
 * return `NextResponse.next()`. A 200 from a plain Response would render
 * an empty body to every authorized user. See:
 *   https://nextjs.org/docs/app/api-reference/functions/next-response#next
 */
import { NextResponse } from 'next/server';
import { verifyToken } from '@/lib/beta-auth';

const BYPASS_PATHS = ['/', '/login', '/signup', '/verify-email'];
const BYPASS_PREFIXES = ['/beta-access', '/api/beta/', '/marketing/', '/v1/auth/'];

export const config = {
  // Match all paths except _next internals and the favicon. Static assets
  // are served by Vercel's edge before middleware runs, but documenting
  // the exclusion keeps the matcher self-explanatory.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export async function middleware(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Kill switch.
  if (process.env.BETA_GATE_ENABLED === '0') return NextResponse.next();

  // Local dev: don't require beta auth.
  if (process.env.NODE_ENV !== 'production') return NextResponse.next();

  // Bypass for public acquisition pages and the gate's own routes.
  if (BYPASS_PATHS.includes(path) || BYPASS_PREFIXES.some((p) => path.startsWith(p))) {
    return NextResponse.next();
  }

  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)beta_session=([^;]+)/);
  const token = cookieMatch?.[1];

  if (token) {
    try {
      await verifyToken(token, 'beta-session', process.env.BETA_AUTH_SECRET!);
      return NextResponse.next();
    } catch {
      /* fall through to redirect */
    }
  }

  const dest = new URL('/beta-access', url);
  dest.searchParams.set('next', path);
  return NextResponse.redirect(dest, 302);
}
