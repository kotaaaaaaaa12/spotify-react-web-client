import { PAIR_MODE } from './pairing';

export const SERVER_MODE = 'spotify_server_playback';
export const SERVER_DIALOG_EVENT = 'spotify-open-server-player';
export interface ServerReport {
  version: number;
  phase: string;
  deviceName?: string;
  authentication?: string;
  audio?: string;
  pcmBytes?: number;
  audioBytes?: number;
  errorCode?: string | null;
  playerRevision?: string;
  authenticationMode?: 'device';
  pairing?: { url: string; code: string };
  startup?: { revision: string; stage: string; httpStatus?: number; upstreamStatus?: number };
  diagnostics?: { revision: string; nativeExit?: { code: number | null; signal: string | null };
    encoderExit?: { code: number | null; signal: string | null };
    events: { event: string; errorKind?: string; httpStatus?: number; osErrorCode?: string; reason?: string }[] };
}
export const isServerPlaybackEnabled = () => localStorage.getItem(SERVER_MODE) === '1';
export const hasPairedPlaybackSession = () => !!localStorage.getItem(PAIR_MODE);

export class ServerPlaybackRequestError extends Error {
  constructor(message: string, public report: ServerReport) { super(message); this.name = 'ServerPlaybackRequestError'; }
}

export async function serverRequest(action: 'start' | 'status' | 'stop'): Promise<ServerReport> {
  const response = await fetch(`/api/server/${action}`, {
    method: action === 'status' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: action === 'status' ? {} : { 'X-Spotify-Device': '1' },
  });
  let data;
  try { data = await response.json(); } catch {
    throw new ServerPlaybackRequestError('The server player returned an unexpected response. Redeploy the latest update.', {
      version: 3, phase: 'failed', errorCode: 'server_invalid_response', startup: { revision: 'browser-response-1', stage: 'browser_response', httpStatus: response.status },
    });
  }
  if (!response.ok) {
    const stages = ['session', 'account', 'container_binding', 'container_start', 'container_status', 'container_stream', 'container_stop', 'container_report'];
    const startup = data.startup;
    const report: ServerReport = { version: 3, phase: 'failed', errorCode: typeof data.errorCode === 'string' && /^server_[a-z_]{1,64}$/.test(data.errorCode) ? data.errorCode : 'server_http_error',
      startup: startup?.revision === 'server-startup-1' && stages.includes(startup.stage) ? {
        revision: 'server-startup-1', stage: startup.stage, httpStatus: response.status,
        ...(Number.isInteger(startup.upstreamStatus) && startup.upstreamStatus >= 100 && startup.upstreamStatus <= 599 ? { upstreamStatus: startup.upstreamStatus } : {}),
      } : { revision: 'browser-response-1', stage: 'browser_response', httpStatus: response.status },
    };
    throw new ServerPlaybackRequestError(typeof data.error === 'string' ? data.error : `Server playback request failed (HTTP ${response.status}).`, report);
  }
  return data;
}

// The existing controls consume SDK-shaped state. Adapt only playback on the
// selected Container device; another device must never appear as this player.
export function serverPlaybackState(data: any, deviceId: string): Spotify.PlaybackState | null {
  if (!data?.item || data.device?.id !== deviceId) return null;
  const item = data.item;
  if (!item.album?.images || !Array.isArray(item.artists)) return null;
  return {
    paused: !data.is_playing, position: data.progress_ms || 0, duration: item.duration_ms || 0,
    repeat_mode: data.repeat_state === 'track' ? 2 : data.repeat_state === 'context' ? 1 : 0,
    shuffle: !!data.shuffle_state, context: data.context || { uri: '', metadata: {} },
    disallows: {}, restrictions: {}, loading: false, timestamp: data.timestamp || Date.now(),
    playback_id: item.id || '', playback_quality: 'unknown', playback_features: { hifi_status: 'unknown' },
    track_window: { current_track: item, previous_tracks: [], next_tracks: [] },
  };
}
