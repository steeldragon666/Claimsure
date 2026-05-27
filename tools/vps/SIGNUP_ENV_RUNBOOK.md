# ArchiveOne VPS Signup Environment Runbook

Use this when signup emails link to localhost, verification returns `401` after a deploy, or the Docker stack has been recreated with changed auth secrets.

## Required Production Values

Set these in the VPS production env file consumed by Docker Compose:

```dotenv
PUBLIC_BASE_URL=https://archiveone.com.au
APP_BASE_URL=https://archiveone.com.au
WEB_BASE_URL=https://archiveone.com.au

SESSION_JWT_SECRET=<stable-32-plus-character-random-secret>
SIGNUP_VERIFICATION_SECRET=<different-stable-32-plus-character-random-secret>
SESSION_COOKIE_NAME=archiveone_session
SESSION_TTL_SECONDS=86400

RESEND_API_KEY=<resend-production-key>
SIGNUP_FROM_ADDRESS=ArchiveOne <noreply@archiveone.com.au>
SIGNUP_EMAIL_MODE=email
```

`PUBLIC_BASE_URL` is the canonical public origin. `APP_BASE_URL` and `WEB_BASE_URL` stay as compatibility aliases while older code paths are being retired.

## Secret Rules

- Do not rotate `SESSION_JWT_SECRET` during normal redeploys. Rotating it logs everyone out.
- Do not rotate `SIGNUP_VERIFICATION_SECRET` during normal redeploys. Rotating it invalidates outstanding email verification links.
- The two secrets must be different in production.
- Never use the checked-in dev defaults in production.

Generate replacements only during an intentional rotation:

```bash
openssl rand -base64 48
```

## Apply On The VPS

From the application directory on `server.archiveone.com.au`:

```bash
cd /opt/archiveone
sudo cp .env.production .env.production.$(date +%Y%m%d-%H%M%S).bak
sudo nano .env.production
docker compose up -d --force-recreate api web
docker compose ps
```

If the compose file uses another env file path, edit that file instead of `.env.production`.

## Verify

After the containers are healthy, run:

```bash
curl -fsS https://archiveone.com.au/ >/dev/null
curl -fsS https://archiveone.com.au/signup >/dev/null
curl -fsS https://archiveone.com.au/healthz
curl -sS -X POST https://archiveone.com.au/v1/auth/signup \
  -H 'content-type: application/json' \
  -d '{}' | jq .
curl -sS -X POST https://archiveone.com.au/v1/auth/verify-email \
  -H 'content-type: application/json' \
  -d '{"token":"not-a-real-token"}' | jq .
```

Expected responses:

- `/` returns `200`
- `/signup` returns `200`
- `/healthz` returns `200`
- empty signup returns `422`
- junk verify token returns `401`

When `chore/signup-smoke-check` is merged, the same checks can be run with:

```bash
pnpm smoke:signup -- --base-url https://archiveone.com.au
```

## If Verification Still Fails

1. Confirm the email link starts with `https://archiveone.com.au/verify-email`.
2. Confirm `PUBLIC_BASE_URL`, `APP_BASE_URL`, and `WEB_BASE_URL` are visible inside the API container:

   ```bash
   docker compose exec api printenv | grep -E 'PUBLIC_BASE_URL|APP_BASE_URL|WEB_BASE_URL'
   ```

3. Confirm the auth secrets are stable across deploys by comparing the current env file with the timestamped backup.
4. Request a fresh signup link after any intentional `SIGNUP_VERIFICATION_SECRET` rotation.
5. Check API logs for `signup verification email failed` if the signup endpoint returns `202` with `manual_verification` or `5xx`.
