import { getPairedSession } from './pairing.mjs';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => Response.json(data, { status, headers });
const player = (env, id) => env.SERVER_PLAYERS.get(env.SERVER_PLAYERS.idFromName(`spotify-player-v1:${id}`), { locationHint: 'apac' });
const validOrigin = (request, url) => request.headers.get('Origin') ? request.headers.get('Origin') === url.origin :
  request.headers.get('X-Spotify-Device') === '1' && (!request.headers.get('Sec-Fetch-Site') || request.headers.get('Sec-Fetch-Site') === 'same-origin');
export async function boundedText(request, limit = 16384) {
  const reader = request.body?.getReader(); if (!reader) return '';
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('Request is too large.'); } chunks.push(value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}
export function pairingForm(text) {
  const input = new URLSearchParams(text), allowed = ['action', 'userName', 'blob', 'clientKey', 'loginId', 'version', 'tokenType'];
  if ([...input.keys()].some(key => !allowed.includes(key) || input.getAll(key).length !== 1) || input.get('action') !== 'addUser') return null;
  if (['userName', 'blob', 'tokenType'].some(key => !input.get(key)) || !input.has('clientKey')) return null;
  if ((input.get('userName') || '').length > 512 || [...input.values()].some(value => /[\r\n\0]/.test(value))) return null;
  return input.toString();
}

export async function handleSoloist(request, env) {
  const url = new URL(request.url), action = url.pathname.slice('/api/soloist/'.length);
  if (!env.SERVER_PLAYERS) return json({ error: 'Apply the Container update and redeploy.' }, 503);
  if (action === 'bridge') {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
    const id = url.searchParams.get('id'), token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!/^[a-f0-9]{32}$/.test(id || '') || !token || [...url.searchParams.keys()].some(key => key !== 'id')) return json({ error: 'Invalid pairing link.' }, 401);
    let form;
    if (request.method === 'POST') {
      if ((request.headers.get('Content-Type') || '').split(';')[0] !== 'application/x-www-form-urlencoded') return json({ error: 'Unsupported pairing request.' }, 415);
      try { form = pairingForm(await boundedText(request)); } catch { return json({ error: 'Pairing request is too large.' }, 413); }
      if (!form) return json({ error: 'Invalid pairing request.' }, 400);
    }
    try {
      const response = await player(env, id).soloistBridge({ token, action: request.method === 'GET' ? 'getInfo' : 'addUser', form });
      return new Response(response.body, { status: response.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    } catch { return json({ error: 'Cloud pairing could not finish. Check the server report and create a new pairing link if needed.' }, 502); }
  }
  if (action !== 'settings' && action !== 'bridge/new') return json({ error: 'Not found.' }, 404);
  if (action === 'settings' ? !['GET', 'POST'].includes(request.method) : request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (request.method === 'POST' && !validOrigin(request, url)) return json({ error: 'Request origin could not be verified.' }, 403);
  try {
    const paired = await getPairedSession(request, env); if (!paired.ok) return paired.response;
    const stub = player(env, paired.id);
    if (action === 'bridge/new') {
      const bridge = await stub.createSoloistBridge();
      // The secret is a fragment, so it never enters an HTTP URL or access log.
      return json({ link: `${url.origin}/cloud-pair#id=${paired.id}&token=${bridge.token}`, expiresAt: bridge.expiresAt });
    }
    if (request.method === 'GET') return json(await stub.settings());
    let input; try { input = JSON.parse(await boundedText(request, 8192)); } catch { return json({ error: 'Invalid settings request.' }, 400); }
    if (typeof input.apiKey !== 'string' || !input.apiKey || input.apiKey.length > 4096 || /\s|\0/.test(input.apiKey)) return json({ error: 'Enter your Spotify Soloist API key.' }, 400);
    const response = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${paired.data.access_token}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok || response.status >= 300) return json({ error: 'Unable to verify the linked Spotify account.' }, 502);
    const account = await response.json();
    if (typeof account.id !== 'string' || !account.id || account.id.length > 128 || /[\r\n\0]/.test(account.id)) return json({ error: 'The linked Spotify account could not be verified.' }, 502);
    return json(await stub.configureSoloist({ apiKey: input.apiKey, expectedUsername: account.id, name: `Spotify Cloud Player ${paired.id.slice(0, 8)}`, expiresAt: paired.data.sessionExpiresAt }));
  } catch { return json({ error: action === 'bridge/new' ? 'Soloist is not ready for pairing. Wait for Waiting for Android pairing, then retry.' : 'Unable to save or read Soloist settings. Copy the server report or retry.' }, 503); }
}

export function cloudPairPage() {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloud pairing</title><style>body{background:#121212;color:#fff;font:16px system-ui;margin:0;padding:32px}main{max-width:520px;margin:40px auto}h1{font-size:28px}p{line-height:1.6;color:#bbb}button{background:#1ed760;color:#000;border:0;border-radius:24px;padding:12px 20px;font:inherit;font-weight:600}textarea{width:100%;box-sizing:border-box;background:#000;color:#ccc;border:1px solid #444;border-radius:12px;padding:12px}</style><main><h1>Spotify Cloud Player</h1><p>This private link connects the Android pairing bridge. Soloist and audio playback run in Cloudflare.</p><p>Return to Termux and paste the link when the bridge asks for it. Do not share this link.</p><button id="copy">Copy pairing link</button><p id="status" role="status"></p><textarea id="link" aria-label="Private pairing link" readonly rows="4"></textarea></main><script>const link=location.href;document.getElementById('link').value=link;history.replaceState(null,'','/cloud-pair');document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(link);document.getElementById('status').textContent='Copied. Paste it into Termux.'}catch{document.getElementById('status').textContent='Select and copy the link below.'}};</script></html>`, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Frame-Options': 'DENY' } });
}
