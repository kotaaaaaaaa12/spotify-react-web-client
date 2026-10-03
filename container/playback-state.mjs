// Shared by the private SDK page, Container, and Worker. Return only UI state;
// arbitrary SDK fields, URLs, and credentials must not cross the boundary.
export function safePlaybackState(value) {
  const text = (v, length = 256) => typeof v === 'string' ? v.slice(0, length).replace(/[\u0000-\u001f]/g, '') : '';
  const uri = v => /^spotify:[a-z]+:[a-zA-Z0-9:_-]{1,256}$/.test(v || '') ? v : '';
  const number = v => Number.isFinite(v) ? Math.max(0, Math.min(86400000, Math.round(v))) : 0;
  const source = value?.track_window?.current_track;
  if (!source || !text(source.name) || !uri(source.uri)) return null;
  const images = (Array.isArray(source.album?.images) ? source.album.images : []).slice(0, 4).flatMap(image => {
    try {
      const url = new URL(image.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
          !['scdn.co', 'spotifycdn.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return [];
      return [{ url: url.href, width: number(image.width), height: number(image.height) }];
    } catch { return []; }
  });
  const artists = (Array.isArray(source.artists) ? source.artists : []).slice(0, 10).map(artist => ({
    name: text(artist.name), uri: uri(artist.uri), ...(text(artist.id, 128) ? { id: text(artist.id, 128) } : {}),
  }));
  const duration = number(value.duration || source.duration_ms);
  const disallows = {};
  for (const key of ['pausing', 'resuming', 'seeking', 'skipping_next', 'skipping_prev', 'toggling_repeat_context', 'toggling_repeat_track', 'toggling_shuffle']) {
    if (typeof value.disallows?.[key] === 'boolean') disallows[key] = value.disallows[key];
  }
  return {
    paused: value.paused === true, position: Math.min(number(value.position), duration), duration,
    repeat_mode: [0, 1, 2].includes(value.repeat_mode) ? value.repeat_mode : 0, shuffle: value.shuffle === true,
    context: { uri: uri(value.context?.uri), metadata: {} }, disallows, restrictions: {}, loading: value.loading === true,
    timestamp: Number.isSafeInteger(value.timestamp) && value.timestamp >= 0 ? value.timestamp : 0,
    playback_id: '', playback_quality: 'unknown', playback_features: { hifi_status: 'unknown' },
    track_window: { current_track: {
      id: text(source.id, 128) || null, uri: uri(source.uri), name: text(source.name),
      type: source.type === 'episode' ? 'episode' : 'track', media_type: 'audio', duration_ms: duration,
      is_playable: source.is_playable !== false, artists,
      album: { name: text(source.album?.name), uri: uri(source.album?.uri), images },
    }, previous_tracks: [], next_tracks: [] },
  };
}
