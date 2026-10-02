import { handlePairing, handleSpotifyApi } from './pairing.mjs';
import { handleServerPlayback } from './server-playback.mjs';
export { PairingSession } from './pairing.mjs';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { ...securityHeaders, 'Cache-Control': 'no-store' },
  });
}

function runtimeConfig(url, env) {
  const clientId = (env.SPOTIFY_CLIENT_ID || '').trim();
  if (!/^[a-fA-F0-9]{32}$/.test(clientId)) {
    return json({ error: 'Set SPOTIFY_CLIENT_ID to your Spotify application Client ID in wrangler.jsonc, then redeploy.' }, 503);
  }
  let redirect;
  try {
    redirect = new URL(env.SPOTIFY_REDIRECT_URI || `${url.origin}/`);
    const local = ['127.0.0.1', '[::1]'].includes(redirect.hostname);
    if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && local)) ||
        redirect.origin !== url.origin || redirect.pathname !== '/' ||
        redirect.search || redirect.hash || redirect.username || redirect.password) {
      throw new Error('Invalid redirect');
    }
  } catch {
    return json({ error: 'SPOTIFY_REDIRECT_URI must match this site origin and end in / without a query or fragment.' }, 503);
  }
  return json({ clientId, redirectUri: redirect.href });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/server/')) return handleServerPlayback(request, env);
    if (url.pathname.startsWith('/api/spotify/')) return handleSpotifyApi(request, env);
    if (url.pathname.startsWith('/api/pair/') || (url.pathname === '/' && (url.searchParams.get('state') || '').startsWith('pair_'))) {
      const response = runtimeConfig(url, env);
      if (!response.ok) return response;
      return handlePairing(request, env, await response.json());
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', {
        status: 405,
        headers: { ...securityHeaders, Allow: 'GET, HEAD' },
      });
    }
    if (url.pathname === '/healthz') {
      return json({ ok: true, service: 'spotify-web-client' });
    }
    if (url.pathname === '/api/config') {
      return runtimeConfig(url, env);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);

    const upstream = await env.ASSETS.fetch(request);
    const response = new Response(upstream.body, upstream);
    for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
    if (response.headers.get('Content-Type')?.includes('text/html')) {
      response.headers.set('Cache-Control', 'no-store');
    } else if (/^\/assets\/.+-[\w-]+\.(js|css)$/.test(url.pathname)) {
      response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return response;
  },
};
