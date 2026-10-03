import { getPairedSession } from './pairing.mjs';
import { safeDiagnostics } from '../container/diagnostics.mjs';
import { PLAYER_REVISION, safeDevicePairing } from '../container/device-auth.mjs';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => Response.json(data, { status, headers });
const player = (env, id) => env.SERVER_PLAYERS.get(env.SERVER_PLAYERS.idFromName(`spotify-player-v1:${id}`), { locationHint: 'apac' });
const startupFailure = (stage, errorCode, error, status = 503, upstreamStatus) => {
  const report = { version: 3, phase: 'failed', errorCode, error,
    startup: { revision: 'server-startup-1', stage, httpStatus: status, ...(upstreamStatus ? { upstreamStatus } : {}) } };
  // Fixed labels only: never log an exception message, token, cookie, or account ID.
  console.error(JSON.stringify({ component: 'spotify-server-startup', ...report }));
  return json(report, status);
};

export async function stopServerPlayer(env, id) {
  if (env.SERVER_PLAYERS) await player(env, id).stopPlayer();
}

export async function handleServerPlayback(request, env) {
  const url = new URL(request.url);
  const action = url.pathname.slice('/api/server/'.length);
  const methods = { start: 'POST', status: 'GET', stream: 'GET', stop: 'POST' };
  if (!methods[action]) return json({ error: 'Not found.' }, 404);
  if (request.method !== methods[action]) return json({ error: 'Method not allowed.' }, 405);
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    if (origin ? origin !== url.origin : request.headers.get('X-Spotify-Device') !== '1' || (site && site !== 'same-origin')) {
      return json({ error: 'Request origin could not be verified.' }, 403);
    }
  }
  let stage = 'session';
  try {
    const paired = await getPairedSession(request, env);
    if (!paired.ok) return paired.response;
    if (!env.SERVER_PLAYERS) return startupFailure('container_binding', 'server_binding_unavailable', 'Server playback is unavailable. Apply the Container update and redeploy.');
    if (action === 'stop') { stage = 'container_stop'; await stopServerPlayer(env, paired.id); return json({ version: 1, phase: 'stopped' }); }
    const name = `Spotify Cloud Player ${paired.id.slice(0, 8)}`;
    let expectedUsername;
    if (action === 'start') {
      stage = 'account';
      const accountResponse = await fetch('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${paired.data.access_token}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000),
      });
      // Workers rejects redirect: 'error'. Check a manual redirect before reading it.
      if (accountResponse.status >= 300 && accountResponse.status < 400) return startupFailure(stage, 'server_account_redirect', 'Spotify returned an unexpected redirect while verifying the account.', 502, accountResponse.status);
      if (!accountResponse.ok) return startupFailure(stage, 'server_account_rejected', 'Unable to verify the linked Spotify account. Retry the account connection.', 502, accountResponse.status);
      const account = await accountResponse.json();
      if (typeof account.id !== 'string' || !account.id || account.id.length > 128 || /[\r\n\0]/.test(account.id)) return startupFailure(stage, 'server_account_invalid', 'The linked Spotify account could not be verified.', 502);
      expectedUsername = account.id;
    }
    stage = `container_${action}`;
    const stub = player(env, paired.id);
    const response = await stub.fetch(new Request(`http://container/${action}`, {
      method: request.method,
      headers: action === 'start' ? { 'Content-Type': 'application/json' } : {},
      body: action === 'start' ? JSON.stringify({ expectedUsername, name }) : undefined,
      signal: request.signal,
    }));
    if (!response.ok) {
      // Platform errors and raw process logs must never reach the browser.
      return startupFailure(stage, response.status === 429 ? 'server_container_capacity' : 'server_container_response_failed', response.status === 429 ? 'Container capacity is temporarily limited. Try again shortly.' : 'The server player could not start or respond. Check deployment status and retry.', response.status === 429 ? 429 : 502, response.status);
    }
    if (action === 'stream') {
      return new Response(response.body, { headers: { ...headers, 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'none' } });
    }
    stage = 'container_report';
    const report = await response.json();
    // Return a fixed set of diagnostic fields, never a token or raw process log.
    return json({ phase: report.phase, deviceName: name, authentication: report.authentication, audio: report.audio,
      pcmBytes: report.pcmBytes, audioBytes: report.audioBytes, errorCode: report.errorCode,
      playerRevision: report.playerRevision === PLAYER_REVISION ? PLAYER_REVISION : undefined,
      authenticationMode: report.authenticationMode === 'device' ? 'device' : undefined,
      pairing: report.phase === 'waiting_for_pairing' && report.authentication !== 'accepted' ? safeDevicePairing(report.pairing) : undefined,
      diagnostics: safeDiagnostics(report.diagnostics), version: 3 });
  } catch {
    const failures = {
      session: ['server_session_unavailable', 'Unable to read the QR session. Retry the account connection.'],
      account: ['server_account_request_failed', 'Unable to request or read the linked Spotify account. Copy the server report.'],
      container_stop: ['server_stop_failed', 'Unable to stop the server player. Retry stopping it.'],
      container_report: ['server_container_report_invalid', 'The Container returned an unreadable report. Check its deployment version.'],
    };
    const [code, message] = failures[stage] || ['server_container_request_failed', 'Unable to contact the Container. Check Container deployment and capacity, then retry.'];
    return startupFailure(stage, code, message);
  }
}
