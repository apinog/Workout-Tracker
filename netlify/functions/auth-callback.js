// netlify/functions/auth-callback.js
// Handles the Google OAuth callback securely server-side.
// The client secret never touches the browser.

const https = require('https');
const querystring = require('querystring');

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify(body);
    const req = https.request({
      hostname,
      path,
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
        catch(e) { reject(new Error('Bad JSON: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async function(event) {
  const base = process.env.NETLIFY_URL;
  const { code, error, state } = event.queryStringParameters || {};

  // OAuth error returned by Google
  if (error) {
    return redirect(`${base}?auth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect(`${base}?auth_error=missing_code`);
  }

  try {
    const tokens = await post('oauth2.googleapis.com', '/token', {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${base}/.netlify/functions/auth-callback`,
      grant_type:    'authorization_code'
    });

    if (tokens.error) {
      return redirect(`${base}?auth_error=${encodeURIComponent(tokens.error)}`);
    }

    // Pass tokens back via URL fragment — fragments are never sent to servers
    // so they won't appear in Netlify logs
    const payload = encodeURIComponent(JSON.stringify({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in * 1000)
    }));

    return redirect(`${base}#gh_tokens=${payload}`);

  } catch(err) {
    console.error('Token exchange error:', err.message);
    return redirect(`${base}?auth_error=token_exchange_failed`);
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}
