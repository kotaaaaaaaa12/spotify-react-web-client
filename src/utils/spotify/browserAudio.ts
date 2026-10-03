let player: Spotify.Player | null = null;
type ServerAudio = { play(): Promise<void>; pause(): void; begin?: () => void; complete?: (epoch: number, paused: boolean) => void };
let serverAudio: ServerAudio | null = null;
export const SERVER_CONTROL_EVENT = 'spotify-server-control';
export function serverControlEvent(phase: 'pending' | 'accepted' | 'failed', action: string, report?: unknown) {
  if (phase === 'pending' && action !== 'volume') serverAudio?.begin?.();
  if (phase === 'pending' && action === 'pause') serverAudio?.pause();
  if (phase === 'accepted' && action !== 'volume') serverAudio?.complete?.((report as any)?.audioEpoch || 0, action === 'pause');
  if (phase === 'failed' && action !== 'volume') serverAudio?.complete?.(0, false);
  window.dispatchEvent(new CustomEvent(SERVER_CONTROL_EVENT, { detail: { phase, action, report } }));
}

export function setBrowserPlayer(value: Spotify.Player | null) { player = value; }
export function setServerAudio(value: ServerAudio | null) { serverAudio = value; }

export function activateBrowserAudio(): Promise<void> {
  // Calling play during the user's gesture grants audio activation. Do not wait
  // for media here: Spotify's play command must run before the first audio arrives.
  if (serverAudio) { void serverAudio.play().catch(() => {}); return Promise.resolve(); }
  return player ? player.activateElement() : Promise.resolve();
}
