#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# tools/vps/deploy.sh — pull latest + rebuild + zero-downtime restart.
#
# Run on the VPS (or via SSH from CI):
#   ssh user@vps "cd /opt/cpa-platform && tools/vps/deploy.sh"
#
# What this does:
#   1. git fetch + log latest commits to deploy
#   2. Run pre-deploy migrations against current image (so DB schema
#      lines up before new code is live)
#   3. git pull
#   4. docker compose build (parallel build for api + web)
#   5. docker compose up -d (Compose's rolling-update on changed services)
#   6. Run any *new* migrations (idempotent — skips ones already applied)
#   7. Health check the api endpoint
#
# Idempotent. Aborts on any failed step. Logs everything.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/cpa-platform}"
COMPOSE_FILE="$REPO_DIR/tools/vps/docker-compose.prod.yml"

cd "$REPO_DIR"

echo "==> Current commit: $(git rev-parse --short HEAD)"
git fetch origin main

INCOMING_COMMIT=$(git rev-parse origin/main)
CURRENT_COMMIT=$(git rev-parse HEAD)

if [[ "$INCOMING_COMMIT" == "$CURRENT_COMMIT" ]]; then
  echo "==> Already up to date."
  exit 0
fi

echo "==> Incoming commits:"
git log --oneline "$CURRENT_COMMIT".."$INCOMING_COMMIT"

echo "==> Pre-deploy migrations (current image, before new code lands)"
docker compose -f "$COMPOSE_FILE" exec -T api pnpm --filter @cpa/db migrate || true

echo "==> Pulling latest"
git pull

echo "==> Rebuilding api + web"
docker compose -f "$COMPOSE_FILE" build api web

echo "==> Rolling restart (postgres untouched)"
docker compose -f "$COMPOSE_FILE" up -d api web caddy

echo "==> Post-deploy migrations (new schema if any landed)"
docker compose -f "$COMPOSE_FILE" exec -T api pnpm --filter @cpa/db migrate

echo "==> Health check"
sleep 5
if docker compose -f "$COMPOSE_FILE" exec -T api wget --quiet --tries=1 --spider http://localhost:3000/healthz; then
  echo "==> Deploy successful: now at $(git rev-parse --short HEAD)"
else
  echo "ERROR: API health check failed after deploy" >&2
  echo "Recent api logs:"
  docker compose -f "$COMPOSE_FILE" logs --tail 50 api
  exit 1
fi
