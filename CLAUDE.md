# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Garmin Performance Management Chart (PMC) Dashboard — a self-contained SPA that connects to Garmin Connect via a Cloudflare Worker proxy to display training performance metrics, health vitals, and fitness analytics.

The entire project is two files with no build system, no package manager, and no dependencies:

- **garmin-pmc-app.html** — Complete frontend (HTML/CSS/vanilla JS) with embedded styles and logic
- **worker.js** — Cloudflare Worker that proxies Garmin SSO authentication and data fetching

## Architecture

### Data Flow

```
Browser (garmin-pmc-app.html)
  → POST /auth to Cloudflare Worker (garmin credentials)
  → Worker authenticates via Garmin SSO, returns session token
  → GET /data?token=...&date=... to Worker
  → Worker fetches 7 Garmin API endpoints in parallel
  → Dashboard renders data (KPIs, PMC chart, activities)
```

### Frontend State

Global `state` object holds worker URL, session token (memory-only, never persisted), display name, cached Garmin response, and computed PMC series. Screen routing is class-based (`.active` toggles login vs dashboard).

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `doLogin()` | HTML | Auth flow + initial data fetch |
| `renderDash(data)` | HTML | Generates full dashboard HTML from API response |
| `drawChart(series)` | HTML | Canvas-based PMC chart with tooltip interaction |
| `computePMC(activities)` | HTML | Calculates CTL/ATL/TSB from activity history using EMA |
| `garminAuth(username, password)` | worker.js | Garmin SSO cookie-chain authentication |
| `fetchAllData(token, date)` | worker.js | Parallel fetch of all Garmin data endpoints |

### PMC Calculations

Uses Banister's TRIMP formula for hrTSS estimation. Key constants: `REST_HR=40`, `MAX_HR=176`, `LTHR=160`. CTL uses 42-day exponential moving average, ATL uses 7-day.

### Worker Endpoints

- `POST /auth` — Accepts `{username, password}`, returns `{token, displayName}`
- `GET /data` — Accepts `token` and `date` query params, returns aggregated Garmin data

## Development

No build step required. Open `garmin-pmc-app.html` directly in a browser. The Worker requires deployment to Cloudflare Workers.

External resources loaded at runtime: Google Fonts (Syne, DM Mono).
