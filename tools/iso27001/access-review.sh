#!/usr/bin/env bash
set -euo pipefail

# ISO 27001 Access Review — Quarterly Report Generator
# Runs access review SQL queries against the production database.
#
# Prerequisites:
#   - DATABASE_URL environment variable must be set
#   - psql client installed
#   - Network access to the database
#
# Usage:
#   DATABASE_URL="postgres://..." ./tools/iso27001/access-review.sh

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL environment variable is not set." >&2
  echo "Usage: DATABASE_URL=\"postgres://...\" $0" >&2
  exit 1
fi

echo "=============================================="
echo " ISO 27001 Access Review Report"
echo " Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=============================================="
echo ""

echo "----------------------------------------------"
echo " 1. Active Users per Tenant"
echo "----------------------------------------------"
psql "$DATABASE_URL" -c "
SELECT
  t.name AS firm,
  u.email,
  tu.role,
  tu.created_at
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
JOIN \"user\" u ON u.id = tu.user_id
WHERE tu.deleted_at IS NULL
ORDER BY t.name, tu.role DESC, u.email;
"

echo ""
echo "----------------------------------------------"
echo " 2. Orphaned Users (no active tenant membership)"
echo "----------------------------------------------"
psql "$DATABASE_URL" -c "
SELECT
  u.email,
  u.created_at
FROM \"user\" u
LEFT JOIN tenant_user tu
  ON tu.user_id = u.id
  AND tu.deleted_at IS NULL
WHERE tu.id IS NULL;
"

echo ""
echo "----------------------------------------------"
echo " 3. Users with Admin Role"
echo "----------------------------------------------"
psql "$DATABASE_URL" -c "
SELECT
  t.name AS firm,
  u.email,
  tu.created_at AS admin_since
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
JOIN \"user\" u ON u.id = tu.user_id
WHERE tu.role = 'admin'
  AND tu.deleted_at IS NULL
ORDER BY t.name, u.email;
"

echo ""
echo "----------------------------------------------"
echo " 4. Recently Created Users (last 90 days)"
echo "----------------------------------------------"
psql "$DATABASE_URL" -c "
SELECT
  u.email,
  u.created_at,
  t.name AS firm,
  tu.role
FROM \"user\" u
JOIN tenant_user tu ON tu.user_id = u.id AND tu.deleted_at IS NULL
JOIN tenant t ON t.id = tu.tenant_id
WHERE u.created_at >= NOW() - INTERVAL '90 days'
ORDER BY u.created_at DESC;
"

echo ""
echo "----------------------------------------------"
echo " 5. Recently Removed Users (last 90 days)"
echo "----------------------------------------------"
psql "$DATABASE_URL" -c "
SELECT
  u.email,
  t.name AS firm,
  tu.role,
  tu.deleted_at AS removed_at
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
JOIN \"user\" u ON u.id = tu.user_id
WHERE tu.deleted_at IS NOT NULL
  AND tu.deleted_at >= NOW() - INTERVAL '90 days'
ORDER BY tu.deleted_at DESC;
"

echo ""
echo "=============================================="
echo " Report complete."
echo "=============================================="
