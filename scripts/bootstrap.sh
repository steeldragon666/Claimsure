#!/usr/bin/env bash
# CPA Platform — new-machine bootstrap (Mac / Linux / WSL).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/steeldragon666/cpa-platform/main/scripts/bootstrap.sh | bash
#
# Or after cloning:
#   ./scripts/bootstrap.sh
#
# What this does:
#   1. Verifies Node 22, pnpm 10.26.0, Docker, git are present (with install hints)
#   2. Clones the repo if not already inside it
#   3. Writes .env with auto-generated cryptographic secrets + sensible dev defaults
#      (CLASSIFIER_IMPL=stub, XERO_IMPL=stub — no external API keys needed for day-one)
#   4. Runs pnpm install, pnpm db:up, waits for Postgres healthy, pnpm db:migrate
#   5. Prints a summary and which env vars need manual filling for full functionality

set -euo pipefail

REPO_URL="https://github.com/steeldragon666/cpa-platform.git"
REPO_DIR_DEFAULT="cpa-platform"
NODE_MAJOR_REQUIRED=22
PNPM_VERSION_REQUIRED="10.26.0"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

color() { local c=$1; shift; printf '\033[%sm%s\033[0m\n' "$c" "$*"; }
info()  { color "0;36" "ℹ  $*"; }
ok()    { color "0;32" "✓  $*"; }
warn()  { color "0;33" "⚠  $*"; }
err()   { color "0;31" "✗  $*"; }
section() { printf '\n'; color "1;35" "── $* ──"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    color "0;33" "    $2"
    return 1
  fi
}

# Cross-platform random hex (32 bytes / 64 hex chars)
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    # Fallback for environments without openssl: use /dev/urandom
    head -c 32 /dev/urandom | xxd -p -c 64
  fi
}

# Cross-platform random base64 (32 bytes → ~43 base64 chars, padded to 44)
random_base64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64
  fi
}

# ---------------------------------------------------------------------------
# Pre-flight: tooling
# ---------------------------------------------------------------------------

section "Pre-flight"

MISSING=0

# Node 22.x
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
  if [ "$NODE_MAJOR" = "$NODE_MAJOR_REQUIRED" ]; then
    ok "Node $(node -v)"
  else
    err "Node $NODE_MAJOR detected; this repo requires Node $NODE_MAJOR_REQUIRED.x"
    color "0;33" "    Install via mise (recommended):  curl https://mise.run | sh && mise install node@$NODE_MAJOR_REQUIRED"
    color "0;33" "    Or via fnm:                       fnm install $NODE_MAJOR_REQUIRED && fnm use $NODE_MAJOR_REQUIRED"
    color "0;33" "    Or via nvm:                       nvm install $NODE_MAJOR_REQUIRED && nvm use $NODE_MAJOR_REQUIRED"
    MISSING=1
  fi
else
  err "node not found"
  color "0;33" "    Install Node 22 via mise / fnm / nvm (see https://nodejs.org)"
  MISSING=1
fi

# pnpm
if command -v pnpm >/dev/null 2>&1; then
  PNPM_INSTALLED=$(pnpm -v)
  if [ "$PNPM_INSTALLED" = "$PNPM_VERSION_REQUIRED" ]; then
    ok "pnpm $PNPM_INSTALLED"
  else
    warn "pnpm $PNPM_INSTALLED detected; pinned version is $PNPM_VERSION_REQUIRED (corepack will auto-fix on first command)"
  fi
else
  warn "pnpm not found — attempting to install via corepack"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare "pnpm@$PNPM_VERSION_REQUIRED" --activate
    ok "pnpm $(pnpm -v) installed via corepack"
  else
    err "corepack not available (ships with Node 16.10+; your Node install is broken or too old)"
    MISSING=1
  fi
fi

# Docker
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker daemon running"
  else
    err "Docker installed but daemon not running"
    color "0;33" "    macOS:  open -a 'Docker Desktop' (then wait ~30s)"
    color "0;33" "    Linux:  sudo systemctl start docker"
    MISSING=1
  fi
else
  err "docker not found"
  color "0;33" "    macOS:  brew install --cask docker  (or download Docker Desktop)"
  color "0;33" "    Linux:  https://docs.docker.com/engine/install/"
  MISSING=1
fi

# git
require_cmd git "Install git: https://git-scm.com/downloads" || MISSING=1

# gh (optional)
if command -v gh >/dev/null 2>&1; then
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
else
  warn "gh CLI not found (optional, but useful for PR workflow). Install: https://cli.github.com/"
fi

if [ "$MISSING" = "1" ]; then
  err "One or more required tools are missing — install them and re-run this script."
  exit 1
fi

# ---------------------------------------------------------------------------
# Clone (or skip if already in the repo)
# ---------------------------------------------------------------------------

section "Repo"

if [ -f "package.json" ] && grep -q '"name": "cpa-platform"' package.json 2>/dev/null; then
  ok "Already inside cpa-platform repo: $(pwd)"
