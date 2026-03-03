# Garmin PMC Dashboard

A self-contained, zero-dependency SPA that connects to Garmin Connect and displays training performance metrics, health vitals, and fitness analytics — including a full Performance Management Chart (PMC).

## Overview

The project is three files:

| File | Purpose |
|------|---------|
| `garmin-pmc-app.html` | Complete frontend — HTML, CSS, and vanilla JS in one file |
| `worker.js` | Cloudflare Worker that proxies Garmin SSO authentication and data fetching |
| `wrangler.toml` | Cloudflare Workers deployment configuration |

No build step, no package manager, no frontend dependencies.

---

## Features

**Training Performance**
- Performance Management Chart (PMC) — 90-day view of Fitness (CTL), Fatigue (ATL), and Form (TSB)
- Daily training load (hrTSS) estimated via Banister's TRIMP formula
- Training readiness score with sleep/recovery/load factor breakdown
- Training status (Productive, Maintaining, Overreaching, etc.) and VO₂ Max

**Health Vitals**
- Sleep duration, score, and stage breakdown (Deep / Light / REM)
- HRV overnight average and personal baseline range
- Body Battery (current, peak, lowest, charged/drained)
- Resting heart rate, heart rate range, and 7-day average
- Average and max stress level, average respiration rate

**Activity**
- Steps vs. daily goal with progress bar
- Distance, active/total calories, intensity minutes
- Recent 7-day activity feed with duration, average HR, distance, and calories

**PMC Methodology panel** — inline formulas explaining hrTSS, CTL, ATL, and TSB calculations.

---

## Architecture

```
Browser (garmin-pmc-app.html)
  → POST /auth   { username, password }
  → Cloudflare Worker authenticates via Garmin SSO → returns { token, displayName }
  → POST /data   { token, date, displayName }
  → Worker fetches 6 Garmin API endpoints in parallel → returns aggregated JSON
  → Dashboard renders KPIs, PMC chart, and activity cards
```

Credentials are never stored — the OAuth2 Bearer token is held in memory only for the duration of the session.

### Worker Auth Flow

1. `GET /sso/embed` — set initial Garmin SSO session cookies
2. `GET /sso/signin` — retrieve CSRF token
3. `POST /sso/signin` — submit credentials → receive service ticket
4. `GET /oauth/preauthorized` — exchange ticket for OAuth1 token (HMAC-SHA1 signed)
5. `POST /oauth/exchange/user/2.0` — exchange OAuth1 token for OAuth2 Bearer token
6. `GET /socialProfile` — fetch display name

### Garmin Endpoints Fetched

| Endpoint | Data |
|----------|------|
| `usersummary-service` | Daily stats (steps, HR, stress, calories, body battery) |
| `wellness-service` | Sleep summary and stage breakdown |
| `hrv-service` | Overnight HRV and baseline |
| `training-service` | Training readiness score |
| `metrics-service` | Training status and VO₂ Max |
| `activitylist-service` | Last 100 activities (90-day window) |

### PMC Calculations

Constants used (edit in `garmin-pmc-app.html` to match your physiology):

```
REST_HR = 40 bpm
MAX_HR  = 176 bpm
LTHR    = 160 bpm   ← lactate threshold heart rate
```

| Metric | Formula |
|--------|---------|
| hrTSS | `TRIMP × (100 / TRIMP_LTHR_1h)` where `TRIMP = t(min) × ΔHR × 0.64 × e^(1.92×ΔHR)` |
| CTL (Fitness) | 42-day exponential moving average of daily TSS |
| ATL (Fatigue) | 7-day exponential moving average of daily TSS |
| TSB (Form) | `CTL − ATL` |

TSB interpretation: `> 25` Tapered · `5–25` Race Ready · `-10–5` Maintenance · `-30 to -10` Optimal Training · `< -30` Overreaching Risk

> **Note:** hrTSS is an estimate. Exact TSS requires power meter or pace zone data.

---

## Setup

### Prerequisites

Install the Wrangler CLI (requires Node.js):

```bash
npm install -g wrangler
wrangler login
```

### 1. Set the worker secrets

The OAuth1 consumer credentials are stored as Cloudflare encrypted secrets — never in source code. Run these two commands and paste the values when prompted:

```bash
wrangler secret put CONSUMER_KEY
wrangler secret put CONSUMER_SECRET
```

The values (sourced from the public [garth](https://github.com/matin/garth) library):
- `CONSUMER_KEY` — `fc3e99d2-118c-44b8-8ae3-03370dde24c0`
- `CONSUMER_SECRET` — `E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF`

Secrets are encrypted at rest and are never visible in the Cloudflare dashboard after being set.

### 2. Deploy the worker

```bash
wrangler deploy
```

Copy the worker URL printed on success (e.g. `https://garmin-pmc-worker.your-subdomain.workers.dev`).

### 2. Open the Frontend

Open `garmin-pmc-app.html` directly in any modern browser — no server required.

On the login screen:
- **Worker URL** — paste the Cloudflare Worker URL from step 1
- **Garmin Email / Password** — your Garmin Connect credentials

Click **Connect**. The app authenticates, fetches today's data, and renders the dashboard.

---

## Usage

- **Date picker** (top-right of dashboard) — navigate to any historical date; the worker re-fetches data for that day
- **Refresh** button — re-fetches data for the currently selected date
- **Logout** — clears the in-memory token and returns to the login screen
- **PMC chart tooltip** — hover over the chart to see exact CTL/ATL/TSB/TSS values for any day

---

## Customising Your Physiology Constants

Open `garmin-pmc-app.html` and find the PMC constants near the top of the `<script>` block:

```js
const REST_HR = 40, MAX_HR = 176, LTHR = 160;
```

Set `REST_HR` to your true resting heart rate, `MAX_HR` to your measured max, and `LTHR` to your lactate threshold heart rate. These affect all hrTSS and PMC values.

---

## Privacy & Security

- Garmin credentials are sent only to your own Cloudflare Worker — never to any third party
- The OAuth2 Bearer token is held in JavaScript memory only; it is never written to `localStorage`, cookies, or any persistent storage
- The worker returns a CORS wildcard (`*`) by default — restrict this to your specific origin in production if desired

---

## Browser Requirements

Any modern browser with Canvas API support (Chrome, Firefox, Safari, Edge). Google Fonts (Syne, DM Mono) are loaded at runtime; the UI degrades gracefully to system fonts if offline.