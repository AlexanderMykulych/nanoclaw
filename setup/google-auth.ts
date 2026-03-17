/**
 * Google Calendar OAuth2 Authorization
 * Run once to obtain a refresh token, then store it in .env
 *
 * Usage: npx tsx setup/google-auth.ts
 */

import fs from 'fs';
import http from 'http';
import { URL } from 'url';

const CREDENTIALS_PATH = 'store/google/credentials.json';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_PORT = 3333;
// Desktop app uses http://localhost as redirect_uri (Google ignores port in matching)
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

async function main() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`Credentials not found at ${CREDENTIALS_PATH}`);
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', client_id);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for authorization...\n');

  const code = await waitForAuthCode();

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json() as { refresh_token?: string; access_token?: string; error?: string };

  if (tokens.error) {
    console.error('Token exchange failed:', tokens);
    process.exit(1);
  }

  if (!tokens.refresh_token) {
    console.error('No refresh_token received. Try revoking access and re-running.');
    process.exit(1);
  }

  console.log('\nAdd these to your .env file:\n');
  console.log(`GOOGLE_CLIENT_ID=${client_id}`);
  console.log(`GOOGLE_CLIENT_SECRET=${client_secret}`);
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\nDone!');
}

function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization denied</h1>');
        server.close();
        reject(new Error(`Authorization denied: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p>');
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>No code received</h1>');
    });

    server.listen(REDIRECT_PORT, () => {
      // Server ready
    });

    server.on('error', reject);
  });
}

main().catch(console.error);
