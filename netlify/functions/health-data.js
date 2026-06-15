// netlify/functions/health-data.js

const https = require('https');
const querystring = require('querystring');

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

async function refreshToken(refreshTok) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify({
      refresh_token: refreshTok,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    });
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
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

function formatDuration(ms) {
  if (!ms) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}min` : `${m} min`;
}

function getActivityName(type) {
  const map = {
    'WEIGHTS_TRAINING': 'Weights', 'WEIGHT_TRAINING': 'Weights',
    'STRENGTH_TRAINING': 'Strength Training',
    'FUNCTIONAL_STRENGTH_TRAINING': 'Functional Training',
    'ROWING_MACHINE': 'Row Machine', 'ROWING': 'Row Machine',
    'RUNNING': 'Running', 'CYCLING': 'Cycling',
    'SWIMMING_POOL': 'Swimming', 'TENNIS': 'Tennis',
    'HIGH_INTENSITY_INTERVAL_TRAINING': 'HIIT', 'HIIT': 'HIIT',
    'YOGA': 'Yoga', 'WALKING': 'Walking', 'ELLIPTICAL': 'Elliptical',
    // Numeric Fit activity types
    '80': 'Weights', '82': 'Weights', '135': 'Weights',
    '109': 'Row Machine', '97': 'Running', '1': 'Biking',
    '108': 'Rowing', '63': 'Tennis',
  };
  return map[String(type)] || String(type) || 'Workout';
}

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

  // ── DEBUG: return raw API responses so we can find the right data type ──────
  if (action === 'debug') {
    const now = new Date();
    const d = date ? new Date(date + 'T00:00:00') : now;
    const startOfDay = new Date(d); startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(d); endOfDay.setHours(23,59,59,999);
    const startMs = startOfDay.getTime();
    const endMs = endOfDay.getTime();

    // Try ALL likely session-related endpoints
    const BASE_HEALTH = 'https://health.googleapis.com/v4/users/-';
    const BASE_FIT = 'https://www.googleapis.com/fitness/v1/users/me';

    const results = {};

    // 1. Google Health API - various data type names
    const healthTypes = ['exercise-session','workout','activity','exercise','activity-segment','workout-session'];
    for (const t of healthTypes) {
      const url = `${BASE_HEALTH}/dataTypes/${t}/dataPoints?startTime=${startOfDay.toISOString()}&endTime=${endOfDay.toISOString()}`;
      const r = await get(url, accessToken);
      results[`health_${t}`] = { status: r.status, points: (r.body.dataPoints||[]).length, raw: r.status !== 200 ? r.body : undefined };
    }

    // 2. Google Fit Sessions API (if accessible with current token)
    const fitSessionsUrl = `${BASE_FIT}/sessions?startTime=${startOfDay.toISOString()}&endTime=${endOfDay.toISOString()}`;
    const fitSessions = await get(fitSessionsUrl, accessToken);
    results['fit_sessions'] = { status: fitSessions.status, sessions: fitSessions.body.session ? fitSessions.body.session.length : 0, raw: fitSessions.body };

    // 3. List available data types in Health API
    const typesUrl = `${BASE_HEALTH}/dataTypes`;
    const typesRes = await get(typesUrl, accessToken);
    results['available_types'] = { status: typesRes.status, count: (typesRes.body.dataType||[]).length, types: (typesRes.body.dataType||[]).map(t=>t.name) };

    return { statusCode: 200, headers, body: JSON.stringify({ debug: true, results, newTokens }) };
  }

  // ── ACTION: sessions ─────────────────────────────────────────────────────────
  if (action === 'sessions') {
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing date' }) };

    const d = new Date(date + 'T00:00:00');
    const startOfDay = new Date(d); startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(d); endOfDay.setHours(23,59,59,999);

    // Try Google Fit sessions first (most reliable for Fitbit data)
    const FIT_BASE = 'https://www.googleapis.com/fitness/v1/users/me';
    const fitUrl = `${FIT_BASE}/sessions?startTime=${startOfDay.toISOString()}&endTime=${endOfDay.toISOString()}`;
    const fitRes = await get(fitUrl, accessToken);

    if (fitRes.status === 200 && fitRes.body.session && fitRes.body.session.length > 0) {
      const sessions = fitRes.body.session.map(s => {
        const start = new Date(parseInt(s.startTimeMillis));
        const end = new Date(parseInt(s.endTimeMillis));
        const fmtTime = t => t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const durationMs = parseInt(s.endTimeMillis) - parseInt(s.startTimeMillis);
        return {
          id: s.id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          startLabel: fmtTime(start),
          endLabel: fmtTime(end),
          activityType: s.activityType,
          activityName: getActivityName(s.activityType) || s.name || 'Workout',
          duration: formatDuration(durationMs)
        };
      });
      sessions.sort((a,b) => new Date(b.startTime) - new Date(a.startTime));
      return { statusCode: 200, headers, body: JSON.stringify({ sessions, source: 'fit', newTokens }) };
    }

    // Fallback: try Google Health API with correct data type
    const HEALTH_BASE = 'https://health.googleapis.com/v4/users/-';
    const healthUrl = `${HEALTH_BASE}/dataTypes/exercise-session/dataPoints?startTime=${startOfDay.toISOString()}&endTime=${endOfDay.toISOString()}`;
    const healthRes = await get(healthUrl, accessToken);

    if (healthRes.status === 401) return { statusCode: 401, headers, body: JSON.stringify({ error: 'token_expired' }) };

    const points = healthRes.body.dataPoints || [];
    if (points.length > 0) {
      const sessions = points.map(p => {
        const interval = p.observationTimeInterval || {};
        const exData = (p.value && p.value.exerciseSession) || {};
        const start = interval.startTime;
        const end = interval.endTime;
        const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
        return {
          id: p.id || start,
          startTime: start, endTime: end,
          startLabel: fmtTime(start), endLabel: fmtTime(end),
          activityName: getActivityName(exData.activityType) || 'Workout',
          duration: formatDuration(exData.durationMillis)
        };
      });
      sessions.sort((a,b) => new Date(b.startTime) - new Date(a.startTime));
      return { statusCode: 200, headers, body: JSON.stringify({ sessions, source: 'health', newTokens }) };
    }

    // Nothing found
    return { statusCode: 200, headers, body: JSON.stringify({ sessions: [], source: 'none', fitStatus: fitRes.status, healthStatus: healthRes.status, newTokens }) };
  }

  // ── ACTION: hr ───────────────────────────────────────────────────────────────
  if (action === 'hr') {
    if (!session_start || !session_end) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing window' }) };

    const FIT_BASE = 'https://www.googleapis.com/fitness/v1/users/me';
    const HEALTH_BASE = 'https://health.googleapis.com/v4/users/-';

    // Try Google Fit HR dataset first
    const startNs = new Date(session_start).getTime() * 1000000;
    const endNs = new Date(session_end).getTime() * 1000000;
    const fitHrUrl = `${FIT_BASE}/dataSources/derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm/datasets/${startNs}-${endNs}`;
    const fitHrRes = await get(fitHrUrl, accessToken);

    let avgHR = null, maxHR = null, calories = null, activeZoneMinutes = null;

    if (fitHrRes.status === 200 && fitHrRes.body.point && fitHrRes.body.point.length > 0) {
      const hrVals = fitHrRes.body.point.map(p => p.value && p.value[0] && p.value[0].fpVal).filter(v => v && v > 30);
      avgHR = hrVals.length ? Math.round(hrVals.reduce((a,b) => a+b, 0) / hrVals.length) : null;
      maxHR = hrVals.length ? Math.round(Math.max(...hrVals)) : null;
    } else {
      // Fallback to Google Health API for HR
      const healthHrUrl = `${HEALTH_BASE}/dataTypes/heart-rate/dataPoints?startTime=${session_start}&endTime=${session_end}`;
      const healthHrRes = await get(healthHrUrl, accessToken);
      const hrPoints = (healthHrRes.body.dataPoints || []).map(p => p.value && p.value.heartRate && p.value.heartRate.beatsPerMinute).filter(v => v && v > 30);
      avgHR = hrPoints.length ? Math.round(hrPoints.reduce((a,b) => a+b, 0) / hrPoints.length) : null;
      maxHR = hrPoints.length ? Math.round(Math.max(...hrPoints)) : null;
    }

    // Try calories from Fit
    const fitCalUrl = `${FIT_BASE}/dataSources/derived:com.google.calories.expended:com.google.android.gms:merge_calories_expended/datasets/${startNs}-${endNs}`;
    const fitCalRes = await get(fitCalUrl, accessToken);
    if (fitCalRes.status === 200 && fitCalRes.body.point) {
      calories = Math.round(fitCalRes.body.point.reduce((sum, p) => sum + ((p.value && p.value[0] && p.value[0].fpVal) || 0), 0));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ avgHR, maxHR, activeZoneMinutes, calories: calories || null, newTokens }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown_action' }) };
};
