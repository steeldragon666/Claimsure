#!/usr/bin/env bash
# rotate-jwt-secret.sh — Rolling rotation of SESSION_JWT_SECRET
#
# Usage:
#   ./tools/secrets/rotate-jwt-secret.sh
#
# This script generates a new JWT signing secret and provides instructions
# for a zero-downtime rolling rotation. The 24-hour transition period ensures
# all existing sessions (SESSION_TTL_SECONDS=86400) expire naturally before
# the old key is retired.
#
# The script is provider-agnostic — adapt the "deploy" steps to your
# secrets manager (AWS Secrets Manager, GCP Secret Manager, Fly.io secrets,
# Vercel env vars, etc.).

set -euo pipefail

# --- Generate new secret ---------------------------------------------------

NEW_SECRET=$(openssl rand -hex 32)

echo "============================================================"
echo "  SESSION_JWT_SECRET Rolling Rotation"
echo "============================================================"
echo ""
echo "New secret generated (32 bytes / 64 hex chars):"
echo ""
echo "  ${NEW_SECRET}"
echo ""

# --- Instructions -----------------------------------------------------------

cat <<'INSTRUCTIONS'
------------------------------------------------------------
  Step 1: Deploy with dual keys (start transition)
------------------------------------------------------------

Move the CURRENT secret to the "previous" slot and set the
new one as primary. Your application must verify incoming
JWTs against BOTH keys (new first, then previous) and sign
all new JWTs with the new key only.

  # AWS Secrets Manager example:
  #   CURRENT=$(aws secretsmanager get-secret-value \
  #     --secret-id cpa/SESSION_JWT_SECRET \
  #     --query SecretString --output text)
  #
  #   aws secretsmanager put-secret-value \
  #     --secret-id cpa/SESSION_JWT_SECRET_PREVIOUS \
  #     --secret-string "$CURRENT"
  #
  #   aws secretsmanager put-secret-value \
  #     --secret-id cpa/SESSION_JWT_SECRET \
  #     --secret-string "<new-secret-from-above>"

  # Generic env var approach (Fly.io / Vercel / .env):
  #   1. Copy current SESSION_JWT_SECRET value
  #   2. Set SESSION_JWT_SECRET_PREVIOUS=<old-value>
  #   3. Set SESSION_JWT_SECRET=<new-secret-from-above>
  #   4. Deploy

------------------------------------------------------------
  Step 2: Wait 24 hours
------------------------------------------------------------

The session TTL is 86 400 seconds (24 hours). After one full
TTL cycle, all sessions signed with the old key will have
expired naturally. Monitor for:

  - 401 Unauthorized spikes in Grafana / Sentry
  - Elevated error rates on /v1/auth/* endpoints
  - User-reported login issues

If errors spike, roll back by restoring the old secret as
SESSION_JWT_SECRET (the new secret becomes PREVIOUS).

------------------------------------------------------------
  Step 3: Retire old key (end transition)
------------------------------------------------------------

After 24 hours with no issues:

  1. Remove SESSION_JWT_SECRET_PREVIOUS from the environment
  2. Deploy to confirm the app starts without the old key
  3. Update the rotation tracking log:
     tools/secrets/rotation-policy.md §5

  # AWS Secrets Manager:
  #   aws secretsmanager delete-secret \
  #     --secret-id cpa/SESSION_JWT_SECRET_PREVIOUS \
  #     --force-delete-without-recovery

  # Generic: unset or delete SESSION_JWT_SECRET_PREVIOUS

------------------------------------------------------------
  Rotation complete
------------------------------------------------------------

Record the rotation in the tracking log:

  Secret:       SESSION_JWT_SECRET
  Rotated:      $(date -u +%Y-%m-%d)
  Next due:     $(date -u -d "+90 days" +%Y-%m-%d 2>/dev/null || echo "<+90 days>")
  Rotated by:   <your-name>

INSTRUCTIONS

echo "============================================================"
echo "  Done. Follow the three steps above to complete rotation."
echo "============================================================"
