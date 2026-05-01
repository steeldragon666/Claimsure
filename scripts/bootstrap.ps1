# CPA Platform — new-machine bootstrap (Windows / PowerShell 7+).
#
# Usage:
#   iwr -UseBasicParsing https://raw.githubusercontent.com/steeldragon666/cpa-platform/main/scripts/bootstrap.ps1 | iex
#
# Or after cloning:
#   pwsh ./scripts/bootstrap.ps1
#
# What this does:
#   1. Verifies Node 22, pnpm 10.26.0, Docker, git are present (with install hints)
#   2. Clones the repo if not already inside it
#   3. Writes .env with auto-generated cryptographic secrets + sensible dev defaults
#      (CLASSIFIER_IMPL=stub, XERO_IMPL=stub — no external API keys needed for day-one)
#   4. Runs pnpm install, pnpm db:up, waits for Postgres healthy, pnpm db:migrate
#   5. Prints a summary and which env vars need manual filling for full functionality

#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/steeldragon666/cpa-platform.git'
$RepoDirDefault = 'cpa-platform'
$NodeMajorRequired = 22
$PnpmVersionRequired = '10.26.0'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Info($msg)    { Write-Host "i  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "+  $msg" -ForegroundColor Green }
function Write-Warn2($msg)   { Write-Host "!  $msg" -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "X  $msg" -ForegroundColor Red }
function Write-Section($msg) { Write-Host "`n-- $msg --" -ForegroundColor Magenta }

function Test-Cmd($name) {
  $null = Get-Command $name -ErrorAction SilentlyContinue
  return $?
}

function New-RandomHex {
  param([int]$Bytes = 32)
  $buf = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return -join ($buf | ForEach-Object { $_.ToString('x2') })
}

function New-RandomBase64 {
  param([int]$Bytes = 32)
  $buf = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return [Convert]::ToBase64String($buf)
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

Write-Section 'Pre-flight'

$missing = $false

# Node 22.x
if (Test-Cmd 'node') {
  $nodeVersion = (node -v).TrimStart('v')
  $nodeMajor = [int]($nodeVersion -split '\.')[0]
  if ($nodeMajor -eq $NodeMajorRequired) {
    Write-Ok "Node v$nodeVersion"
  } else {
    Write-Err "Node $nodeMajor detected; this repo requires Node $NodeMajorRequired.x"
    Write-Warn2 "    winget:  winget install OpenJS.NodeJS.LTS --version 22"
    Write-Warn2 "    fnm:     fnm install $NodeMajorRequired ; fnm use $NodeMajorRequired"
    $missing = $true
  }
} else {
  Write-Err 'node not found'
  Write-Warn2 '    winget install OpenJS.NodeJS.LTS --version 22'
  $missing = $true
}

# pnpm
if (Test-Cmd 'pnpm') {
  $pnpmInstalled = (pnpm -v)
  if ($pnpmInstalled -eq $PnpmVersionRequired) {
    Write-Ok "pnpm $pnpmInstalled"
  } else {
    Write-Warn2 "pnpm $pnpmInstalled detected; pinned version is $PnpmVersionRequired (corepack will auto-fix on first command)"
  }
} else {
  Write-Warn2 'pnpm not found - attempting install via corepack'
  if (Test-Cmd 'corepack') {
    corepack enable
    corepack prepare "pnpm@$PnpmVersionRequired" --activate
    Write-Ok "pnpm $(pnpm -v) installed via corepack"
  } else {
    Write-Err 'corepack not available - your Node install is missing it'
    $missing = $true
  }
}

# Docker
if (Test-Cmd 'docker') {
  $null = docker info 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok 'Docker daemon running'
  } else {
    Write-Err 'Docker installed but daemon not running'
    Write-Warn2 '    Start Docker Desktop (search Start menu) and wait ~30s'
    $missing = $true
  }
} else {
  Write-Err 'docker not found'
  Write-Warn2 '    winget install Docker.DockerDesktop'
  $missing = $true
}

# git
if (-not (Test-Cmd 'git')) {
  Write-Err 'git not found'
  Write-Warn2 '    winget install Git.Git'
  $missing = $true
} else {
  Write-Ok "git $(git --version | ForEach-Object { ($_ -split ' ')[2] })"
}

# gh (optional)
if (Test-Cmd 'gh') {
  Write-Ok "gh $((gh --version | Select-Object -First 1) -split ' ' | Select-Object -Index 2)"
} else {
  Write-Warn2 'gh CLI not found (optional). Install: winget install GitHub.cli'
}

if ($missing) {
  Write-Err 'One or more required tools are missing - install them and re-run.'
  exit 1
}

# ---------------------------------------------------------------------------
# Clone (or skip if already in the repo)
# ---------------------------------------------------------------------------

Write-Section 'Repo'

$inRepo = (Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match '"name":\s*"cpa-platform"')

if ($inRepo) {
  Write-Ok "Already inside cpa-platform repo: $(Get-Location)"
} elseif (Test-Path $RepoDirDefault) {
  Write-Warn2 "Directory $RepoDirDefault\ exists; cd-ing into it"
  Set-Location $RepoDirDefault
} else {
  Write-Info "Cloning $RepoUrl into $RepoDirDefault\"
  git clone $RepoUrl $RepoDirDefault
  Set-Location $RepoDirDefault
  Write-Ok "Cloned to $(Get-Location)"
}

# ---------------------------------------------------------------------------
# .env generation
# ---------------------------------------------------------------------------

Write-Section 'Environment file'

if (Test-Path '.env') {
  Write-Warn2 '.env already exists - leaving it alone (delete it first if you want a fresh template)'
} else {
  Write-Info 'Generating .env with auto-generated dev secrets + stub-mode defaults'

  $genSessionJwt = New-RandomBase64
  $genTokenEnc = New-RandomHex
  $genDocusignHmac = (New-RandomHex -Bytes 16)
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

  $envContent = @"
# ---------------------------------------------------------------------------
# CPA Platform - local dev .env
# Generated by scripts\bootstrap.ps1 on $stamp
#
# Secrets in this file are LOCAL DEV ONLY. Real prod secrets live in your
# deployment platform (Fly/Vercel/etc.), never in this file.
# ---------------------------------------------------------------------------

# Postgres - host port 5433 to coexist with any native install on 5432.
# DATABASE_URL    - privileged migration runner (cpa role: superuser, table owner; bypasses RLS)
# DATABASE_URL_APP - application runtime (cpa_app role: NOSUPERUSER, NOBYPASSRLS; RLS applies)
DATABASE_URL=postgres://cpa:cpa@localhost:5433/cpa_dev
DATABASE_URL_APP=postgres://cpa_app:cpa_app_dev_pwd@localhost:5433/cpa_dev
DATABASE_POOL_MAX=10

# === Anthropic / Classifier ===
# CLASSIFIER_IMPL=stub  -> deterministic regex fallback, no API key needed (recommended for day-one)
# CLASSIFIER_IMPL=haiku -> real Anthropic Claude Haiku 4.5; requires ANTHROPIC_API_KEY below
CLASSIFIER_IMPL=stub
# Required only when CLASSIFIER_IMPL=haiku. Get from https://console.anthropic.com.
ANTHROPIC_API_KEY=
# Optional override of the Claude model. Defaults to the haiku-latest alias when unset.
# CLASSIFIER_MODEL=claude-haiku-4-5

# === Voyage AI (embeddings) ===
VOYAGE_API_KEY=

# === Deepgram (audio transcription) ===
DEEPGRAM_API_KEY=

# === Grafana Cloud OTLP (telemetry) ===
GRAFANA_OTLP_ENDPOINT=
GRAFANA_OTLP_USERNAME=
GRAFANA_OTLP_PASSWORD=

# === API ===
API_PORT=3000
NODE_ENV=development
# LOG_LEVEL=info

# === Session / Auth ===
SESSION_JWT_SECRET=$genSessionJwt
SESSION_TTL_SECONDS=86400
SESSION_COOKIE_NAME=cpa_session

# === OIDC - Microsoft Entra ===
# Routes only register when both CLIENT_ID and CLIENT_SECRET are set.
MICROSOFT_OIDC_TENANT=common
MICROSOFT_OIDC_CLIENT_ID=
MICROSOFT_OIDC_CLIENT_SECRET=
MICROSOFT_OIDC_REDIRECT_URI=http://localhost:3000/v1/auth/microsoft/callback

# === OIDC - Google Workspace ===
GOOGLE_OIDC_CLIENT_ID=
GOOGLE_OIDC_CLIENT_SECRET=
GOOGLE_OIDC_REDIRECT_URI=http://localhost:3000/v1/auth/google/callback

# === Token encryption (Xero, integrations) ===
TOKEN_ENCRYPTION_KEY=$genTokenEnc

# === Xero accounting ===
XERO_IMPL=stub
XERO_ACCOUNTING_CLIENT_ID=dev-xero-client-id
XERO_ACCOUNTING_CLIENT_SECRET=dev-xero-client-secret
XERO_ACCOUNTING_REDIRECT_URI=http://localhost:3000/v1/integrations/xero-accounting/callback

# === DocuSign ===
DOCUSIGN_CLIENT_ID=
DOCUSIGN_CLIENT_SECRET=
DOCUSIGN_ACCOUNT_ID=
DOCUSIGN_API_BASE_URL=
DOCUSIGN_AUTH_BASE_URL=
DOCUSIGN_REDIRECT_URI=http://localhost:3000/v1/integrations/docusign/callback
DOCUSIGN_WEBHOOK_HMAC_SECRET=$genDocusignHmac

# === Integration callbacks ===
INTEGRATIONS_SUCCESS_REDIRECT=http://localhost:3001/integrations

# === Internal API URL (used by Next.js server-side fetches) ===
INTERNAL_API_URL=http://localhost:3000

# === White-label hostname routing ===
PLATFORM_CNAME_TARGET=apex.localhost

# === Mobile (Expo) - set on the mobile build, not here ===
# EXPO_PUBLIC_API_URL=http://localhost:3000
# EXPO_PUBLIC_DEFAULT_BRAND_HOST=localhost:3001

# === P6 Agent feature flags (staged rollout) ===
# Default-on: unset or =true -> enabled. Set =false to disable an agent
# without redeploying code (kill-switch semantics). Boolean parsing is
# strict - typos fall back to the default. See design doc section 6.
P6_AGENT_A_ENABLED=true              # expenditure classifier (Haiku)
P6_AGENT_B_ENABLED=true              # activity register synthesizer (Sonnet)
P6_AGENT_C_ENABLED=true              # narrative drafter (Sonnet, streaming)
P6_AGENT_C_STREAMING_ENABLED=true    # if false, Agent C falls back to non-streaming response
P6_AGENT_TENANT_ALLOWLIST=           # csv of tenant_ids; empty=all. Phase 1 dogfood only.
"@

  Set-Content -Path '.env' -Value $envContent -Encoding utf8 -NoNewline
  Write-Ok ".env written, secrets auto-generated"
}

# ---------------------------------------------------------------------------
# pnpm install
# ---------------------------------------------------------------------------

Write-Section 'pnpm install'

pnpm install --prefer-offline
Write-Ok 'Dependencies installed'

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

Write-Section 'Database'

Write-Info 'Starting Postgres via docker compose...'
pnpm db:up

Write-Info 'Waiting for Postgres to report healthy (up to 60s)...'
$healthy = $false
for ($i = 1; $i -le 30; $i++) {
  $status = docker compose ps postgres --format json 2>$null | Out-String
  if ($status -match '"Health":\s*"healthy"') {
    Write-Ok 'Postgres healthy'
    $healthy = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $healthy) {
  Write-Err 'Postgres did not report healthy in 60s. Check: docker compose logs postgres'
  exit 1
}

Write-Info 'Applying migrations (idx 0001 -> 0025)...'
pnpm db:migrate
Write-Ok 'Schema up to date'

# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

Write-Section 'Smoke test'

Write-Info 'Running typecheck across all packages...'
$typecheckLog = Join-Path $env:TEMP 'cpa-typecheck.log'
pnpm -r typecheck 2>&1 | Tee-Object -FilePath $typecheckLog | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Ok 'Typecheck clean (13 packages)'
} else {
  Write-Warn2 "Typecheck reported errors - see $typecheckLog"
}

Write-Info 'Running @cpa/schemas tests (no DB required, fast)...'
$schemasLog = Join-Path $env:TEMP 'cpa-schemas-test.log'
pnpm --filter @cpa/schemas test 2>&1 | Tee-Object -FilePath $schemasLog | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Ok '@cpa/schemas tests passing'
} else {
  Write-Warn2 "@cpa/schemas tests failed - see $schemasLog"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Section 'Done'

$summary = @"

Repo:       $(Get-Location)
Branch:     $(git branch --show-current)
Latest:     $(git log --oneline -1)

Day-one config: CLASSIFIER_IMPL=stub, XERO_IMPL=stub. No external API keys needed.
The app will boot, the DB is migrated, and the test suite runs against fixtures.

To enable real integrations later, edit .env and fill in:

  ANTHROPIC_API_KEY              - for the real Haiku classifier (CLASSIFIER_IMPL=haiku)
  XERO_ACCOUNTING_CLIENT_ID      - for live Xero (XERO_IMPL=real). Plus _SECRET, _REDIRECT_URI.
  MICROSOFT_OIDC_CLIENT_ID + _SECRET - for Entra SSO routes
  GOOGLE_OIDC_CLIENT_ID + _SECRET    - for Google SSO routes
  VOYAGE_API_KEY                 - for embeddings
  DEEPGRAM_API_KEY               - for audio transcription jobs
  DOCUSIGN_CLIENT_ID + others    - for e-sign flow
  GRAFANA_OTLP_*                 - for telemetry export

Next steps:

  pnpm dev                       - start API + web in dev mode
  pnpm test                      - run the full test suite (needs DB; ~2 min)
  pnpm --filter @cpa/api test    - run only API tests

Read these next:
  docs\retros\2026-04-30-p5-retro.md   - what just shipped + P6 inheritance items
  README.md                            - project overview
  packages\db\src\audit-log.ts JSDoc   - canonical jsonb-binding pattern (reading this saves a debugging cycle)

Happy coding!
"@

Write-Host $summary
