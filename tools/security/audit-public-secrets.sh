#!/usr/bin/env bash
# audit-public-secrets.sh — grep the working tree for byte patterns that look
# like leaked credentials. Operator reviews each hit; false positives expected.
#
# Exit codes:
#   0  no HIGH-confidence hits
#   1  one or more HIGH-confidence hits (Anthropic, Stripe live, Slack bot,
#      AWS access key, or any private-key PEM header)
#   2  invocation / tooling error
#
# Usage:
#   bash tools/security/audit-public-secrets.sh
#   bash tools/security/audit-public-secrets.sh path/to/subdir
#
# Findings are printed as:   <severity>  <type>  <file>:<line>  <prefix>...

set -euo pipefail

ROOT="${1:-.}"

if ! command -v grep >/dev/null 2>&1; then
  echo "grep not found" >&2
  exit 2
fi

# Use ripgrep if available (faster, respects .gitignore by default), otherwise
# fall back to GNU grep with a manual exclude list.
USE_RG=0
if command -v rg >/dev/null 2>&1; then
  USE_RG=1
fi

EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=.next
  --exclude-dir=.git
  --exclude-dir=build
  --exclude-dir=coverage
  --exclude-dir=.turbo
  --exclude-dir=.pnpm-store
  --exclude=audit-public-secrets.sh
)

# Self-exclude so this file's own patterns don't trigger.
SELF="$(basename "$0")"

HIGH_HITS=0
TOTAL_HITS=0

# Print a finding. Truncates the matched value to ~10 chars so we don't echo
# secrets into the terminal/log in full.
report() {
  local severity="$1"
  local kind="$2"
  local file="$3"
  local line="$4"
  local snippet="$5"
  # Truncate the snippet to the first 12 visible chars; replace anything past
  # that with an ellipsis. The point is to identify WHICH match without
  # printing the secret itself.
  local prefix
  prefix="$(printf '%s' "$snippet" | tr -d '\r' | cut -c1-12)"
  printf '%-6s  %-20s  %s:%s  %s...\n' "$severity" "$kind" "$file" "$line" "$prefix"
  TOTAL_HITS=$((TOTAL_HITS + 1))
  if [[ "$severity" == "HIGH" ]]; then
    HIGH_HITS=$((HIGH_HITS + 1))
  fi
}

# scan PATTERN KIND SEVERITY  — runs a recursive search and reports each match.
scan() {
  local pattern="$1"
  local kind="$2"
  local severity="$3"
  local results

  if [[ "$USE_RG" == "1" ]]; then
    results="$(rg --no-heading --line-number --color=never \
      --glob='!node_modules' --glob='!dist' --glob='!.next' \
      --glob='!.git' --glob='!build' --glob='!coverage' \
      --glob='!.turbo' --glob='!.pnpm-store' \
      --glob="!$SELF" \
      -e "$pattern" "$ROOT" 2>/dev/null || true)"
  else
    results="$(grep -rEn "${EXCLUDES[@]}" "$pattern" "$ROOT" 2>/dev/null || true)"
  fi

  if [[ -z "$results" ]]; then
    return 0
  fi

  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    # row format: file:line:content  (ripgrep and grep -n both produce this)
    local file line snippet
    file="$(printf '%s' "$row" | awk -F: '{print $1}')"
    line="$(printf '%s' "$row" | awk -F: '{print $2}')"
    snippet="$(printf '%s' "$row" | cut -d: -f3- | sed -E "s/^.*($pattern).*$/\\1/" | head -c 80)"
    report "$severity" "$kind" "$file" "$line" "$snippet"
  done <<< "$results"
}

echo "Scanning $ROOT for leaked credential patterns..."
echo
printf '%-6s  %-20s  %s\n' "SEV" "TYPE" "LOCATION  PREFIX"
echo "------  --------------------  --------------------------------"

# Anthropic — assemble the prefix in pieces to avoid self-match.
ANTHROPIC_PREFIX="sk-ant-"
ANTHROPIC_PREFIX+="api03-"
scan "${ANTHROPIC_PREFIX}[A-Za-z0-9_-]{20,}" "anthropic-api-key" "HIGH"

# Stripe live + test keys.
STRIPE_LIVE="sk_"
STRIPE_LIVE+="live_"
scan "${STRIPE_LIVE}[A-Za-z0-9]{20,}"  "stripe-live-key"    "HIGH"

STRIPE_TEST="sk_"
STRIPE_TEST+="test_"
scan "${STRIPE_TEST}[A-Za-z0-9]{20,}"  "stripe-test-key"    "MED"

# Slack bot and app-level tokens.
scan "xoxb-[0-9A-Za-z-]{10,}"          "slack-bot-token"    "HIGH"
scan "xapp-[0-9A-Za-z-]{10,}"          "slack-app-token"    "HIGH"

# SSH public keys (low severity — public material) + private key PEM headers
# (HIGH — these should never be in the repo).
scan "ssh-rsa AAAA[0-9A-Za-z+/=]{20,}"     "ssh-pubkey-rsa"      "LOW"
scan "ssh-ed25519 AAAA[0-9A-Za-z+/=]{20,}" "ssh-pubkey-ed25519"  "LOW"
scan "BEGIN OPENSSH PRIVATE KEY" "ssh-privkey-openssh" "HIGH"
scan "BEGIN RSA PRIVATE KEY"     "ssh-privkey-rsa"     "HIGH"
scan "BEGIN EC PRIVATE KEY"      "ssh-privkey-ec"      "HIGH"
scan "BEGIN PRIVATE KEY"         "pem-privkey-generic" "HIGH"

# AWS access key ID.
scan "AKIA[0-9A-Z]{16}"                "aws-access-key-id"   "HIGH"

# Loose generic-secret heuristic: keywords followed by a 40-char hex string.
# This is a "MED" severity — many genuine 40-hex strings exist (git SHAs,
# checksums). The operator must triage these manually.
scan "(secret|token|api_key|SECRET|TOKEN|API_KEY)[\"' :=]+[a-fA-F0-9]{40}" \
  "generic-40hex-secret" "MED"

echo
echo "Total findings: $TOTAL_HITS"
echo "HIGH-severity:  $HIGH_HITS"

if [[ "$HIGH_HITS" -gt 0 ]]; then
  echo
  echo "Action required: triage each HIGH finding. If it is a real credential,"
  echo "rotate per tools/security/CREDENTIAL_ROTATION.md and open an incident."
  exit 1
fi

echo "No HIGH-severity findings."
exit 0
