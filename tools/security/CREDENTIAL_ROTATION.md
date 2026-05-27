# Credential Rotation Runbook

> ArchiveOne — operational reference for rotating credentials after suspected
> exposure, on a schedule, or in response to an incident.

This runbook covers acute rotation events. For routine cadence and the full
production secret inventory, see [`tools/secrets/rotation-policy.md`](../secrets/rotation-policy.md).

## 1. Triggering events

Rotation is **mandatory** on any of the following:

- A credential value (or fragment that includes the prefix) was pasted into a
  chat client, AI assistant prompt, IM, ticket, email, or shared document.
- A document or repository containing a credential was shared with link-based
  access (`?usp=sharing`, public Gist, unlocked S3 object, etc.).
- Suspected or confirmed unauthorised access (anomalous logins, unexpected API
  usage, unknown SSH connections).
- Employee or contractor offboarding (any credential they could see or use).
- Scheduled annual rotation per the cadence table in `rotation-policy.md`.
- A static-analysis scan (e.g. `audit-public-secrets.sh`) flags a hit that
  cannot be ruled out as a false positive.

## 2. Credentials in scope

| Credential                       | Storage location                          | Rotation impact                                | Last rotated |
| -------------------------------- | ----------------------------------------- | ---------------------------------------------- | ------------ |
| SSH root key — `outside-magic.bnr.la` | Operator workstations + VPS `authorized_keys` | Loss of root access until new key installed   | —            |
| `ANTHROPIC_API_KEY`              | Railway env, `.env.production`            | Classifier/agents fail until redeployed       | —            |
| `EVAL_ANTHROPIC_API_KEY`         | GitHub Actions secrets                    | CI eval workflow fails until updated          | —            |
| `SESSION_JWT_SECRET`             | Railway env                               | Active sessions invalidated (forced re-login) | —            |
| `TOKEN_ENCRYPTION_KEY`           | Railway env                               | OAuth refresh tokens must be re-encrypted     | —            |
| `MICROSOFT_OIDC_CLIENT_SECRET`   | Railway env                               | Microsoft SSO fails until redeployed          | —            |
| `GOOGLE_OIDC_CLIENT_SECRET`      | Railway env                               | Google SSO fails until redeployed             | —            |
| `STRIPE_SECRET_KEY` (`sk_live_`) | Railway env                               | Payments + webhooks fail until redeployed     | —            |
| `STRIPE_WEBHOOK_SECRET`          | Railway env + Stripe dashboard            | Webhook signature validation breaks during cutover | —        |
| `DATABASE_URL` (app + migration) | Railway env                               | DB connections fail until redeployed          | —            |

## 3. Open incidents

| # | Incident                                                                                  | Discovered  | Status |
| - | ----------------------------------------------------------------------------------------- | ----------- | ------ |
| 1 | SSH `root@outside-magic.bnr.la` private key shared via link-shareable Google Doc          | 2026-05-27  | OPEN   |
| 2 | `ANTHROPIC_API_KEY` (production) pasted into Claude Code chat history; key compromised on 2026-05-27 | 2026-05-27  | OPEN   |

Both incidents must be closed by completing the relevant section of §4 below
and updating the row to `CLOSED` with the rotation date.

## 4. Rotation procedure

### 4.1 SSH keys (Binary Lane VPS)

Use `tools/security/rotate-ssh-key.sh` to generate the new keypair and print
the exact remote commands. The script does not execute SSH itself.

1. Run `bash tools/security/rotate-ssh-key.sh` on the operator workstation. It
   generates `~/.ssh/archiveone_admin` (ed25519) and prints subsequent steps.
2. From a session that still has the old key, append the new public key to
   `~/.ssh/authorized_keys` on the VPS (script prints the exact command).
3. Open a **new** terminal and verify the new key works:
   `ssh -i ~/.ssh/archiveone_admin -o IdentitiesOnly=yes root@outside-magic.bnr.la 'hostname'`.
4. Only after the new key works, remove the old key's line from
   `~/.ssh/authorized_keys` on the VPS (script prints the `sed -i` command).
5. Delete the old private key file from every workstation that had it.
6. Revoke the shared Google Doc (File → Share → restrict to specific people,
   or delete the doc entirely).
7. Review `/var/log/auth.log` on the VPS for unexpected sessions during the
   exposure window. Record findings in the incident notes.

### 4.2 Anthropic API key

1. Sign in to <https://console.anthropic.com> with the workspace owner account.
2. **Settings → API keys** → locate the compromised key (`sk-ant-api03-…`) →
   click **Disable** (immediate revocation).
3. Click **Create Key** to generate a replacement. Copy the value once.
4. Update the secret in deployment:
   - Railway: `railway variables set ANTHROPIC_API_KEY=<new>` (production
     environment), or paste into the Railway dashboard.
   - Local `.env.production` (operator copies only): replace the value.
   - GitHub Actions `EVAL_ANTHROPIC_API_KEY` if the eval key was also exposed.
5. Trigger a redeploy: `railway up` or merge a no-op commit to `main`.
6. Verify the classifier endpoint: `curl https://archiveone.com.au/api/health/anthropic`
   should return HTTP 200 with `{"ok":true}`.
7. Audit Anthropic console usage for the exposure window (Settings → Usage →
   filter by key). Note any unrecognised activity.

### 4.3 Session / JWT / token-encryption secrets

These invalidate all active sessions when rotated abruptly. Prefer the rolling
procedure in `tools/secrets/rotation-policy.md` §3.1, but if leaked, rotate
immediately:

1. Generate: `openssl rand -hex 32`.
2. Update `SESSION_JWT_SECRET` (or `TOKEN_ENCRYPTION_KEY`) in Railway.
3. Post in `#archiveone-ops` Slack: "Session reset at HH:MM — users will be
   prompted to sign in again."
4. Deploy. Confirm `/api/auth/session` returns 401 for stale cookies and 200
   after fresh login.
5. For `TOKEN_ENCRYPTION_KEY`, run the OAuth re-encryption migration noted in
   `rotation-policy.md` §3.1.

### 4.4 Stripe, Microsoft OIDC, Google OAuth client secrets

1. Provider console → generate new secret (do not revoke old one yet).
2. Update Railway env var; deploy.
3. Verify the relevant flow end-to-end (Stripe test charge / SSO login).
4. Revoke the old secret in the provider console.

For Stripe, rotate `STRIPE_WEBHOOK_SECRET` separately and use dual-validation
during the cutover (see `rotation-policy.md` §3.5).

## 5. Verification checklist

After any rotation, confirm before closing the incident:

- [ ] `https://archiveone.com.au/api/health` returns 200.
- [ ] `https://archiveone.com.au/api/health/anthropic` returns 200 (if Anthropic rotated).
- [ ] At least one production SSO login succeeds (if OIDC rotated).
- [ ] A test Stripe charge succeeds + webhook is received (if Stripe rotated).
- [ ] SSH login with the new key works from at least two operator workstations.
- [ ] Old SSH key no longer accepted: `ssh -i <old> root@outside-magic.bnr.la`
      fails with `Permission denied (publickey)`.
- [ ] Sentry shows no spike in 401/500 errors in the 30 minutes following
      deploy.
- [ ] `tools/secrets/rotation-policy.md` §5 (rotation tracking log) updated
      with the new "Last Rotated" date.
- [ ] §3 of this document updated — incident row marked `CLOSED` with date.

---

**Document control**

- Last reviewed: 2026-05-27
- Next review: 2026-08-27 (quarterly)
- Owner: Aaron
