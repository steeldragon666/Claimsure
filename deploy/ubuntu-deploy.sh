#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git ufw

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

mkdir -p /opt/archiveone
if [ ! -d /opt/archiveone/.git ]; then
  git clone https://github.com/steeldragon666/ArchiveOne.git /opt/archiveone
else
  git -C /opt/archiveone pull --ff-only
fi

cd /opt/archiveone

if [ ! -f .env.production ]; then
  cp deploy/archiveone.env.example .env.production
  POSTGRES_PASSWORD="$(openssl rand -hex 32 | tr -d '\n')"
  CPA_APP_PASSWORD="$(openssl rand -hex 32 | tr -d '\n')"
  SESSION_JWT_SECRET="$(openssl rand -hex 48 | tr -d '\n')"
  SIGNUP_VERIFICATION_SECRET="$(openssl rand -hex 48 | tr -d '\n')"
  TOKEN_ENCRYPTION_KEY="$(openssl rand -hex 32 | tr -d '\n')"
  CLOUD_SYNC_TOKEN_KEY="$(openssl rand -hex 32 | tr -d '\n')"
  sed -i "s|replace-with-a-long-random-password|${POSTGRES_PASSWORD}|g" .env.production
  sed -i "s|replace-with-a-different-long-random-password|${CPA_APP_PASSWORD}|g" .env.production
  sed -i "s|replace-with-32-plus-random-bytes|${SESSION_JWT_SECRET}|g" .env.production
  sed -i "0,/replace-with-different-32-plus-random-bytes/s//${SIGNUP_VERIFICATION_SECRET}/" .env.production
  sed -i "s|replace-with-64-hex-chars|${TOKEN_ENCRYPTION_KEY}|" .env.production
  sed -i "0,/replace-with-64-hex-chars/s//${CLOUD_SYNC_TOKEN_KEY}/" .env.production
fi

docker compose --env-file .env.production -f compose.prod.yml build
docker compose --env-file .env.production -f compose.prod.yml --profile tools run --rm migrate
docker compose --env-file .env.production -f compose.prod.yml up -d
docker compose --env-file .env.production -f compose.prod.yml ps
