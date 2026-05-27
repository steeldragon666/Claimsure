#!/usr/bin/env bash
# rotate-ssh-key.sh — generate a replacement SSH keypair for the ArchiveOne
# Binary Lane VPS (outside-magic.bnr.la) and print the exact commands an
# operator must run to install + verify + retire the old key.
#
# This script does NOT execute SSH itself. The operator runs the printed
# commands by hand so the network actions are auditable and gated by the
# operator's existing SSH agent / Yubikey prompt.
#
# Usage:
#   bash tools/security/rotate-ssh-key.sh
#   KEYPATH=~/.ssh/custom_name bash tools/security/rotate-ssh-key.sh
#   DRY_RUN=1 bash tools/security/rotate-ssh-key.sh   # print but do not write
#
# Env vars:
#   KEYPATH   target private-key path (default: ~/.ssh/archiveone_admin)
#   REMOTE    user@host of the VPS  (default: root@outside-magic.bnr.la)
#   DRY_RUN   if "1", skip ssh-keygen, only print the planned commands
#   COMMENT   key comment (default: archiveone-admin-<user>@<host>-<date>)

set -euo pipefail

KEYPATH="${KEYPATH:-$HOME/.ssh/archiveone_admin}"
REMOTE="${REMOTE:-root@outside-magic.bnr.la}"
DRY_RUN="${DRY_RUN:-0}"
COMMENT_DEFAULT="archiveone-admin-$(whoami)@$(hostname)-$(date +%Y%m%d)"
COMMENT="${COMMENT:-$COMMENT_DEFAULT}"

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

bold "ArchiveOne SSH key rotation"
echo
echo "  Target private key : $KEYPATH"
echo "  Remote host        : $REMOTE"
echo "  Key comment        : $COMMENT"
echo "  DRY_RUN            : $DRY_RUN"
echo

if [[ -e "$KEYPATH" && "$DRY_RUN" != "1" ]]; then
  red "Refusing to overwrite existing key at: $KEYPATH"
  echo "Remove it first, or set KEYPATH=<other-path>."
  exit 2
fi

mkdir -p "$(dirname "$KEYPATH")"
chmod 700 "$(dirname "$KEYPATH")" || true

# ---- Step 1: generate -------------------------------------------------------
bold "Step 1 — generate new ed25519 keypair"

if [[ "$DRY_RUN" == "1" ]]; then
  yellow "[DRY_RUN] would run: ssh-keygen -t ed25519 -a 100 -C '$COMMENT' -f '$KEYPATH' -N ''"
  PUBKEY_PLACEHOLDER="ssh-ed25519 AAAA<NEW_KEY_PUB> $COMMENT"
  PUBKEY="$PUBKEY_PLACEHOLDER"
else
  ssh-keygen -t ed25519 -a 100 -C "$COMMENT" -f "$KEYPATH" -N ""
  chmod 600 "$KEYPATH"
  PUBKEY="$(cat "${KEYPATH}.pub")"
  green "OK: generated $KEYPATH and ${KEYPATH}.pub"
fi

echo
echo "New public key:"
echo "  $PUBKEY"
echo

# ---- Step 2: install on the VPS --------------------------------------------
bold "Step 2 — install the new public key on $REMOTE"
echo
echo "Run this from a terminal that STILL HAS the old key loaded (so you can"
echo "authenticate). Do NOT close that terminal until step 3 succeeds."
echo
yellow "  ssh $REMOTE 'echo \"$PUBKEY\" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'"
echo

# ---- Step 3: verify ---------------------------------------------------------
bold "Step 3 — verify the new key works (in a fresh terminal)"
echo
echo "Open a NEW terminal window so your SSH agent does not silently fall back"
echo "to the old key. The IdentitiesOnly flag forces use of the new key only."
echo
yellow "  ssh -i $KEYPATH -o IdentitiesOnly=yes $REMOTE 'hostname && whoami && date'"
echo
echo "Expected output: hostname of the VPS, 'root', and current date."
echo

# ---- Step 4: retire the old key --------------------------------------------
bold "Step 4 — remove the OLD key from authorized_keys"
echo
echo "Only after Step 3 succeeded. Identify the old key's comment or fingerprint"
echo "first, then remove that exact line from ~/.ssh/authorized_keys on the VPS."
echo
echo "List current keys:"
yellow "  ssh -i $KEYPATH -o IdentitiesOnly=yes $REMOTE 'cat ~/.ssh/authorized_keys'"
echo
echo "Remove the old key's line (replace OLD_KEY_COMMENT with the actual comment):"
yellow "  ssh -i $KEYPATH -o IdentitiesOnly=yes $REMOTE \\"
yellow "      \"sed -i.bak '/OLD_KEY_COMMENT/d' ~/.ssh/authorized_keys\""
echo
echo "Confirm the old key is gone:"
yellow "  ssh -i $KEYPATH -o IdentitiesOnly=yes $REMOTE 'cat ~/.ssh/authorized_keys'"
echo

# ---- Step 5: delete local copies of the old key -----------------------------
bold "Step 5 — delete the OLD private key from every workstation"
echo
echo "On each operator workstation that had the old key (commonly ~/.ssh/id_rsa"
echo "or ~/.ssh/outside-magic), shred and remove it:"
echo
yellow "  shred -u ~/.ssh/<old-key-name>"
yellow "  rm -f ~/.ssh/<old-key-name>.pub"
echo
echo "If the old key was committed to a Google Doc, dotfiles repo, or backup,"
echo "remove it from those locations as well. Revoke the Google Doc share link."
echo

# ---- Step 6: post-rotation audit -------------------------------------------
bold "Step 6 — audit recent SSH access on the VPS"
echo
echo "Check for unexpected logins during the exposure window:"
yellow "  ssh -i $KEYPATH -o IdentitiesOnly=yes $REMOTE \\"
yellow "      'last -F | head -50 && tail -200 /var/log/auth.log'"
echo
echo "Record findings in the incident notes in tools/security/CREDENTIAL_ROTATION.md §3."
echo

green "Done. Follow the steps above in order. Do not skip Step 3."
