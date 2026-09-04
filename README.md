# scrape-by-node

Minimal NestJS service that scrapes [DBD DataWarehouse](https://datawarehouse.dbd.go.th) via Playwright and returns plain JSON. No database, no auth, no cache.

## Setup

```bash
cd ~/Documents/personal/scrape-by-node
cp .env.example .env
pnpm install   # also runs `playwright install chromium`
pnpm start:dev
```

Default port: **3340**

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/search?keyword=&page=1` | Name search (paginated list) |
| GET | `/profile/:registrationNo` | Full profile by 13-digit reg no |
| GET | `/profile/:registrationNo/financial?year=` | Financial key figures per year (`years[]`) + charts |
| GET | `/profile/:registrationNo/financial/balance-sheet?year=` | Balance sheet table (งบแสดงฐานะการเงิน) matching DBD UI |

## Examples

```bash
curl http://localhost:3340/health

curl "http://localhost:3340/search?keyword=บริษัท&page=1"

curl "http://localhost:3340/profile/0107544000108"

curl "http://localhost:3340/profile/0105545087817/financial"

curl "http://localhost:3340/profile/0105545087817/financial?year=2568"

curl "http://localhost:3340/profile/0105545087817/financial/balance-sheet"
```

The financial endpoints accept an optional `year` query param — **พ.ศ.** (e.g. `2569`) or **ค.ศ.** (e.g. `2026`, auto-converted).

- `/financial` — key figures from `/fin/basics` (all filed years, or one year with `?year=`).
- `/financial/balance-sheet` — balance sheet from `/fin/balancesheet/year` (multi-year comparison table as shown on DBD; omit `year` for latest anchor year, or pass `?year=` for a single fiscal year).

Example response:

```json
{
  "registrationNo": "0105545087817",
  "years": [
    { "fiscalYear": 2561, "totalRevenue": 8000000, "netProfit": 100000, "totalAssets": 3000000, "...": "..." },
    { "fiscalYear": 2562, "totalRevenue": 9000000, "netProfit": 120000, "totalAssets": 3400000, "...": "..." }
  ],
  "charts": { "years": [2561, 2562], "totalRevenue": [...], "netProfit": [...], "totalAssets": [...], "shareholderEquity": [...] }
}
```

First live scrape launches Chromium and may take **5–30 seconds**.

## Environment

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3340` | HTTP port (Railway sets this automatically) |
| `DBD_BASE_URL` | `https://datawarehouse.dbd.go.th` | Target site |
| `DBD_HEADLESS` | `false` | Set `false` to bypass DBD WAF (required for reliable results) |
| `DBD_NAV_TIMEOUT_MS` | `30000` | Navigation / selector timeout |
| `DBD_BROWSER_CHANNEL` | — | `chrome` or `msedge` locally; leave empty in Docker/Railway |
| `DBD_DEBUG` | `false` | Save screenshot + HTML on failures |
| `DBD_BLOCK_ASSETS` | `true` | Skip images/fonts for faster loads |

For local development on macOS/Windows, headed mode opens a visible browser window:

```env
DBD_HEADLESS=false
DBD_BROWSER_CHANNEL=chrome
```

Enable debug snapshots temporarily if scraping fails:

```env
DBD_DEBUG=true
```

## Scripts

```bash
pnpm start:dev    # watch mode
pnpm build        # compile to dist/
pnpm start:prod   # run compiled app
```

## Deploy on Railway

This app runs as a **Docker container** with Playwright + Chromium. Railway must use the included `Dockerfile` (configured via `railway.toml`) — do not use Nixpacks auto-detect.

### Pre-deploy checklist

1. Push this repo to GitHub
2. [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Confirm the builder is **Dockerfile** (from `railway.toml`)

### Service settings

| Setting | Value |
|---------|-------|
| **Memory** | 2048 MB (minimum 1024 MB) |
| **Health check path** | `/health` |
| **Public networking** | Generate a domain |

### Environment variables (Railway dashboard)

| Variable | Value |
|----------|-------|
| `DBD_HEADLESS` | `false` |
| `DBD_BROWSER_CHANNEL` | *(leave empty)* |
| `DBD_DEBUG` | `false` |
| `DBD_BLOCK_ASSETS` | `true` |
| `DBD_NAV_TIMEOUT_MS` | `30000` |
| `DBD_BASE_URL` | `https://datawarehouse.dbd.go.th` |
| `PORT` | *(Railway injects automatically — do not hardcode)* |

The Docker image runs the app under `xvfb-run` so headed browser mode works on Linux without a physical display.

### Post-deploy smoke test

```bash
curl https://<your-app>.up.railway.app/health

curl "https://<your-app>.up.railway.app/search?keyword=บริษัท&page=1"
```

### Known risk

DBD may block Railway datacenter IPs even with headed mode. If `/search` returns empty results or WAF errors, check Railway logs and temporarily set `DBD_DEBUG=true` to capture snapshots.

### Local Docker test (optional)

```bash
docker build -t scrape-by-node .
docker run --rm -p 3340:3340 -e DBD_HEADLESS=false scrape-by-node
curl http://localhost:3340/health
```

## Source

Playwright scraper ported from `comtech-crm-api` (`src/modules/dbd-lookup/providers/`).
