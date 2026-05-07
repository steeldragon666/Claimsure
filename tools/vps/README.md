# VPS staging deployment

Single-host Docker Compose deployment for cpa-platform on any Ubuntu 24.04+ VPS. Provider-agnostic — works on Hetzner, DigitalOcean, Vultr, Binary Lane, Linode, AWS Lightsail, etc.

**This is additive to the GCP production path.** `tools/gcp/*` remains the production target (Cloud SQL, Cloud Run, Secret Manager, Sentry routing, ISO 27001 supplier register entry). Use this VPS path for staging URLs, demos, or in-flight work while GCP setup awaits.

## What's here

| File                      | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `docker-compose.prod.yml` | Orchestrates postgres + api + web + caddy on a single host          |
| `Dockerfile.api`          | Multi-stage build for `apps/api` (pnpm monorepo aware)              |
| `Dockerfile.web`          | Multi-stage build for `apps/web` (Next.js standalone output)        |
| `Caddyfile`               | Auto-TLS reverse proxy (Let's Encrypt) + security headers           |
| `.env.production.example` | Env var template — copy to `.env.production` on host, NOT committed |
| `bootstrap.sh`            | One-shot Ubuntu setup: Docker + ufw + git clone + systemd unit      |
| `deploy.sh`               | Pull + rebuild + rolling restart + post-deploy migration            |

## Recommended provider specs

Any 4 GB+ Ubuntu 24.04 VPS works. Concrete suggestions:

| Provider          | Plan          | RAM / vCPU / Disk         | Region           | Price/mo |
| ----------------- | ------------- | ------------------------- | ---------------- | -------- |
| **Vultr**         | Cloud Compute | 4 GB / 2 vCPU / 80 GB     | Sydney           | ~$24     |
| **Binary Lane**   | Linux 4096    | 4 GB / 2 vCPU / 80 GB     | Sydney/Brisbane  | ~AU$25   |
| **Hetzner**       | CCX13         | 8 GB / 2 vCPU AMD / 80 GB | Helsinki/Ashburn | ~€13     |
| **DigitalOcean**  | Basic Droplet | 4 GB / 2 vCPU / 80 GB     | Sydney           | ~$24     |
| **AWS Lightsail** | $12 plan      | 4 GB / 2 vCPU / 80 GB     | Sydney           | $24      |

For **AU R&DTI data residency**, prefer Vultr Sydney or Binary Lane (Aussie-owned).

## First-time setup

### 1. Provision VPS

Spin up an Ubuntu 24.04 LTS VPS with the chosen provider. SSH in as a sudo-capable non-root user.

### 2. Point domain DNS

Set an `A` record at your registrar pointing your staging subdomain (e.g. `staging.cpa-platform.com.au`) at the VPS's public IPv4. **Do this BEFORE running bootstrap.sh** — Caddy's Let's Encrypt issuance fails if DNS isn't resolving yet.

Verify: `dig +short staging.cpa-platform.com.au` should return your VPS IP.

### 3. Run bootstrap

```bash
curl -fsSL https://raw.githubusercontent.com/steeldragon666/cpa-platform/main/tools/vps/bootstrap.sh | bash
```

This installs Docker + ufw + clones the repo to `/opt/cpa-platform` + sets up a systemd unit. **Log out and back in** after this so docker group membership takes effect.

### 4. Fill in env vars

```bash
cd /opt/cpa-platform
cp tools/vps/.env.production.example .env.production
nano .env.production
```

Generate fresh secrets:

```bash
# 32-byte hex (Postgres passwords)
openssl rand -hex 32

# 64-byte hex (SESSION_JWT_SECRET)
openssl rand -hex 64
```

External services to wire up:

- **Microsoft Entra OAuth** — register app at https://entra.microsoft.com, redirect URI = `https://your-domain/v1/auth/microsoft/callback`
- **Anthropic API** — get key from https://console.anthropic.com
- **Stripe** — use `sk_test_*` keys for staging; webhook secret comes from Stripe dashboard after pointing webhook at `https://your-domain/v1/billing/webhook`
- **Resend** — get key from https://resend.com (transactional email)
- **Sentry** — DSN from https://sentry.io (error tracking; optional)

### 5. Bring up the stack

```bash
sudo systemctl start cpa-platform
# OR for foreground / debug:
docker compose -f tools/vps/docker-compose.prod.yml up -d --build
```

First build takes ~5-10 min (pnpm install + Next.js build + multi-stage Docker layers). Subsequent rebuilds are faster thanks to Docker layer caching.

### 6. Run initial migrations

```bash
docker compose -f tools/vps/docker-compose.prod.yml exec api pnpm --filter @cpa/db migrate
```

This applies all migrations 0000-0072 (or whatever's on `main`).

### 7. Verify

```bash
# Container health
docker compose -f tools/vps/docker-compose.prod.yml ps
# Should show all 4 services as "healthy" (or "Up" for caddy which has no healthcheck)

# Endpoint check
curl -I https://your-domain/health
# Should return 200 OK with HSTS header

# Web smoke
curl -I https://your-domain/
# Should return 200 OK with Next.js response
```

If Caddy's TLS handshake fails on first request, give it 30 seconds — Let's Encrypt ACME challenge can take a moment to complete.

## Updating

```bash
# From your local machine:
ssh user@vps "cd /opt/cpa-platform && bash tools/vps/deploy.sh"
```

Or set up GitHub Actions to do this on every merge to a `staging` branch:

```yaml
# .github/workflows/deploy-vps-staging.yml
name: deploy vps staging
on:
  push:
    branches: [staging]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: deploy via ssh
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: cd /opt/cpa-platform && bash tools/vps/deploy.sh
```

(Not committed; create when needed.)

## Backups

The `cpa-postgres-data-prod` volume holds all claim data. Recommended backup pattern using `restic` (NOT included in the bootstrap):

```bash
# install restic
sudo apt-get install -y restic

# initialise repo on B2/S3/Backblaze (whatever's cheap)
export RESTIC_REPOSITORY=b2:cpa-platform-staging:/
export RESTIC_PASSWORD=<generated>
restic init

# nightly cron entry (/etc/cron.d/cpa-backup)
0 3 * * * root cd /opt/cpa-platform && \
  docker compose -f tools/vps/docker-compose.prod.yml exec -T postgres \
    pg_dump -U cpa cpa_prod | restic backup --stdin --stdin-filename cpa_prod.sql && \
  restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

For real production (GCP), Cloud SQL PITR is configured in `tools/gcp/cloudsql.tf` — that's the production backup story. The VPS pattern above is for staging only.

## Differences from GCP production path

| Concern            | VPS (this)                         | GCP production (`tools/gcp/`)                       |
| ------------------ | ---------------------------------- | --------------------------------------------------- |
| Postgres           | Self-hosted in Docker, single host | Cloud SQL with PITR + automatic backups             |
| Container runtime  | Docker on the VPS                  | Cloud Run (autoscaling)                             |
| Secrets            | `.env.production` file             | Secret Manager (audit-logged access)                |
| TLS                | Caddy auto-Let's-Encrypt           | Google-managed certs + Cloud Load Balancer          |
| Monitoring         | Sentry only                        | Sentry + Cloud Monitoring + alert routing           |
| Cost               | ~$25/mo                            | ~$300-500/mo                                        |
| Data residency     | Provider-dependent                 | australia-southeast1 (Sydney)                       |
| Compliance posture | Lighter — staging-grade            | ISO 27001 supplier register entry, full audit trail |

If you're considering this VPS path for actual production rather than staging, **consult the ISO 27001 implications**: the supplier register entry shipped in P9.0.6 documents Google Cloud as the data processor. Switching to a self-hosted VPS for production means a new supplier-register entry + SOA review.

## Uninstall

```bash
# Stop + remove containers
sudo systemctl stop cpa-platform
sudo systemctl disable cpa-platform
docker compose -f tools/vps/docker-compose.prod.yml down -v

# Remove repo
sudo rm -rf /opt/cpa-platform

# Remove systemd unit
sudo rm /etc/systemd/system/cpa-platform.service
sudo systemctl daemon-reload

# Remove Docker (optional)
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io
```

## Troubleshooting

**Caddy can't get Let's Encrypt cert:**

- DNS A-record must point at the VPS public IP — verify with `dig +short your-domain`
- Port 80 must be open (LE uses HTTP-01 challenge by default) — `sudo ufw status`
- Check Caddy logs: `docker compose -f tools/vps/docker-compose.prod.yml logs caddy`

**API container restarting:**

- Check logs: `docker compose -f tools/vps/docker-compose.prod.yml logs api`
- Common: missing env var (compose substitution shows `${VAR}` literally if not set)
- DB not ready: api waits on postgres healthcheck; if postgres logs show `relation "..." already exists`, run migrations: `docker compose ... exec api pnpm --filter @cpa/db migrate`

**Disk full from postgres growing:**

- `docker system prune -af --volumes` (CAREFUL — this deletes postgres data if container is down)
- Better: enlarge VPS disk or move postgres volume to a separate mount
