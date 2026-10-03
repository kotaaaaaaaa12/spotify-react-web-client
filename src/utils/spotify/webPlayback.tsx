import { useEffect, FC, memo } from 'react';
import { useAppDispatch } from '../../store/store';
import { spotifyActions } from '../../store/slices/spotify';
import { playerService } from '../../services/player';
import { activateBrowserAudio, setBrowserPlayer } from './browserAudio';
import { BrowserPlayerFailure, BROWSER_PLAYER_TIMEOUT_MS, watchBrowserPlayerConnection } from './browserPlayerConnection';

export interface WebPlaybackProps {
  onPlayerError: (message: string, reason?: BrowserPlayerFailure) => void;
  enabled?: boolean;
  connectionAttempt?: number;
  onPlayerRequestAccessToken: () => Promise<string>;
  onPlayerLoading: () => void;
  onPlayerWaitingForDevice: (data: { device_id: string }) => void;
  onPlayerDeviceSelected: () => void;
  playerName: string;
  playerInitialVolume: number;
  playerRefreshRateMs?: number;
  playerAutoConnect?: boolean;
  children?: React.ReactNode;
}

const WebPlayback: FC<WebPlaybackProps> = memo((props) => {
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (props.enabled === false) return;
    let cancelled = false;
    let failed = false;
    let player: Spotify.Player | null = null;
    let interval: ReturnType<typeof setInterval> | undefined;
    let stopWatching: (() => void) | undefined;
    const reportError = (message: string, reason: BrowserPlayerFailure) => {
      if (cancelled || failed) return;
      stopWatching?.();
      if (reason !== 'playback_error' && reason !== 'autoplay_failed') failed = true;
      props.onPlayerError(message, reason);
    };
    const onInteraction = () => { void activateBrowserAudio().catch(() => {}); };
    const handleState = (state: Spotify.PlaybackState | null) => {
      if (cancelled || failed || !state) return;
      dispatch(spotifyActions.setState({ state }));
      props.onPlayerDeviceSelected();
    };
    const initialize = async () => {
      props.onPlayerLoading();
      // Cloud playback and QR pages must not load Spotify SDK on the receiving
      // device. Load it only when local browser playback is explicitly active.
      if (!window.Spotify?.Player && !document.querySelector('script[data-spotify-sdk]')) {
        window.onSpotifyWebPlaybackSDKReady = () => {};
        const script = document.createElement('script'); script.dataset.spotifySdk = '1';
        script.src = 'https://sdk.scdn.co/spotify-player.js'; script.async = true;
        script.onerror = () => { script.remove(); reportError('Spotify player could not load. Check browser content blockers and reload.', 'sdk_load_failed'); };
        document.head.appendChild(script);
      }
      const deadline = Date.now() + BROWSER_PLAYER_TIMEOUT_MS;
      while (!window.Spotify?.Player) {
        if (cancelled) return;
        if (Date.now() >= deadline) {
          reportError('Spotify player could not load. Check browser content blockers and reload.', 'sdk_load_failed');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (cancelled) return;
      playerService.setPlaybackDeviceName(props.playerName);
      player = new window.Spotify.Player({
        name: props.playerName, volume: props.playerInitialVolume, enableMediaSession: true,
        getOAuthToken: (callback) => {
          void props.onPlayerRequestAccessToken().then((token) => {
            if (cancelled || failed) return;
            if (token) callback(token);
            else reportError('Your Spotify session expired. Reconnect your account.', 'authentication_error');
          }).catch((error) => reportError(error.message, 'authentication_error'));
        },
      });
      setBrowserPlayer(player);
      dispatch(spotifyActions.setPlayer({ player }));
      for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'] as const) {
        player.addListener(event, ({ message }) => reportError(`Spotify player (${event}): ${message}`, event));
      }
      player.addListener('autoplay_failed', () => reportError('Your browser blocked audio. Press Play again to enable playback.', 'autoplay_failed'));
      player.addListener('player_state_changed', handleState);
      player.addListener('ready', ({ device_id }) => {
        if (cancelled || failed) return;
        stopWatching?.();
        dispatch(spotifyActions.setDeviceId({ deviceId: device_id }));
        dispatch(spotifyActions.setActiveDevice({ activeDevice: device_id }));
        playerService.setPlaybackDevice(device_id);
        props.onPlayerWaitingForDevice({ device_id });
      });
      player.addListener('not_ready', () => {
        if (cancelled || failed) return;
        playerService.setPlaybackDevice(null);
        reportError('The Spotify browser device went offline. Reload this page to reconnect.', 'not_ready');
      });
      document.addEventListener('click', onInteraction, true);
      document.addEventListener('keydown', onInteraction, true);
      if (props.playerAutoConnect) {
        stopWatching = watchBrowserPlayerConnection(() => reportError('The Spotify browser player did not become ready within 20 seconds.', 'connection_timeout'));
        try {
          if (!await player.connect()) reportError('Unable to connect the Spotify player. Reconnect your account and try again.', 'connection_failed');
        } catch (error) {
          reportError(error instanceof Error ? error.message : 'Unable to connect the Spotify player.', 'connection_failed');
        }
      }
      if (cancelled) { player.disconnect(); return; }
      if (failed) return;
      interval = setInterval(() => {
        void player?.getCurrentState().then(handleState).catch(() => {});
      }, props.playerRefreshRateMs || 1000);
    };
    void initialize().catch((error) => reportError(error.message, 'initialization_error'));
    return () => {
      cancelled = true;
      stopWatching?.();
      if (interval) clearInterval(interval);
      document.removeEventListener('click', onInteraction, true);
      document.removeEventListener('keydown', onInteraction, true);
      player?.disconnect();
      setBrowserPlayer(null);
      dispatch(spotifyActions.setPlayer({ player: null }));
      playerService.setPlaybackDevice(null);
    };
  }, [props.enabled, props.connectionAttempt]);
  return <>{props.children}</>;
});

export default WebPlayback;
