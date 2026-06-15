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
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
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
    '80': 'Weights', '82': 'Weights', '135': 'Weights',
    '109': 'Row Machine', '108': 'Row Machine',
    '97': 'Running', '1': 'Biking', '63': 'Tennis',
    'WEIGHTS_TRAINING': 'Weights', 'WEIGHT_TRAINING': 'Weights',
    'STRENGTH_TRAINING': 'Strength Training',
    'ROWING_MACHINE': 'Row Machine', 'ROWING': 'Row Machine',
    'RUNNING': 'Running', 'TENNIS': 'Tennis',
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

  // ── DEBUG ────────────────────────────────────────────────────────────────────
  if (action === 'debug') {
    const d = date ? new Date(date + 'T00:00:00') : new Date();
    const startOfDay = new Date(d); startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(d); endOfDay.setHours(23,59,59,999);
    const startIso = startOfDay.toISOString();
    const endIso = endOfDay.toISOString();
    const startMs = startOfDay.getTime();
    const endMs = endOfDay.getTime();
    const startNs = startMs * 1000000;
    const endNs = endMs * 1000000;

    const results = {};
    const FIT = 'https://www.googleapis.com/fitness/v1/users/me';
    const HEALTH = 'https://health.googleapis.com/v4/users/-';

    // Google Fit sessions (primary target)
    const fitSess = await get(`${FIT}/sessions?startTime=${startIso}&endTime=${endIso}`, accessToken);
    results['fit_sessions'] = { status: fitSess.status, count: fitSess.body.session ? fitSess.body.session.length : 0, sessions: fitSess.body.session ? fitSess.body.session.map(s=>({name:s.name,type:s.activityType,start:new Date(parseInt(s.startTimeMillis)).toISOString()})) : [], error: fitSess.body.error };

    // Google Fit HR dataset
    const fitHr = await get(`${FIT}/dataSources/derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm/datasets/${startNs}-${endNs}`, accessToken);
    results['fit_hr'] = { status: fitHr.status, points: fitHr.body.point ? fitHr.body.point.length : 0, error: fitHr.body.error };

    // Health API with snake_case params
    const healthTypes = ['exercise-session','workout','activity','exercise'];
    for (const t of healthTypes) {
      const r = await get(`${HEALTH}/dataTypes/${t}/dataPoints?start_time=${startIso}&end_time=${endIso}`, accessToken);
      results[`health_${t}_snake`] = { status: r.status, points: (r.body.dataPoints||[]).length, error: r.body.error };
    }

    // Health API without time filter (get everything)
    const healthAll = await get(`${HEALTH}/dataTypes/exercise-session/dataPoints`, accessToken);
    results['health_exercise_session_nofilter'] = { status: healthAll.status, points: (healthAll.body.dataPoints||[]).length, error: healthAll.body.error };

    return { statusCode: 200, headers, body: JSON.stringify({ debug: true, results, newTokens }) };
  }

  // ── SESSIONS ─────────────────────────────────────────────────────────────────
  if (action === 'sessions') {
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing date' }) };

    const d = new Date(date + 'T00:00:00');
    const startOfDay = new Date(d); startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(d); endOfDay.setHours(23,59,59,999);

    // PRIMARY: Google Fit Sessions API
    const FIT = 'https://www.googleapis.com/fitness/v1/users/me';
    const fitRes = await get(`${FIT}/sessions?startTime=${startOfDay.toISOString()}&endTime=${endOfDay.toISOString()}`, accessToken);

    if (fitRes.status === 200 && fitRes.body.session && fitRes.body.session.length > 0) {
      const sessions = fitRes.body.session.map(s => {
        const start = new Date(parseInt(s.startTimeMillis));
        const end = new Date(parseInt(s.endTimeMillis));
        const fmtTime = t => t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        return {
          id: s.id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          startLabel: fmtTime(start),
          endLabel: fmtTime(end),
          activityType: s.activityType,
          activityName: getActivityName(s.activityType) || s.name || 'Workout',
          duration: formatDuration(parseInt(s.endTimeMillis) - parseInt(s.startTimeMillis))
        };
      });
      sessions.sort((a,b) => new Date(b.startTime) - new Date(a.startTime));
      return { statusCode: 200, headers, body: JSON.stringify({ sessions, source: 'fit', newTokens }) };
    }

    if (fitRes.status === 401) return { statusCode: 401, headers, body: JSON.stringify({ error: 'token_expired' }) };

    return { statusCode: 200, headers, body: JSON.stringify({
      sessions: [],
      fitStatus: fitRes.status,
      fitError: fitRes.body.error && fitRes.body.error.message,
      newTokens
    })};
  }

  // ── HR ───────────────────────────────────────────────────────────────────────
  if (action === 'hr') {
    if (!session_start || !session_end) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing window' }) };

    const startNs = new Date(session_start).getTime() * 1000000;
    const endNs = new Date(session_end).getTime() * 1000000;
    const FIT = 'https://www.googleapis.com/fitness/v1/users/me';

    // HR
    const hrRes = await get(`${FIT}/dataSources/derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm/datasets/${startNs}-${endNs}`, accessToken);
    let avgHR = null, maxHR = null;
    if (hrRes.status === 200 && hrRes.body.point && hrRes.body.point.length > 0) {
      const vals = hrRes.body.point.map(p => p.value && p.value[0] && p.value[0].fpVal).filter(v => v && v > 30);
      avgHR = vals.length ? Math.round(vals.reduce((a,b)=>a+b,0) / vals.length) : null;
      maxHR = vals.length ? Math.round(Math.max(...vals)) : null;
    }

    // Calories
    const calRes = await get(`${FIT}/dataSources/derived:com.google.calories.expended:com.google.android.gms:merge_calories_expended/datasets/${startNs}-${endNs}`, accessToken);
    let calories = null;
    if (calRes.status === 200 && calRes.body.point) {
      calories = Math.round(calRes.body.point.reduce((sum,p) => sum + ((p.value && p.value[0] && p.value[0].fpVal) || 0), 0)) || null;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ avgHR, maxHR, calories, activeZoneMinutes: null, newTokens }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown_action' }) };
};
