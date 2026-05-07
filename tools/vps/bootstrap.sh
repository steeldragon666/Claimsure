#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# tools/vps/bootstrap.sh — one-shot Ubuntu 24.04 setup for cpa-platform
# staging deployment.
#
# Run ONCE on a fresh VPS as a sudo-capable user (NOT root):
#   curl -fsSL https://raw.githubusercontent.com/<org>/cpa-platform/main/tools/vps/bootstrap.sh | bash
#
# What this does:
#   - Installs Docker Engine + compose plugin (NOT Docker Desktop)
#   - Installs git, ufw, fail2ban, unattended-upgrades
#   - Configures ufw firewall (22 ssh, 80 http, 443 https; everything else denied)
#   - Enables unattended-upgrades for security patches
#   - Clones cpa-platform to /opt/cpa-platform
#   - Sets up systemd unit so the stack starts on boot
#
# What this does NOT do:
#   - Fill in .env.production (you do that manually after first run)
#   - Configure DNS (you do that at your registrar before bootstrap)
#   - Start the containers (run `docker compose up -d --build` after env is set)
#
# Idempotent: re-running is safe.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve repo URL — override via REPO_URL env var if forked.
REPO_URL="${REPO_URL:-https://github.com/steeldragon666/cpa-platform.git}"
REPO_DIR="${REPO_DIR:-/opt/cpa-platform}"

# ── Sanity checks ───────────────────────────────────────────────────────
if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: Run as a non-root user with sudo, NOT as root." >&2
  exit 1
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo "ERROR: sudo not installed; please install or run as root with caveats." >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]] || ! grep -q "Ubuntu" /etc/os-release; then
  echo "WARNING: This script is tested on Ubuntu 24.04 LTS only. Continue? (y/N)" >&2
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]] || exit 1
fi

# ── apt updates + base packages ─────────────────────────────────────────
echo "==> Updating apt + installing base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq \
  ca-certificates \
  curl \
  git \
  gnupg \
  ufw \
  fail2ban \
  unattended-upgrades \
  apt-transport-https

# ── Docker Engine (NOT Docker Desktop) ──────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  # Allow current user to run docker without sudo
  sudo usermod -aG docker "$USER"
  echo "==> Added $USER to docker group; you must log out + back in for this to take effect."
else
  echo "==> Docker already installed: $(docker --version)"
fi

# ── Firewall ────────────────────────────────────────────────────────────
echo "==> Configuring ufw (22 ssh, 80 http, 443 https)"
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'ssh'
sudo ufw allow 80/tcp comment 'http (Caddy auto-redirect to https)'
sudo ufw allow 443/tcp comment 'https'
sudo ufw --force enable

# ── Unattended security upgrades ────────────────────────────────────────
echo "==> Enabling unattended-upgrades for security patches"
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

# ── Clone repo ──────────────────────────────────────────────────────────
if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "==> Cloning $REPO_URL → $REPO_DIR"
  sudo mkdir -p "$REPO_DIR"
  sudo chown "$USER":"$USER" "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "==> Repo already cloned at $REPO_DIR; pulling latest"
  cd "$REPO_DIR"
  git pull
fi

# ── systemd unit for boot-on-startup ────────────────────────────────────
echo "==> Installing systemd unit"
sudo tee /etc/systemd/system/cpa-platform.service >/dev/null <<EOF
[Unit]
Description=cpa-platform Docker Compose stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env.production
ExecStart=/usr/bin/docker compose -f tools/vps/docker-compose.prod.yml up -d --build
ExecStop=/usr/bin/docker compose -f tools/vps/docker-compose.prod.yml down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cpa-platform.service
echo "==> systemd unit enabled; will start on boot once .env.production exists."

# ── Final instructions ──────────────────────────────────────────────────
cat <<'EOF'

╔══════════════════════════════════════════════════════════════════════╗
║
║  Bootstrap complete!
║
║  Remaining manual steps:
║
║  1. Log out + back in (so docker group membership applies)
║
║  2. Point your domain's DNS A-record at this VPS's public IP:
║       curl ifconfig.me
║
║  3. Copy the env template + fill in secrets:
║       cd /opt/cpa-platform
║       cp tools/vps/.env.production.example .env.production
║       nano .env.production    # generate fresh secrets
║
║  4. Bring up the stack:
║       sudo systemctl start cpa-platform
║       OR
║       cd /opt/cpa-platform
║       docker compose -f tools/vps/docker-compose.prod.yml up -d --build
║
║  5. Run database migrations (one-off):
║       docker compose -f tools/vps/docker-compose.prod.yml exec api \
║         pnpm --filter @cpa/db migrate
║
║  6. First request to https://your-domain triggers Caddy's Let's
║     Encrypt cert issuance (DNS must be pointed first).
║
║  Logs: sudo systemctl status cpa-platform
║         docker compose -f tools/vps/docker-compose.prod.yml logs -f
║
╚══════════════════════════════════════════════════════════════════════╝
EOF
