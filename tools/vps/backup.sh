#!/usr/bin/env bash
#
# ArchiveOne / CPA Platform nightly backup
# -----------------------------------------------------------------------------
# Dumps the cpa_prod database from the running cpa-postgres-prod container,
# gzips it to /var/backups/cpa, rotates local copies (keep 3), and pushes the
# backup directory to a restic S3-compatible repository with daily/weekly/
# monthly retention.
#
# Required env (typically loaded from /etc/cpa/backup.env via systemd):
#   RESTIC_REPOSITORY      e.g. s3:https://s3.ap-southeast-2.amazonaws.com/bucket
#   RESTIC_PASSWORD        restic repo password
#   AWS_ACCESS_KEY_ID      S3-compatible access key
#   AWS_SECRET_ACCESS_KEY  S3-compatible secret key
#
# Optional env:
#   POSTGRES_CONTAINER     defaults to cpa-postgres-prod
#   POSTGRES_DB            defaults to cpa_prod
#   POSTGRES_USER          defaults to postgres
#   BACKUP_DIR             defaults to /var/backups/cpa
#   LOG_FILE               defaults to /var/log/cpa-backup.log
#   LOCAL_KEEP             how many local dumps to retain (default 3)
#   DRY_RUN                if 1, print commands instead of executing
#
# Exits non-zero on any failure.
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Required env -----------------------------------------------------------
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

# --- Defaults ---------------------------------------------------------------
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-cpa-postgres-prod}"
POSTGRES_DB="${POSTGRES_DB:-cpa_prod}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cpa}"
LOG_FILE="${LOG_FILE:-/var/log/cpa-backup.log}"
LOCAL_KEEP="${LOCAL_KEEP:-3}"
DRY_RUN="${DRY_RUN:-0}"

export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DUMP_FILE="${BACKUP_DIR}/cpa_prod_${TIMESTAMP}.sql.gz"

# --- Logging ----------------------------------------------------------------
log() {
  local msg
  msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  printf '%s\n' "${msg}" | tee -a "${LOG_FILE}"
}

run() {
  # Run a command, logging it. Respects DRY_RUN.
  log "+ $*"
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi
  "$@"
}

on_error() {
  local rc="$?"
  log "ERROR: backup failed with exit code ${rc} on line ${BASH_LINENO[0]}"
  exit "${rc}"
}
trap on_error ERR

# --- Pre-flight -------------------------------------------------------------
log "==== cpa-backup start (dry_run=${DRY_RUN}) ===="

if [[ "${DRY_RUN}" != "1" ]]; then
  mkdir -p "${BACKUP_DIR}"
  mkdir -p "$(dirname "${LOG_FILE}")"
fi

# Verify docker & container are healthy before dumping.
if ! command -v docker >/dev/null 2>&1; then
  log "ERROR: docker not found in PATH"
  exit 1
fi

if [[ "${DRY_RUN}" != "1" ]]; then
  if ! docker inspect -f '{{.State.Running}}' "${POSTGRES_CONTAINER}" 2>/dev/null | grep -q true; then
    log "ERROR: container '${POSTGRES_CONTAINER}' is not running"
    exit 1
  fi
fi

# --- Step 1: pg_dump --------------------------------------------------------
log "Step 1/4: dumping ${POSTGRES_DB} from ${POSTGRES_CONTAINER} -> ${DUMP_FILE}"
if [[ "${DRY_RUN}" == "1" ]]; then
  log "+ docker exec ${POSTGRES_CONTAINER} pg_dump -U ${POSTGRES_USER} ${POSTGRES_DB} | gzip -9 > ${DUMP_FILE}"
else
  # Use a tmp file so a partial dump never lands at the final path.
  TMP_FILE="${DUMP_FILE}.partial"
  if ! docker exec "${POSTGRES_CONTAINER}" \
       pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" | gzip -9 > "${TMP_FILE}"; then
    log "ERROR: pg_dump pipeline failed"
    rm -f "${TMP_FILE}"
    exit 1
  fi
  mv "${TMP_FILE}" "${DUMP_FILE}"
  log "Dump complete: $(du -h "${DUMP_FILE}" | awk '{print $1}')"
fi

# --- Step 2: local rotation -------------------------------------------------
log "Step 2/4: rotating local dumps (keep most-recent ${LOCAL_KEEP})"
if [[ "${DRY_RUN}" == "1" ]]; then
  log "+ ls -1t ${BACKUP_DIR}/cpa_prod_*.sql.gz | tail -n +$((LOCAL_KEEP + 1)) | xargs -r rm -f"
else
  # ls -1t sorts newest first; keep first N, delete the rest.
  mapfile -t old_dumps < <(ls -1t "${BACKUP_DIR}"/cpa_prod_*.sql.gz 2>/dev/null | tail -n +$((LOCAL_KEEP + 1)) || true)
  if [[ "${#old_dumps[@]}" -gt 0 ]]; then
    for f in "${old_dumps[@]}"; do
      log "  removing old dump: ${f}"
      rm -f "${f}"
    done
  else
    log "  nothing to rotate"
  fi
fi

# --- Step 3: restic backup --------------------------------------------------
log "Step 3/4: restic backup -> ${RESTIC_REPOSITORY}"
if ! command -v restic >/dev/null 2>&1; then
  log "ERROR: restic not found in PATH"
  exit 1
fi

run restic backup \
  --tag "cpa-prod" \
  --tag "host:$(hostname -s)" \
  --host "$(hostname -s)" \
  "${BACKUP_DIR}"

# --- Step 4: restic forget + prune ------------------------------------------
log "Step 4/4: restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune"
run restic forget \
  --keep-daily 14 \
  --keep-weekly 8 \
  --keep-monthly 12 \
  --prune

log "==== cpa-backup success (${DUMP_FILE}) ===="
