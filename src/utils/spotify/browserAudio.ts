let player: Spotify.Player | null = null;

export function setBrowserPlayer(value: Spotify.Player | null) { player = value; }

export function activateBrowserAudio(): Promise<void> {
  return player ? player.activateElement() : Promise.resolve();
}
