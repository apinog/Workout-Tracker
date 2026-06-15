// netlify/functions/health-data.js
// Fetches exercise sessions and HR stats from the Google Health API.
// All API calls go server-side so the access token stays out of browser network logs.

const https = require('https');
const querystring = require('querystring');

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function get(url, accessToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { Authorization: `Bearer ${accessToken}` }
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

async function refreshToken(refreshTok) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify({
      refresh_token: refreshTok,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type:    'refresh_token'
    });
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Activity type mapping ───────────────────────────────────────────────────

const ACTIVITY_NAMES = {
  WEIGHTS_TRAINING:            'Weights',
  STRENGTH_TRAINING:           'Strength Training',
  FUNCTIONAL_STRENGTH_TRAINING:'Functional Training',
  ROWING_MACHINE:              'Row Machine',
  RUNNING:                     'Running',
  CYCLING:                     'Cycling',
  SWIMMING_POOL:               'Swimming',
  SWIMMING_OPEN_WATER:         'Open Water Swim',
  TENNIS:                      'Tennis',
  HIGH_INTENSITY_INTERVAL_TRAINING: 'HIIT',
  YOGA:                        'Yoga',
  WALKING:                     'Walking',
  ELLIPTICAL:                  'Elliptical',
  STAIR_CLIMBING:              'Stair Climbing',
};

function activityLabel(type) {
  return ACTIVITY_NAMES[type] || type || 'Workout';
}

// ─── Format duration ─────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}min` : `${m} min`;
}

// ─── Main handler ────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  const corsOrigin = process.env.NETLIFY_URL;
  const headers = {
    'Access-Control-Allow-Origin':  corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const { action, date, session_start, session_end, refresh } = params;

  // ── Token management ──────────────────────────────────────────────────────
  let accessToken = (event.headers.authorization || '').replace('Bearer ', '').trim();
  let newTokens = null;

  // If the client says the token is expired, refresh it first
  if (refresh && params.refresh_token) {
    try {
      const refreshed = await refreshToken(params.refresh_token);
      if (refreshed.access_token) {
        accessToken = refreshed.access_token;
        newTokens = {
          access_token: refreshed.access_token,
          expires_at:   Date.now() + (refreshed.expires_in * 1000)
        };
      } else {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'refresh_failed' }) };
      }
    } catch(e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'refresh_error' }) };
    }
  }

  if (!accessToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'no_token' }) };
  }

  const BASE = 'https://health.googleapis.com/v4/users/-';

  // ── Action: list exercise sessions for a day ──────────────────────────────
  if (action === 'sessions') {
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing date' }) };

    // Build a full-day window in UTC (date is YYYY-MM-DD local)
    const d = new Date(date + 'T00:00:00');
    const startTime = d.toISOString();
    const endTime   = new Date(d.getTime() + 86400000).toISOString();

    const url = `${BASE}/dataTypes/exercise-session/dataPoints?startTime=${startTime}&endTime=${endTime}`;
    const res = await get(url, accessToken);

    if (res.status === 401) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'token_expired' }) };
    }
    if (res.status !== 200) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: 'api_error', detail: res.body }) };
    }

    const points = res.body.dataPoints || [];
    const sessions = points.map(p => {
      const interval = p.observationTimeInterval || {};
      const exData   = (p.value && p.value.exerciseSession) || {};
      const start    = interval.startTime;
      const end      = interval.endTime;

      // Format times for display
      const fmtTime = iso => {
        if (!iso) return '—';
        const t = new Date(iso);
        return t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      };

      return {
        id:           p.id || (start + '_' + end),
        startTime:    start,
        endTime:      end,
        startLabel:   fmtTime(start),
        endLabel:     fmtTime(end),
        activityType: exData.activityType,
        activityName: activityLabel(exData.activityType),
        duration:     formatDuration(exData.durationMillis),
      };
    });

    // Sort by start time descending (most recent first)
    sessions.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    return { statusCode: 200, headers, body: JSON.stringify({ sessions, newTokens }) };
  }

  // ── Action: get HR + stats for a specific session window ──────────────────
  if (action === 'hr') {
    if (!session_start || !session_end) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing session window' }) };
    }

    // Parallel API calls for HR, active zone minutes, and calories
    const [hrRes, azmRes, calRes] = await Promise.all([
      get(`${BASE}/dataTypes/heart-rate/dataPoints?startTime=${session_start}&endTime=${session_end}`, accessToken),
      get(`${BASE}/dataTypes/active-zone-minutes/dataPoints?startTime=${session_start}&endTime=${session_end}`, accessToken),
      get(`${BASE}/dataTypes/active-energy-burned/dataPoints?startTime=${session_start}&endTime=${session_end}`, accessToken)
    ]);

    if (hrRes.status === 401) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'token_expired' }) };
    }

    // Heart rate
    const hrPoints = (hrRes.body.dataPoints || [])
      .map(p => p.value && p.value.heartRate && p.value.heartRate.beatsPerMinute)
      .filter(v => v != null && v > 30);

    const avgHR = hrPoints.length
      ? Math.round(hrPoints.reduce((a, b) => a + b, 0) / hrPoints.length)
      : null;
    const maxHR = hrPoints.length ? Math.max(...hrPoints) : null;

    // Active zone minutes
    const azmPoints = azmRes.body.dataPoints || [];
    const activeZoneMinutes = Math.round(
      azmPoints.reduce((sum, p) => sum + ((p.value && p.value.activeZoneMinutes && p.value.activeZoneMinutes.activeZoneMinutes) || 0), 0)
    );

    // Calories
    const calPoints = calRes.body.dataPoints || [];
    const calories = Math.round(
      calPoints.reduce((sum, p) => sum + ((p.value && p.value.activeEnergyBurned && p.value.activeEnergyBurned.calories) || 0), 0)
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        avgHR,
        maxHR,
        activeZoneMinutes: activeZoneMinutes || null,
        calories: calories || null,
        newTokens
      })
    };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown_action' }) };
};
