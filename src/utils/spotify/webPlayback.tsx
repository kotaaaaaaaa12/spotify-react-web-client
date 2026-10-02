import { useEffect, FC, memo } from 'react';
import { useAppDispatch } from '../../store/store';
import { spotifyActions } from '../../store/slices/spotify';
import { playerService } from '../../services/player';
import { activateBrowserAudio, setBrowserPlayer } from './browserAudio';

export interface WebPlaybackProps {
  onPlayerError: (message: string) => void;
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
    let cancelled = false;
    let player: Spotify.Player | null = null;
    let interval: ReturnType<typeof setInterval> | undefined;
    const reportError = (message: string) => { if (!cancelled) props.onPlayerError(message); };
    const onInteraction = () => { void activateBrowserAudio().catch(() => {}); };
    const handleState = (state: Spotify.PlaybackState | null) => {
      if (cancelled || !state) return;
      dispatch(spotifyActions.setState({ state }));
      props.onPlayerDeviceSelected();
    };
    const initialize = async () => {
      props.onPlayerLoading();
      const deadline = Date.now() + 20000;
      while (!window.Spotify?.Player) {
        if (cancelled) return;
        if (Date.now() >= deadline) throw new Error('Spotify player could not load. Check browser content blockers and reload.');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (cancelled) return;
      playerService.setPlaybackDeviceName(props.playerName);
      player = new window.Spotify.Player({
        name: props.playerName, volume: props.playerInitialVolume, enableMediaSession: true,
        getOAuthToken: (callback) => {
          void props.onPlayerRequestAccessToken().then((token) => {
            if (token) callback(token);
            else reportError('Your Spotify session expired. Reconnect your account.');
          }).catch((error) => reportError(error.message));
        },
      });
      setBrowserPlayer(player);
      dispatch(spotifyActions.setPlayer({ player }));
      for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'] as const) {
        player.addListener(event, ({ message }) => reportError(`Spotify player (${event}): ${message}`));
      }
      player.addListener('autoplay_failed', () => reportError('Your browser blocked audio. Press Play again to enable playback.'));
      player.addListener('player_state_changed', handleState);
      player.addListener('ready', ({ device_id }) => {
        if (cancelled) return;
        dispatch(spotifyActions.setDeviceId({ deviceId: device_id }));
        dispatch(spotifyActions.setActiveDevice({ activeDevice: device_id }));
        playerService.setPlaybackDevice(device_id);
        props.onPlayerWaitingForDevice({ device_id });
      });
      player.addListener('not_ready', () => {
        playerService.setPlaybackDevice(null);
        reportError('The Spotify browser device went offline. Reload this page to reconnect.');
      });
      document.addEventListener('click', onInteraction, true);
      document.addEventListener('keydown', onInteraction, true);
      if (props.playerAutoConnect && !await player.connect()) {
        throw new Error('Unable to connect the Spotify player. Reconnect your account and try again.');
      }
      if (cancelled) { player.disconnect(); return; }
      interval = setInterval(() => {
        void player?.getCurrentState().then(handleState).catch(() => {});
      }, props.playerRefreshRateMs || 1000);
    };
    void initialize().catch((error) => reportError(error.message));
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      document.removeEventListener('click', onInteraction, true);
      document.removeEventListener('keydown', onInteraction, true);
      player?.disconnect();
      setBrowserPlayer(null);
      playerService.setPlaybackDevice(null);
    };
  }, []);
  return <>{props.children}</>;
});

export default WebPlayback;
