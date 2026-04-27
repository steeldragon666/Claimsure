import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * PWA magic-link landing — `/claimant/[claimant_id]/m?t=<token>` (T-C11).
 *
 * Server component. The flow:
 *
 *   1. Read `?t=<token>` from search params.
 *   2. POST it server-side to `/v1/claimant-auth/redeem`.
 *   3. On 200 — extract the Set-Cookie response header (the API issues
 *      `cpa_claimant_session=<jwt>; HttpOnly; SameSite=Lax; ...`),
 *      parse the cookie value out, and re-set it on the Next.js response
 *      via `cookies().set(...)` so the browser actually stores it. This
 *      double-hop is necessary because Set-Cookie from a same-server
 *      `fetch()` doesn't auto-flow to the user's browser — Next sees it
 *      on the inbound response, but only cookies set via `cookies()` make
 *      it into the outbound HTML response.
 *   4. Redirect to `/claimant/[claimant_id]/status`.
 *
 * On any failure (missing token, expired, already-consumed) we redirect
 * to a generic info page. No error UI here — the page exists for one
 * round-trip only.
 *
 * Why server-side: the alternative is a client-side page that POSTs from
 * the browser. That works for cookie storage (the browser auto-stores
 * httpOnly Set-Cookie), but means the token sits in `window.location`
 * for a frame and can be read by a window.opener. Server-side keeps the
 * token in transit only between the server and the API.
 */

interface Props {
  params: Promise<{ claimant_id: string }>;
  searchParams: Promise<{ t?: string }>;
}

const apiBaseUrl = (): string => {
  // INTERNAL_API_URL: server-to-server fetch target (Next.js server →
  // Fastify API). Set to the API's bind address in deploys; defaults to
  // localhost:3000 for `pnpm dev` (which matches the rewrite in
  // next.config.ts, just with the absolute scheme + host).
  return process.env['INTERNAL_API_URL'] ?? 'http://localhost:3000';
};

/**
 * Pull `cpa_claimant_session=...` out of a Set-Cookie header. Returns the
 * raw cookie value (the JWT) and the maxAge if found, else null.
 */
const parseClaimantSetCookie = (
  setCookie: string | null,
): { value: string; maxAge: number | null } | null => {
  if (!setCookie) return null;
  if (!setCookie.startsWith('cpa_claimant_session=')) return null;
  const semi = setCookie.indexOf(';');
  const eq = setCookie.indexOf('=');
  const value = setCookie.slice(eq + 1, semi >= 0 ? semi : undefined);
  const attrs = semi >= 0 ? setCookie.slice(semi + 1) : '';
  const maxAgeMatch = /Max-Age=(\d+)/i.exec(attrs);
  return {
    value,
    maxAge: maxAgeMatch ? Number(maxAgeMatch[1]) : null,
  };
};

export default async function ClaimantMagicLinkPage({ params, searchParams }: Props) {
  const { claimant_id } = await params;
  const { t } = await searchParams;

  if (!t) {
    redirect(`/claimant/${claimant_id}/expired`);
  }

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/v1/claimant-auth/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: t }),
      // Server-to-server — no cookie jar to drag along, and we want
      // every redeem to hit the API fresh (no Next response cache).
      cache: 'no-store',
    });
  } catch {
    redirect(`/claimant/${claimant_id}/expired`);
  }

  if (!res.ok) {
    redirect(`/claimant/${claimant_id}/expired`);
  }

  // Forward the API's Set-Cookie to the browser by re-setting it via
  // next/headers cookies(). The API sets httpOnly + sameSite=Lax + secure-
  // in-prod; we match those attributes here so the browser stores the
  // cookie identically.
  const setCookieHeader = res.headers.get('set-cookie');
  const parsed = parseClaimantSetCookie(setCookieHeader);
  if (!parsed) {
    // The API said 200 but didn't issue a cookie — defensive guard;
    // shouldn't happen in practice. Treat as expired.
    redirect(`/claimant/${claimant_id}/expired`);
  }

  const jar = await cookies();
  jar.set('cpa_claimant_session', parsed.value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env['NODE_ENV'] === 'production',
    ...(parsed.maxAge !== null ? { maxAge: parsed.maxAge } : {}),
  });

  redirect(`/claimant/${claimant_id}/status`);
}
