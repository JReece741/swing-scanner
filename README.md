# Swing Scanner

A swing-trade setup scanner that screens US stocks for a specific 3-stage
technical pattern:

1. **Strong uptrend** — 20%+ move over multiple days/weeks, 10 & 20 SMA both
   rising, higher highs / higher lows.
2. **Pullback & consolidation** — price pulls back toward the 10/20 SMA,
   higher lows with same-or-lower highs (tightening range), volume declining.
3. **Breakout** — price breaks above the consolidation range on a volume
   surge.

Each candidate gets a 0–100 setup score (weighted: breakout 45%, pullback
35%, uptrend 20%), with a breakdown per stage and the specific reasons behind
the score. Results are shown as cards with candlestick + 10/20 SMA + volume
charts.

## Pre-screen filters

- At least 6 months of price history
- 1-month change > 5%
- ADR% (average daily range, 14-day) > 5%
- Price > $1
- Price × volume > $30M
- Sector is currently "bullish" (positive sector performance, computed live)

## Architecture

Because GitHub Pages is static-only and TradingView's screener can't be
scraped from the browser, this project uses:

- **Frontend**: static HTML/CSS/JS in `public/`, hosted on **Vercel**
  (free tier — supports both static files and serverless functions).
- **Data source**: [Financial Modeling Prep](https://site.financialmodelingprep.com/)
  (free tier: 250 requests/day) for the screener, sector performance, and
  historical OHLCV.
- **Scheduled scans**: a GitHub Action (`.github/workflows/scan.yml`) runs
  near NYSE open and close (covers EST/EDT) and commits the results to
  `data/latest.json` / `public/data/latest.json`. The page loads this file
  by default — no API key needed for normal browsing.
- **On-demand refresh**: the "Refresh now" button calls `/api/scan`, a
  Vercel serverless function that runs a live scan using a server-side
  API key (never exposed to the browser).

## Setup

### 1. Get an FMP API key

Sign up free at https://site.financialmodelingprep.com/ and grab your API
key from the dashboard.

### 2. Push this repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/swing-scanner.git
git push -u origin main
```

### 3. Add the API key as a GitHub secret (for scheduled scans)

In your GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**

- Name: `FMP_API_KEY`
- Value: your FMP API key

You can trigger the first scan manually: **Actions tab → Scheduled Scan →
Run workflow**. This populates `data/latest.json`.

### 4. Deploy to Vercel

1. Go to https://vercel.com and sign in with GitHub.
2. **Add New Project** → import your `swing-scanner` repo.
3. Framework preset: **Other** (it's a static site + serverless function,
   Vercel auto-detects `vercel.json`).
4. Add an environment variable:
   - Name: `FMP_API_KEY`
   - Value: your FMP API key
   - Scope: Production (and Preview if you want refresh to work on preview
     deploys too)
5. Deploy.

Your site will be live at `https://<project-name>.vercel.app` — works on
phone and computer, no extra setup needed.

### 5. (Optional) Custom domain

In Vercel: **Project → Settings → Domains** to add your own domain.

## Local development

```bash
npm install --no-save  # only needed if you add deps later
node scripts/run-scan.js   # requires FMP_API_KEY env var set locally
```

Then open `public/index.html` with a local static server (e.g.
`npx serve public`) — opening the file directly via `file://` will block the
`fetch()` call for `data/latest.json`.

To test the live "Refresh now" button locally, use the Vercel CLI:

```bash
npm i -g vercel
vercel dev
```

## Adjusting the scan

- **Filters**: edit `FILTERS` in `scripts/scanner.js`.
- **Scoring weights/logic**: edit `scorePattern()` in the same file.
- **Number of results**: change `limit` in `scripts/run-scan.js` / `api/scan.js`.
- **Schedule**: edit the cron expressions in `.github/workflows/scan.yml`
  (GitHub Actions cron is UTC).

## Disclaimer

This is an educational screening tool, not financial advice. Pattern scores
are heuristic approximations — always verify setups on a full chart before
trading, and manage risk accordingly.