elif [ -d "$REPO_DIR_DEFAULT" ]; then
  warn "Directory $REPO_DIR_DEFAULT/ exists; cd-ing into it"
  cd "$REPO_DIR_DEFAULT"
else
  info "Cloning $REPO_URL into $REPO_DIR_DEFAULT/"
  git clone "$REPO_URL" "$REPO_DIR_DEFAULT"
  cd "$REPO_DIR_DEFAULT"
  ok "Cloned to $(pwd)"
fi

# ---------------------------------------------------------------------------
# .env generation
# ---------------------------------------------------------------------------

section "Environment file"

if [ -f ".env" ]; then
  warn ".env already exists — leaving it alone (delete it first if you want a fresh template)"
else
  info "Generating .env with auto-generated dev secrets + stub-mode defaults"

  # Auto-generated secrets
  GEN_SESSION_JWT=$(random_base64 | tr -d '\n')
  GEN_TOKEN_ENC=$(random_hex)
  GEN_DOCUSIGN_HMAC=$(random_hex | head -c 32)

  cat > .env <<ENVEOF
# ─────────────────────────────────────────────────────────────────────────
# CPA Platform — local dev .env
# Generated by scripts/bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# Secrets in this file are LOCAL DEV ONLY. Real prod secrets live in your
# deployment platform (Fly/Vercel/etc.), never in this file.
# ─────────────────────────────────────────────────────────────────────────

# Postgres — host port 5433 to coexist with any native install on 5432.
# DATABASE_URL    — privileged migration runner (cpa role: superuser, table owner; bypasses RLS)
# DATABASE_URL_APP — application runtime (cpa_app role: NOSUPERUSER, NOBYPASSRLS; RLS applies)
DATABASE_URL=postgres://cpa:cpa@localhost:5433/cpa_dev
DATABASE_URL_APP=postgres://cpa_app:cpa_app_dev_pwd@localhost:5433/cpa_dev
DATABASE_POOL_MAX=10

# === Anthropic / Classifier ===
# CLASSIFIER_IMPL=stub  → deterministic regex fallback, no API key needed (recommended for day-one)
# CLASSIFIER_IMPL=haiku → real Anthropic Claude Haiku 4.5; requires ANTHROPIC_API_KEY below
CLASSIFIER_IMPL=stub
# Required only when CLASSIFIER_IMPL=haiku. Get from https://console.anthropic.com.
ANTHROPIC_API_KEY=
# Optional override of the Claude model. Defaults to the haiku-latest alias when unset.
# CLASSIFIER_MODEL=claude-haiku-4-5

# === Voyage AI (embeddings) ===
# Optional — only needed by code paths that compute embeddings.
VOYAGE_API_KEY=

# === Deepgram (audio transcription) ===
# Optional — used by jobs/transcribe.ts.
DEEPGRAM_API_KEY=

# === Grafana Cloud OTLP (telemetry) ===
# Optional — leave empty for local dev. App falls back to console logging.
GRAFANA_OTLP_ENDPOINT=
GRAFANA_OTLP_USERNAME=
GRAFANA_OTLP_PASSWORD=

# === API ===
API_PORT=3000
NODE_ENV=development
# LOG_LEVEL=info   # debug | info | warn | error

# === Session / Auth ===
# Auto-generated 32 bytes of entropy (base64). Rotate per-environment.
SESSION_JWT_SECRET=$GEN_SESSION_JWT
SESSION_TTL_SECONDS=86400
SESSION_COOKIE_NAME=cpa_session

# === OIDC — Microsoft Entra ===
# Routes only register when both CLIENT_ID and CLIENT_SECRET are set.
# Empty values are fine for day-one dev (those endpoints just won't exist).
MICROSOFT_OIDC_TENANT=common
MICROSOFT_OIDC_CLIENT_ID=
MICROSOFT_OIDC_CLIENT_SECRET=
MICROSOFT_OIDC_REDIRECT_URI=http://localhost:3000/v1/auth/microsoft/callback

# === OIDC — Google Workspace ===
GOOGLE_OIDC_CLIENT_ID=
GOOGLE_OIDC_CLIENT_SECRET=
GOOGLE_OIDC_REDIRECT_URI=http://localhost:3000/v1/auth/google/callback

# === Token encryption (Xero, integrations) ===
# Auto-generated 32 bytes of hex. Required even when integrations are stubbed
# because env validation runs at import time.
TOKEN_ENCRYPTION_KEY=$GEN_TOKEN_ENC

# === Xero accounting ===
# XERO_IMPL=stub  → returns canned fixture data, no real Xero account needed (recommended for day-one)
# XERO_IMPL=real  → live Xero API; requires the three vars below to be filled
XERO_IMPL=stub
XERO_ACCOUNTING_CLIENT_ID=dev-xero-client-id
XERO_ACCOUNTING_CLIENT_SECRET=dev-xero-client-secret
XERO_ACCOUNTING_REDIRECT_URI=http://localhost:3000/v1/integrations/xero-accounting/callback

