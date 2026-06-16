// netlify/functions/health-data.js
// Google Health API v4 — correct implementation
// Data type: "exercise" (kebab-case in URL, snake_case in filter)
// Filter: filter=exercise.interval.civil_start_time >= "YYYY-MM-DDTHH:MM:SS"
// Scope: googlehealth.activity_and_fitness.readonly (already granted)

const https = require('https');
const querystring = require('querystring');

// ── HTTP helper ──────────────────────────────────────────────────────────────
function get(url, accessToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Token refresh ────────────────────────────────────────────────────────────
async function refreshToken(refreshTok) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify({
      refresh_token: refreshTok,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    });
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso) - new Date(startIso);
  if (ms <= 0) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}min` : `${m} min`;
}

function getActivityName(type) {
  const map = {
    'WEIGHTS': 'Weights', 'WEIGHT_TRAINING': 'Weights', 'WEIGHTS_TRAINING': 'Weights',
    'STRENGTH_TRAINING': 'Strength Training', 'FUNCTIONAL_STRENGTH_TRAINING': 'Functional Training',
    'ROWING_MACHINE': 'Row Machine', 'ROWING': 'Row Machine',
    'RUNNING': 'Running', 'CYCLING': 'Cycling', 'SWIMMING_POOL': 'Swimming',
    'TENNIS': 'Tennis', 'HIGH_INTENSITY_INTERVAL_TRAINING': 'HIIT',
    'YOGA': 'Yoga', 'WALKING': 'Walking', 'ELLIPTICAL': 'Elliptical',
  };
  return map[String(type)] || String(type) || 'Workout';
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const corsOrigin = process.env.NETLIFY_URL;
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const params = event.queryStringParameters || {};
  const { action, date, session_start, session_end } = params;

  // Token management
  let accessToken = (event.headers.authorization || '').replace('Bearer ', '').trim();
  let newTokens = null;

  if (params.refresh && params.refresh_token) {
    try {
      const refreshed = await refreshToken(params.refresh_token);
      if (refreshed.access_token) {
        accessToken = refreshed.access_token;
        newTokens = { access_token: refreshed.access_token, expires_at: Date.now() + (refreshed.expires_in * 1000) };
      } else {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'refresh_failed' }) };
      }
    } catch(e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'refresh_error' }) };
    }
  }

  if (!accessToken) return { statusCode: 401, headers, body: JSON.stringify({ error: 'no_token' }) };

  const BASE = 'https://health.googleapis.com/v4/users/me';

  // ── DEBUG ─────────────────────────────────────────────────────────────────
  if (action === 'debug') {
    const d = date ? new Date(date + 'T00:00:00') : new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const filterStr = `exercise.interval.civil_start_time >= "${dateStr}T00:00:00" AND exercise.interval.civil_start_time <= "${dateStr}T23:59:59"`;

    const results = {};

    // 1. Exercise with correct filter (the fix)
    const exUrl = `${BASE}/dataTypes/exercise/dataPoints?filter=${encodeURIComponent(filterStr)}`;
    const exRes = await get(exUrl, accessToken);
    results['exercise_correct_filter'] = {
      status: exRes.status,
      count: exRes.body.dataPoints ? exRes.body.dataPoints.length : 0,
      error: exRes.body.error && exRes.body.error.message,
      sample: exRes.body.dataPoints && exRes.body.dataPoints[0]
    };

    // 2. Exercise without filter (get all, to confirm scope works)
    const exAllRes = await get(`${BASE}/dataTypes/exercise/dataPoints`, accessToken);
    results['exercise_no_filter'] = {
      status: exAllRes.status,
      count: exAllRes.body.dataPoints ? exAllRes.body.dataPoints.length : 0,
      error: exAllRes.body.error && exAllRes.body.error.message,
      types: exAllRes.body.dataPoints && exAllRes.body.dataPoints.slice(0,3).map(p => ({
        type: p.exercise && p.exercise.activityType,
        start: p.exercise && p.exercise.interval && p.exercise.interval.startTime
      }))
    };

    // 3. Heart rate with correct filter format
    const hrFilter = `heart_rate.interval.civil_start_time >= "${dateStr}T00:00:00"`;
    const hrRes = await get(`${BASE}/dataTypes/heart-rate/dataPoints?filter=${encodeURIComponent(hrFilter)}`, accessToken);
    results['heart_rate_correct_filter'] = {
      status: hrRes.status,
      count: hrRes.body.dataPoints ? hrRes.body.dataPoints.length : 0,
      error: hrRes.body.error && hrRes.body.error.message
    };

    return { statusCode: 200, headers, body: JSON.stringify({ debug: true, filter: filterStr, results, newTokens }) };
  }

  // ── SESSIONS ──────────────────────────────────────────────────────────────
  if (action === 'sessions') {
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing date' }) };

    // Build filter using civil_start_time (correct Health API filter format)
    const filterStr = `exercise.interval.civil_start_time >= "${date}T00:00:00" AND exercise.interval.civil_start_time <= "${date}T23:59:59"`;
    const url = `${BASE}/dataTypes/exercise/dataPoints?filter=${encodeURIComponent(filterStr)}`;
    const res = await get(url, accessToken);

    if (res.status === 401) return { statusCode: 401, headers, body: JSON.stringify({ error: 'token_expired' }) };

    if (res.status !== 200) {
      return { statusCode: res.status, headers, body: JSON.stringify({
        sessions: [],
        error: res.body.error && res.body.error.message,
        status: res.status,
        newTokens
      })};
    }

    const points = res.body.dataPoints || [];
    if (points.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ sessions: [], source: 'health', newTokens }) };
    }

    const sessions = points.map(p => {
      const ex = p.exercise || {};
      const interval = ex.interval || {};
      const startIso = interval.startTime;
      const endIso = interval.endTime;
      const hrSummary = ex.heartRateSummary || {};

      return {
        id: p.name || startIso,
        startTime: startIso,
        endTime: endIso,
        startLabel: fmtTime(startIso),
        endLabel: fmtTime(endIso),
        activityType: ex.activityType,
        activityName: getActivityName(ex.activityType),
        duration: formatDuration(startIso, endIso),
        // Include HR summary if available in the exercise point itself
        avgHR: hrSummary.averageHeartRate || null,
        maxHR: hrSummary.maxHeartRate || null,
        calories: ex.calories || null
      };
    }).filter(s => s.startTime); // remove any malformed points

    sessions.sort((a,b) => new Date(b.startTime) - new Date(a.startTime));
    return { statusCode: 200, headers, body: JSON.stringify({ sessions, source: 'health', newTokens }) };
  }

  // ── HR (called after session selected) ────────────────────────────────────
  if (action === 'hr') {
    if (!session_start || !session_end) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing window' }) };

    // Extract date portion for civil_start_time filter
    const startDate = session_start.substring(0, 10);
    const filterStr = `heart_rate.interval.civil_start_time >= "${startDate}T00:00:00"`;
    const hrRes = await get(`${BASE}/dataTypes/heart-rate/dataPoints?filter=${encodeURIComponent(filterStr)}`, accessToken);

    let avgHR = null, maxHR = null;

    if (hrRes.status === 200 && hrRes.body.dataPoints && hrRes.body.dataPoints.length > 0) {
      // Filter to session window
      const filtered = hrRes.body.dataPoints.filter(p => {
        const t = p.heartRate && p.heartRate.interval && p.heartRate.interval.startTime;
        return t && t >= session_start && t <= session_end;
      });
      if (filtered.length > 0) {
        const vals = filtered
          .map(p => p.heartRate && p.heartRate.beatsPerMinute)
          .filter(v => v && v > 30);
        avgHR = vals.length ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length) : null;
        maxHR = vals.length ? Math.round(Math.max(...vals)) : null;
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ avgHR, maxHR, calories: null, activeZoneMinutes: null, newTokens }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown_action' }) };
};
