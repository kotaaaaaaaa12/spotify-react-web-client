const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const reply = (data, status = 200) => Response.json(data, { status, headers: HEADERS });
const cleanText = value => typeof value === 'string' && value.length <= 100000 && value.trim() ? value : null;
const normalize = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');
// Remove edition/guest credits only. Live, remix and acoustic versions remain distinct.
const simplifyTitle = value => value
  .replace(/\s*[([](?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/gi, '')
  .replace(/\s*(?:-\s*|[([])(?:\d{4}\s*)?remaster(?:ed)?(?:\s*\d{4})?[)\]]?\s*$/i, '').trim();
const titleKey = value => normalize(simplifyTitle(value));
const artistKey = value => normalize(value.split(/\s+(?:feat\.?|ft\.?|featuring)\s+|\s*[,;]\s*/i)[0]);

function lyricsRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  const plainLyrics = cleanText(value.plainLyrics), syncedLyrics = cleanText(value.syncedLyrics);
  if (!plainLyrics && !syncedLyrics && value.instrumental !== true) return null;
  return { source: 'LRCLIB', instrumental: value.instrumental === true, plainLyrics, syncedLyrics };
}

export function selectLyrics(records, details) {
  if (!Array.isArray(records)) throw new Error('invalid_response');
  return records.filter(record => typeof record?.trackName === 'string' && typeof record?.artistName === 'string'
    && titleKey(record.trackName) === titleKey(details.track_name)
    && artistKey(record.artistName) === artistKey(details.artist_name)
    && Number.isFinite(record.duration) && Math.abs(record.duration - details.duration) <= 2
    && lyricsRecord(record))
    .sort((a, b) => Number(!!cleanText(b.syncedLyrics)) - Number(!!cleanText(a.syncedLyrics))
      || Number(normalize(b.albumName || '') === normalize(details.album_name || '')) - Number(normalize(a.albumName || '') === normalize(details.album_name || ''))
      || Math.abs(a.duration - details.duration) - Math.abs(b.duration - details.duration))[0];
}

export async function handleLyrics(request, context) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
  const url = new URL(request.url), params = new URLSearchParams();
  for (const name of ['track_name', 'artist_name', 'album_name']) {
    const value = (url.searchParams.get(name) || '').trim();
    if ((!value && name !== 'album_name') || value.length > 300) return reply({ error: 'Invalid track details.', code: 'invalid_track' }, 400);
    if (value) params.set(name, value);
  }
  const duration = Number(url.searchParams.get('duration'));
  if (!Number.isFinite(duration) || duration < 1 || duration > 3600) return reply({ error: 'Invalid track duration.', code: 'invalid_track' }, 400);
  params.set('duration', String(Math.round(duration * 1000) / 1000));
  const details = { ...Object.fromEntries(params), duration };
  const cacheKey = new Request(`${url.origin}/api/lyrics?${params}&lookup_version=2`);
  const cache = typeof caches !== 'undefined' ? caches.default : undefined;
  try { const cached = await cache?.match(cacheKey); if (cached) return cached; } catch { /* best effort */ }
  const deadline = Date.now() + 30000;
  const finished = new AbortController();
  let unavailable = false, searchCompleted = false;
  async function lookup(path, query) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { unavailable = true; return undefined; }
    try {
      // Fixed provider URL; only public track metadata leaves this Worker.
      const response = await fetch(`https://lrclib.net/api/${path}?${query}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'SpotifyWebClient/2.0.8 (lyrics display)' },
        signal: AbortSignal.any([finished.signal, AbortSignal.timeout(Math.min(15000, remaining))]), redirect: 'error',
      });
      if (response.status === 404) return null;
      if (!response.ok || !response.headers.get('Content-Type')?.includes('json')) throw new Error('upstream_unavailable');
      const text = await response.text();
      if (text.length > 500000) throw new Error('invalid_response');
      const data = JSON.parse(text);
      if (path === 'search') {
        if (!Array.isArray(data)) throw new Error('invalid_response');
      } else if (!data || typeof data !== 'object' || Array.isArray(data)
        || !('plainLyrics' in data || 'syncedLyrics' in data || 'instrumental' in data)) throw new Error('invalid_response');
      return data;
    } catch { unavailable = true; return undefined; }
  }
  async function success(record) {
    finished.abort();
    const result = Response.json(record, { headers: { ...HEADERS, 'Cache-Control': 'public, max-age=86400' } });
    if (cache) {
      const pending = Promise.resolve().then(() => cache.put(cacheKey, result.clone())).catch(() => {});
      if (context?.waitUntil) context.waitUntil(pending); else await pending;
    }
    return result;
  }
  try {
    let exact;
    const exactResult = lookup('get', params).then(data => {
      exact = data;
      const record = data ? lyricsRecord(data) : null;
      if (record) return record;
      throw new Error('no_match');
    });
    // Start fallback after a short head start, instead of waiting for a stalled
    // exact request. A fast exact hit cancels this timer without a second call.
    const searchResult = new Promise(resolve => {
      const timer = setTimeout(() => resolve(lookup('search', new URLSearchParams({ track_name: details.track_name, artist_name: details.artist_name }))), 600);
      finished.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
    }).then(results => {
      if (Array.isArray(results)) {
        searchCompleted = true;
        const match = selectLyrics(results, details);
        if (match) return lyricsRecord(match);
      }
      throw new Error('no_match');
    });
    try { return await success(await Promise.any([exactResult, searchResult])); } catch { /* both attempts completed without lyrics */ }
    // Do not require the Spotify album edition to match the lyric database.
    const searches = [];
    const simplifiedTitle = simplifyTitle(details.track_name);
    if (simplifiedTitle !== details.track_name) searches.push(new URLSearchParams({ track_name: simplifiedTitle, artist_name: details.artist_name }));
    for (const query of searches) {
      const results = await lookup('search', query);
      if (Array.isArray(results)) {
        searchCompleted = true;
        const match = selectLyrics(results, details);
        if (match) return success(lyricsRecord(match));
      } else if (results !== undefined && results !== null) unavailable = true;
    }
    // Retry an interrupted exact lookup once if the search did not recover it.
    const discovered = exact === undefined ? await lookup('get', params) : exact;
    if (discovered) { const record = lyricsRecord(discovered); if (record) return success(record); }
    if (searchCompleted && discovered !== undefined) { finished.abort(); return reply({ code: 'not_found', error: 'No lyrics were found for this recording.' }, 404); }
    if (!unavailable) { finished.abort(); return reply({ code: 'not_found', error: 'No lyrics were found for this recording.' }, 404); }
  } catch { /* Invalid provider responses are failures, never "no lyrics". */ }
  finished.abort();
  return reply({ code: 'lyrics_unavailable', error: 'Could not connect to the lyrics service. Try again.' }, 503);
}
