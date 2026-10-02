let player: Spotify.Player | null = null;
let serverAudio: HTMLAudioElement | null = null;

export function setBrowserPlayer(value: Spotify.Player | null) { player = value; }
export function setServerAudio(value: HTMLAudioElement | null) { serverAudio = value; }

export function activateBrowserAudio(): Promise<void> {
  // Calling play during the user's gesture grants audio activation. Do not wait
  // for media here: Spotify's play command must run before the first audio arrives.
  if (serverAudio) { void serverAudio.play().catch(() => {}); return Promise.resolve(); }
  return player ? player.activateElement() : Promise.resolve();
}
