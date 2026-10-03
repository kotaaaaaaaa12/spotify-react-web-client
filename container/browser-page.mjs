import { safePlaybackState } from './playback-state.mjs';

// Served only on loopback inside the Container. No credentials are embedded in
// HTML, navigation URLs, console messages, or the diagnostic object.
export const browserPage = `<!doctype html><html><meta charset="utf-8"><title>Cloud player</title><script>
(() => {
  const report = window.__cloudPlayerReport = { drm: 'pending', sdk: 'pending', errorCode: null, deviceId: null, playback: null };
  const playbackState = ${safePlaybackState.toString()};
  const fail = code => { if (!report.errorCode) { report.errorCode = code; report.sdk = 'failed'; } };
  window.__activateCloudPlayer = () => window.__cloudPlayer?.activateElement();
  const timeout = setTimeout(() => fail('cloud_sdk_timeout'), 90000);
  async function boot() {
    try {
      if (!navigator.requestMediaKeySystemAccess) throw new Error();
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
        distinctiveIdentifier: 'optional', persistentState: 'optional', sessionTypes: ['temporary']
      }]);
      report.drm = 'accepted';
    } catch { report.drm = 'rejected'; clearTimeout(timeout); fail('cloud_drm_unavailable'); return; }
    const configResponse = await fetch('/browser-config', { cache: 'no-store' });
    if (!configResponse.ok) throw new Error();
    const config = await configResponse.json();
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (report.errorCode) return;
      report.sdk = 'connecting';
      const player = window.__cloudPlayer = new Spotify.Player({ name: config.name, volume: 1,
        getOAuthToken: callback => {
          fetch('/browser-token', { cache: 'no-store' }).then(async response => {
            if (!response.ok) throw new Error();
            const data = await response.json(); callback(data.access_token);
          }).catch(() => fail('cloud_authentication_error'));
        }
      });
      player.addListener('ready', ({ device_id }) => { if (report.errorCode) return; clearTimeout(timeout); report.sdk = 'ready'; report.deviceId = device_id; });
      player.addListener('player_state_changed', state => { report.playback = playbackState(state); });
      let readingState = false;
      setInterval(async () => {
        if (readingState || report.sdk !== 'ready' || report.errorCode) return;
        readingState = true;
        try { report.playback = playbackState(await player.getCurrentState()); }
        catch { /* Keep the last snapshot during a temporary SDK read failure. */ }
        finally { readingState = false; }
      }, 1000);
      player.addListener('not_ready', () => fail('cloud_device_offline'));
      player.addListener('initialization_error', () => fail('cloud_drm_initialization_failed'));
      player.addListener('authentication_error', () => fail('cloud_authentication_error'));
      player.addListener('account_error', () => fail('cloud_premium_required'));
      player.addListener('playback_error', () => fail('cloud_playback_error'));
      player.addListener('autoplay_failed', () => { void player.activateElement().catch(() => fail('cloud_autoplay_failed')); });
      void player.connect().then(ok => { if (!ok) fail('cloud_sdk_connection_failed'); }).catch(() => fail('cloud_sdk_connection_failed'));
    };
    const script = document.createElement('script'); script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => fail('cloud_sdk_load_failed'); document.head.appendChild(script);
  }
  void boot().catch(() => fail('cloud_page_initialization_failed'));
})();
</script></html>`;
