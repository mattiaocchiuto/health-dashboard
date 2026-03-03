/**
 * Garmin Connect Proxy — Cloudflare Worker (OAuth2)
 * ─────────────────────────────────────────────────
 * Deploy at: https://dash.cloudflare.com → Workers → Create Worker → Paste → Deploy
 *
 * Auth flow:
 *   1. Garmin SSO login  → service ticket
 *   2. Ticket            → OAuth1 request token  (connectapi /oauth/preauthorized)
 *   3. OAuth1 token      → OAuth2 access token   (connectapi /oauth/exchange/user/2.0)
 *   4. Bearer token used for all data API calls  (connect.garmin.com + di-backend header)
 *
 * Endpoints exposed:
 *   POST /auth   { username, password }  → { token, displayName }
 *   POST /data   { token, date, displayName } → aggregated Garmin data
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SSO_HOST     = 'https://sso.garmin.com';
const CONNECT_HOST = 'https://connect.garmin.com';
const API_HOST     = 'https://connectapi.garmin.com';

const UA        = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MOBILE_UA = 'com.garmin.android.apps.connectmobile';

// OAuth1 consumer credentials — from garth's public S3 bucket (thegarth.s3.amazonaws.com)
const CONSUMER_KEY    = 'fc3e99d2-118c-44b8-8ae3-03370dde24c0';
const CONSUMER_SECRET = 'E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF';

// ── Cookie utilities ──────────────────────────────────────────────────────────

function parseCookies(headers) {
  const map = {};
  const raw = headers.getAll ? headers.getAll('set-cookie') : [];
  const lines = raw.length > 0 ? raw : (headers.get('set-cookie') || '').split(/,(?=[^ ])/);
  for (const line of lines) {
    const [pair] = line.trim().split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return map;
}

function cookieStr(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

function mergeCookies(existing, incoming) {
  return { ...existing, ...parseCookies(incoming) };
}

// ── OAuth1 HMAC-SHA1 signing ──────────────────────────────────────────────────

function pctEnc(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

async function hmacSha1Base64(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function oauth1AuthHeader(method, url, oauthToken = '', oauthTokenSecret = '') {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const oauthParams = {
    oauth_consumer_key:     CONSUMER_KEY,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_version:          '1.0',
  };
  if (oauthToken) oauthParams.oauth_token = oauthToken;

  // RFC 5849 §3.4.1: signature base string must include URL query params
  const urlObj = new URL(url);
  const queryParams = {};
  for (const [k, v] of urlObj.searchParams.entries()) queryParams[k] = v;

  // Merge query params + oauth params, sort, build normalised param string
  const allParams = { ...queryParams, ...oauthParams };
  const sorted = Object.entries(allParams).sort(([a], [b]) => a < b ? -1 : 1);
  const paramStr = sorted.map(([k, v]) => `${pctEnc(k)}=${pctEnc(v)}`).join('&');

  // Base URL is scheme + host + path (no query string)
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  const baseStr = `${method.toUpperCase()}&${pctEnc(baseUrl)}&${pctEnc(paramStr)}`;
  const signingKey = `${pctEnc(CONSUMER_SECRET)}&${pctEnc(oauthTokenSecret)}`;

  oauthParams.oauth_signature = await hmacSha1Base64(signingKey, baseStr);

  const parts = Object.entries(oauthParams).map(([k, v]) => `${pctEnc(k)}="${pctEnc(v)}"`).join(', ');
  return `OAuth ${parts}`;
}

// ── Garmin authentication ─────────────────────────────────────────────────────
// Flow mirrors garth (github.com/matin/garth) exactly.

async function garminAuth(username, password) {
  let cookies = {};

  const SSO       = `${SSO_HOST}/sso`;
  const SSO_EMBED = `${SSO}/embed`;
  const SSO_SIGNIN = `${SSO}/signin`;

  // garth's SSO_EMBED_PARAMS (used only for the initial cookie-setting GET)
  const embedParams = new URLSearchParams({
    id: 'gauth-widget', embedWidget: 'true', gauthHost: SSO,
  }).toString();

  // garth's SIGNIN_PARAMS (used for CSRF GET and credential POST)
  const signinParams = new URLSearchParams({
    id: 'gauth-widget', embedWidget: 'true',
    gauthHost: SSO_EMBED, service: SSO_EMBED,
    source: SSO_EMBED, redirectAfterAccountLoginUrl: SSO_EMBED,
    redirectAfterAccountCreationUrl: SSO_EMBED,
  }).toString();

  // 1. GET /sso/embed → set initial session cookies
  const embedResp = await fetch(`${SSO_EMBED}?${embedParams}`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    redirect: 'follow',
  });
  cookies = mergeCookies(cookies, embedResp.headers);

  // 2. GET /sso/signin → receive CSRF token
  const csrfResp = await fetch(`${SSO_SIGNIN}?${signinParams}`, {
    headers: {
      'User-Agent': UA, 'Accept': 'text/html',
      'Cookie': cookieStr(cookies),
      'Referer': `${SSO_EMBED}?${embedParams}`,
    },
    redirect: 'follow',
  });
  if (!csrfResp.ok) throw new Error(`SSO signin page failed: ${csrfResp.status}`);
  cookies = mergeCookies(cookies, csrfResp.headers);
  const csrfHtml = await csrfResp.text();

  // Extract CSRF — multi-pattern for robustness
  let csrf = null;
  const csrfTag = csrfHtml.match(/<input\b[^>]*\bname=["']_csrf["'][^>]*>/i);
  if (csrfTag) { const vm = csrfTag[0].match(/\bvalue=["']([^"']+)["']/i); if (vm) csrf = vm[1]; }
  if (!csrf) { const m = csrfHtml.match(/value=["']([^"']+)["'][^>]*name=["']_csrf["']/i); if (m) csrf = m[1]; }
  if (!csrf) { const m = csrfHtml.match(/"_csrf"\s*:\s*"([^"]+)"/); if (m) csrf = m[1]; }
  if (!csrf) throw new Error('CSRF token not found — Garmin may have changed their login page');

  // 3. POST credentials → follows redirects → success page contains ticket
  const loginResp = await fetch(`${SSO_SIGNIN}?${signinParams}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieStr(cookies), 'Origin': SSO_HOST,
      'Referer': `${SSO_SIGNIN}?${signinParams}`,
    },
    body: new URLSearchParams({ username, password, _csrf: csrf, embed: 'true' }).toString(),
    redirect: 'follow',
  });
  cookies = mergeCookies(cookies, loginResp.headers);
  const loginBody = await loginResp.text().catch(() => '');

  // Extract ticket from response body (garth: r'embed\?ticket=([^"]+)"')
  const ticketMatch = loginBody.match(/embed\?ticket=([^"'&\s<]+)/);
  if (!ticketMatch) {
    const isInvalid = loginBody.toLowerCase().includes('invalid') || loginBody.toLowerCase().includes('incorrect');
    if (isInvalid) throw new Error('Invalid username or password');
    throw new Error(`Login failed — no ticket in response. Status: ${loginResp.status}`);
  }
  const ticket = ticketMatch[1];

  // 4. GET preauth → OAuth1 token  (GET not POST; login-url is always /sso/embed per garth)
  const preAuthFullUrl = `${API_HOST}/oauth-service/oauth/preauthorized` +
    `?ticket=${encodeURIComponent(ticket)}` +
    `&login-url=${encodeURIComponent(SSO_EMBED)}` +
    `&accepts-mfa-tokens=true`;
  const preAuthResp = await fetch(preAuthFullUrl, {
    method: 'GET',
    headers: {
      'User-Agent': MOBILE_UA,
      'Authorization': await oauth1AuthHeader('GET', preAuthFullUrl),
    },
  });
  if (!preAuthResp.ok) {
    const t = await preAuthResp.text().catch(() => '');
    throw new Error(`OAuth1 preauth failed: ${preAuthResp.status} — ${t.slice(0, 300)}`);
  }
  const preAuthText = await preAuthResp.text();
  const oauth1Params = Object.fromEntries(new URLSearchParams(preAuthText));
  if (!oauth1Params.oauth_token) {
    throw new Error(`No OAuth1 token. Response: ${preAuthText.slice(0, 300)}`);
  }

  // 5. POST exchange → OAuth2 Bearer token
  const exchangeUrl = `${API_HOST}/oauth-service/oauth/exchange/user/2.0`;
  const exchangeResp = await fetch(exchangeUrl, {
    method: 'POST',
    headers: {
      'User-Agent': MOBILE_UA,
      'Authorization': await oauth1AuthHeader('POST', exchangeUrl, oauth1Params.oauth_token, oauth1Params.oauth_token_secret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  if (!exchangeResp.ok) {
    const t = await exchangeResp.text().catch(() => '');
    throw new Error(`OAuth2 exchange failed: ${exchangeResp.status} — ${t.slice(0, 300)}`);
  }
  const oauth2 = await exchangeResp.json();
  const accessToken = oauth2.access_token;
  if (!accessToken) throw new Error(`No OAuth2 access token. Keys: ${Object.keys(oauth2).join(', ')}`);

  // 6. Fetch display name via Bearer token
  const profileResp = await fetch(`${CONNECT_HOST}/userprofile-service/socialProfile`, {
    headers: {
      'User-Agent': UA, 'Authorization': `Bearer ${accessToken}`,
      'di-backend': 'connectapi.garmin.com',
    },
  });
  const profile = await profileResp.json().catch(() => ({}));
  const displayName = profile.displayName || profile.screenName || username.split('@')[0];

  return { token: accessToken, displayName };
}

// ── Garmin data fetching ──────────────────────────────────────────────────────

// Data requests go through connect.garmin.com (CDN) with di-backend routing to connectapi.
// Calling connectapi.garmin.com directly bypasses CDN-layer Bearer-token validation → 401.
function garminGet(path, bearerToken) {
  const url = path.startsWith('http') ? path : `${CONNECT_HOST}${path}`;
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Authorization': `Bearer ${bearerToken}`,
      'di-backend': 'connectapi.garmin.com',
      'Accept': 'application/json',
    },
  });
}

async function fetchAllData(token, date, displayName) {
  const startDate = new Date(date + 'T12:00:00Z');
  startDate.setUTCDate(startDate.getUTCDate() - 90);
  const startStr = startDate.toISOString().slice(0, 10);

  const [
    statsResp, sleepResp, hrvResp, readinessResp,
    trainingStatusResp, activitiesResp,
  ] = await Promise.all([
    garminGet(`/usersummary-service/usersummary/daily/${displayName}?calendarDate=${date}`, token),
    garminGet(`/wellness-service/wellness/dailySleep/${displayName}?date=${date}&nonSleepBufferMinutes=60`, token),
    garminGet(`/hrv-service/hrv/${date}`, token),
    garminGet(`/training-service/training/metrics/trainingReadiness/${date}`, token),
    garminGet(`/metrics-service/metrics/trainingStatus/aggregated/${date}`, token),
    garminGet(`/activitylist-service/activities/search/activities?startDate=${startStr}&endDate=${date}&limit=100&start=0`, token),
  ]);

  const responses = [statsResp, sleepResp, hrvResp, readinessResp, trainingStatusResp, activitiesResp];
  const labels = ['stats', 'sleep', 'hrv', 'readiness', 'trainingStatus', 'activities'];
  const debug = labels.map((l, i) => `${l}:${responses[i].status}`).join(', ');

  const errors = {};
  const texts = await Promise.all(responses.map(async (r, i) => {
    const text = await r.text().catch(() => '');
    if (!r.ok) errors[labels[i]] = text.slice(0, 300);
    return text;
  }));
  const parsed = texts.map(text => { try { return JSON.parse(text); } catch(e) { return null; } });

  const [stats, sleep, hrv, readiness, trainingStatus, activities] = parsed;
  const result = { date, displayName, stats, sleep, hrv, readiness, trainingStatus, activities, _debug: debug };
  if (Object.keys(errors).length) result._errors = errors;
  return result;
}

// ── Request handler ───────────────────────────────────────────────────────────

function jsonResponse(body, opts = {}) {
  return new Response(JSON.stringify(body), {
    status: opts.status || 200,
    headers: CORS,
  });
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    if (url.pathname === '/auth' && request.method === 'POST') {
      const { username, password } = await request.json();
      if (!username || !password) {
        return jsonResponse({ error: 'username and password required' }, { status: 400 });
      }
      const result = await garminAuth(username, password);
      return jsonResponse(result);
    }

    if (url.pathname === '/data' && request.method === 'POST') {
      const body = await request.json();
      const token = body.token;
      const date = body.date || new Date().toISOString().slice(0, 10);
      const displayName = body.displayName || '';
      if (!token) return jsonResponse({ error: 'token required' }, { status: 401 });
      const data = await fetchAllData(token, date, displayName);
      return jsonResponse(data);
    }

    return jsonResponse({ error: 'Not found' }, { status: 404 });

  } catch (err) {
    return jsonResponse({ error: err.message }, { status: 500 });
  }
}