# === DocuSign ===
# Optional. Leave empty unless you're working on the e-sign flow.
DOCUSIGN_CLIENT_ID=
DOCUSIGN_CLIENT_SECRET=
DOCUSIGN_ACCOUNT_ID=
DOCUSIGN_API_BASE_URL=
DOCUSIGN_AUTH_BASE_URL=
DOCUSIGN_REDIRECT_URI=http://localhost:3000/v1/integrations/docusign/callback
DOCUSIGN_WEBHOOK_HMAC_SECRET=$GEN_DOCUSIGN_HMAC

# === Integration callbacks ===
INTEGRATIONS_SUCCESS_REDIRECT=http://localhost:3001/integrations

# === Internal API URL (used by Next.js server-side fetches) ===
INTERNAL_API_URL=http://localhost:3000

# === White-label hostname routing ===
# DNS target firms point their custom domains at. Local-only placeholder.
PLATFORM_CNAME_TARGET=apex.localhost

# === Mobile (Expo) — set on the mobile build, not here ===
# EXPO_PUBLIC_API_URL=http://localhost:3000
# EXPO_PUBLIC_DEFAULT_BRAND_HOST=localhost:3001

# === P6 Agent feature flags (staged rollout) ===
# Default-on: unset or =true → enabled. Set =false to disable an agent
# without redeploying code (kill-switch semantics). Boolean parsing is
# strict — typos fall back to the default. See design doc §6.
P6_AGENT_A_ENABLED=true              # expenditure classifier (Haiku)
P6_AGENT_B_ENABLED=true              # activity register synthesizer (Sonnet)
P6_AGENT_C_ENABLED=true              # narrative drafter (Sonnet, streaming)
P6_AGENT_C_STREAMING_ENABLED=true    # if false, Agent C falls back to non-streaming response
P6_AGENT_TENANT_ALLOWLIST=           # csv of tenant_ids; empty=all. Phase 1 dogfood only.
ENVEOF

  ok ".env written ($(wc -l < .env | tr -d ' ') lines, secrets auto-generated)"
fi

# ---------------------------------------------------------------------------
# pnpm install
# ---------------------------------------------------------------------------

section "pnpm install"

pnpm install --prefer-offline 2>&1 | tail -3
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

section "Database"

info "Starting Postgres via docker compose..."
pnpm db:up 2>&1 | tail -3

info "Waiting for Postgres to report healthy (up to 60s)..."
for i in $(seq 1 30); do
  if docker compose ps postgres --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
    ok "Postgres healthy"
    break
  fi
  if [ "$i" = "30" ]; then
    err "Postgres did not report healthy in 60s. Check: docker compose logs postgres"
    exit 1
  fi
  sleep 2
done

info "Applying migrations (idx 0001 → 0025)..."
pnpm db:migrate 2>&1 | tail -5
ok "Schema up to date"

# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

section "Smoke test"

info "Running typecheck across all packages..."
if pnpm -r typecheck >/tmp/typecheck.log 2>&1; then
  ok "Typecheck clean (13 packages)"
else
  warn "Typecheck reported errors — see /tmp/typecheck.log"
fi

info "Running @cpa/schemas tests (no DB required, fast)..."
if pnpm --filter @cpa/schemas test >/tmp/schemas-test.log 2>&1; then
  ok "@cpa/schemas tests passing"
else
  warn "@cpa/schemas tests failed — see /tmp/schemas-test.log"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

section "Done"

cat <<SUMMARY

Repo:       $(pwd)
Branch:     $(git branch --show-current)
Latest:     $(git log --oneline -1)

Day-one config: CLASSIFIER_IMPL=stub, XERO_IMPL=stub. No external API keys needed.
The app will boot, the DB is migrated, and the test suite runs against fixtures.

To enable real integrations later, edit .env and fill in:

  ANTHROPIC_API_KEY              — for the real Haiku classifier (CLASSIFIER_IMPL=haiku)
  XERO_ACCOUNTING_CLIENT_ID      — for live Xero (XERO_IMPL=real). Plus _SECRET, _REDIRECT_URI.
  MICROSOFT_OIDC_CLIENT_ID + _SECRET — for Entra SSO routes
  GOOGLE_OIDC_CLIENT_ID + _SECRET    — for Google SSO routes
  VOYAGE_API_KEY                 — for embeddings
  DEEPGRAM_API_KEY               — for audio transcription jobs
  DOCUSIGN_CLIENT_ID + others    — for e-sign flow
  GRAFANA_OTLP_*                 — for telemetry export

Next steps:

  pnpm dev                       — start API + web in dev mode
  pnpm test                      — run the full test suite (needs DB; ~2 min)
  pnpm --filter @cpa/api test    — run only API tests

Read these next:
  docs/retros/2026-04-30-p5-retro.md   — what just shipped + P6 inheritance items
  README.md                            — project overview
  packages/db/src/audit-log.ts JSDoc   — canonical jsonb-binding pattern (reading this saves a debugging cycle)

Happy coding!
SUMMARY
