const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const reply = (data, status = 200) => Response.json(data, { status, headers: HEADERS });

export async function handleLyrics(request, context) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
  const url = new URL(request.url);
  const params = new URLSearchParams();
  for (const name of ['track_name', 'artist_name', 'album_name']) {
    const value = (url.searchParams.get(name) || '').trim();
    if ((!value && name !== 'album_name') || value.length > 300) return reply({ error: 'Invalid track details.' }, 400);
    if (value) params.set(name, value);
  }
  const duration = Number(url.searchParams.get('duration'));
  if (!Number.isFinite(duration) || duration < 1 || duration > 3600) return reply({ error: 'Invalid track duration.' }, 400);
  params.set('duration', String(Math.round(duration * 1000) / 1000));
  const cacheKey = new Request(`${url.origin}/api/lyrics?${params}`);
  const cache = typeof caches !== 'undefined' ? caches.default : undefined;
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
    // Only public track metadata is sent; Spotify credentials stay on this site.
    const response = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'SpotifyWebClient/2.0.8 (lyrics display)' },
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (response.status === 404) return reply({ error: 'No lyrics were found for this recording.' }, 404);
    if (!response.ok) return reply({ error: 'The lyrics service is unavailable. Try again.' }, 502);
    const data = await response.json();
    const cleanText = value => typeof value === 'string' && value.length <= 100000 ? value : null;
    const result = Response.json({ source: 'LRCLIB', instrumental: data.instrumental === true,
      plainLyrics: cleanText(data.plainLyrics), syncedLyrics: cleanText(data.syncedLyrics) },
      { headers: { ...HEADERS, 'Cache-Control': 'public, max-age=86400' } });
    if (cache) {
      const pending = cache.put(cacheKey, result.clone()).catch(() => {});
      if (context?.waitUntil) context.waitUntil(pending);
      else await pending;
    }
    return result;
  } catch {
    return reply({ error: 'Unable to load lyrics. Try again.' }, 502);
  }
}
