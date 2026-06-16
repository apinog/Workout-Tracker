// netlify/functions/health-data.js — diagnostic only

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
  let accessToken = (event.headers.authorization || '').replace('Bearer ', '').trim();
  let newTokens = null;

  if (params.refresh && params.refresh_token) {
    try {
      const refreshed = await refreshToken(params.refresh_token);
      if (refreshed.access_token) {
        accessToken = refreshed.access_token;
        newTokens = { access_token: refreshed.access_token, expires_at: Date.now() + (refreshed.expires_in * 1000) };
      }
    } catch(e) {}
  }

  if (!accessToken) return { statusCode: 401, headers, body: JSON.stringify({ error: 'no_token' }) };

  // ── STEP 1: Check what scopes this token ACTUALLY has ─────────────────────
  if (params.action === 'debug') {
    const results = {};

    // 1. Token introspection — tells us EXACTLY what scopes Google granted
    const tokenInfo = await get(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`, '');
    results['token_scopes'] = {
      status: tokenInfo.status,
      scopes: tokenInfo.body.scope ? tokenInfo.body.scope.split(' ') : [],
      email: tokenInfo.body.email,
      error: tokenInfo.body.error
    };

    const grantedScopes = tokenInfo.body.scope || '';
    const hasHealthScope = grantedScopes.includes('googlehealth');
    const hasFitnessScope = grantedScopes.includes('fitness');

    results['scope_summary'] = {
      has_googlehealth_scopes: hasHealthScope,
      has_fitness_scopes: hasFitnessScope,
      conclusion: hasHealthScope
        ? 'Token HAS googlehealth scopes — API call issue'
        : 'Token MISSING googlehealth scopes — Google rejected them during auth'
    };

    // 2. Only try Health API if scopes are present
    if (hasHealthScope) {
      const date = params.date || new Date().toISOString().slice(0,10);
      const filterStr = `exercise.interval.civil_start_time >= "${date}T00:00:00"`;
      const exRes = await get(
        `https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints?filter=${encodeURIComponent(filterStr)}`,
        accessToken
      );
      results['exercise_with_correct_scope'] = {
        status: exRes.status,
        count: exRes.body.dataPoints ? exRes.body.dataPoints.length : 0,
        error: exRes.body.error && exRes.body.error.message,
        sample: exRes.body.dataPoints && exRes.body.dataPoints[0]
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ results, newTokens }) };
  }

  // Sessions and HR — same as before
  if (params.action === 'sessions') {
    const date = params.date;
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing date' }) };
    const filterStr = `exercise.interval.civil_start_time >= "${date}T00:00:00" AND exercise.interval.civil_start_time <= "${date}T23:59:59"`;
    const res = await get(`https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints?filter=${encodeURIComponent(filterStr)}`, accessToken);
    if (res.status === 401) return { statusCode: 401, headers, body: JSON.stringify({ error: 'token_expired' }) };
    const points = res.body.dataPoints || [];
    const sessions = points.map(p => {
      const ex = p.exercise || {};
      const interval = ex.interval || {};
      const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
      return {
        id: p.name || interval.startTime,
        startTime: interval.startTime, endTime: interval.endTime,
        startLabel: fmtTime(interval.startTime), endLabel: fmtTime(interval.endTime),
        activityName: ex.activityType || 'Workout',
        duration: interval.startTime && interval.endTime ? `${Math.round((new Date(interval.endTime) - new Date(interval.startTime))/60000)} min` : null,
        avgHR: (ex.heartRateSummary || {}).averageHeartRate || null,
        maxHR: (ex.heartRateSummary || {}).maxHeartRate || null,
      };
    }).filter(s => s.startTime);
    sessions.sort((a,b) => new Date(b.startTime) - new Date(a.startTime));
    return { statusCode: 200, headers, body: JSON.stringify({ sessions, newTokens }) };
  }

  if (params.action === 'hr') {
    return { statusCode: 200, headers, body: JSON.stringify({ avgHR: null, maxHR: null, calories: null, newTokens }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown_action' }) };
};
