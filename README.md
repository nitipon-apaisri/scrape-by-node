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

## Examples

```bash
curl http://localhost:3340/health

curl "http://localhost:3340/search?keyword=บริษัท&page=1"

curl "http://localhost:3340/profile/0107544000108"
```

First live scrape launches Chromium and may take **5–30 seconds**.

## Environment

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3340` | HTTP port |
| `DBD_BASE_URL` | `https://datawarehouse.dbd.go.th` | Target site |
| `DBD_HEADLESS` | `true` | Set `false` to debug WAF blocks |
| `DBD_NAV_TIMEOUT_MS` | `30000` | Navigation / selector timeout |
| `DBD_BROWSER_CHANNEL` | — | `chrome` or `msedge` to use installed browser |
| `DBD_DEBUG` | `false` | Save screenshot + HTML on failures |
| `DBD_BLOCK_ASSETS` | `true` | Skip images/fonts for faster loads |

If headless scraping returns empty results, try:

```env
DBD_HEADLESS=false
DBD_BROWSER_CHANNEL=chrome
DBD_DEBUG=true
```

## Scripts

```bash
pnpm start:dev    # watch mode
pnpm build        # compile to dist/
pnpm start:prod   # run compiled app
```

## Source

Playwright scraper ported from `comtech-crm-api` (`src/modules/dbd-lookup/providers/`).
