import { useEffect, useRef, useState } from 'react';
import { Modal, Space } from 'antd';
import { ConnectionBrand, ConnectionTheme } from './ConnectionTheme';
import { hasPairedPlaybackSession, SERVER_DIALOG_EVENT, ServerReport, serverPlaybackState, serverRequest } from '../../utils/spotify/serverPlayback';
import { setServerAudio } from '../../utils/spotify/browserAudio';
import { playerService } from '../../services/player';
import { useAppDispatch } from '../../store/store';
import { spotifyActions } from '../../store/slices/spotify';

const descriptions: Record<string, string> = {
  spotify_authentication_rejected: 'Spotify rejected the server login. Stop the player, create a new QR session, and retry.',
  spotify_audio_key_rejected: 'Spotify accepted the login but rejected audio access for this server player.',
  spotify_track_unavailable: 'The server could not load this track.',
  native_process_unavailable: 'The Container does not have a working librespot executable.',
  encoder_unavailable: 'The Container does not have a working audio encoder.',
  encoder_input_closed: 'The audio encoder stopped receiving input.',
  native_player_exited: 'The Spotify server player exited before completing playback.',
  encoder_exited: 'The audio encoder exited.',
};

export default function ServerPlayback({ enabled, onModeChange }: { enabled: boolean; onModeChange: (enabled: boolean) => void }) {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(enabled); const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false); const [report, setReport] = useState<ServerReport>();
  const [error, setError] = useState<string>(); const [deviceId, setDeviceId] = useState<string>();
  const [streamUrl, setStreamUrl] = useState<string>(); const [copied, setCopied] = useState(false);
  const audio = useRef<HTMLAudioElement>(null); const operation = useRef(false);
  const alive = useRef(true); const polling = useRef(false);
  const paired = hasPairedPlaybackSession();
  useEffect(() => {
    alive.current = true;
    const show = () => setOpen(true); window.addEventListener(SERVER_DIALOG_EVENT, show);
    return () => { alive.current = false; window.removeEventListener(SERVER_DIALOG_EVENT, show); setServerAudio(null); };
  }, []);
  useEffect(() => { setServerAudio(enabled && streamUrl ? audio.current : null); }, [enabled, streamUrl]);

  useEffect(() => {
    if (!enabled || !running) return;
    let cancelled = false;
    const check = async () => {
      if (polling.current) return; polling.current = true;
      try {
        const result = await serverRequest('status'); if (cancelled) return;
        setReport(result);
        if (result.phase === 'failed' || result.phase === 'stopped' || result.phase === 'idle') {
          setRunning(false); setStreamUrl(undefined); setServerAudio(null);
          playerService.setPlaybackDevice(null); setDeviceId(undefined);
          dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
          if (result.errorCode) { setError(descriptions[result.errorCode] || 'Server playback failed. Copy the report for diagnosis.'); setOpen(true); }
          return;
        }
        if (result.authentication === 'accepted') {
          const devices = await playerService.getAvailableDevices(); if (cancelled) return;
          const device = devices.devices.find(item => item.name === result.deviceName);
          if (device?.id) {
            setDeviceId(device.id); playerService.setPlaybackDevice(device.id);
            dispatch(spotifyActions.setDeviceId({ deviceId: device.id }));
            dispatch(spotifyActions.setActiveDevice({ activeDevice: device.id }));
            const state = await playerService.fetchPlaybackState(); if (cancelled) return;
            dispatch(spotifyActions.setState({ state: serverPlaybackState(state, device.id) }));
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unable to check the server player.'); setRunning(false); setStreamUrl(undefined); setServerAudio(null); setOpen(true);
          setDeviceId(undefined); playerService.setPlaybackDevice(null);
          dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
        }
      } finally { polling.current = false; }
    };
    void check(); const timer = setInterval(() => void check(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled, running, dispatch]);

  const start = async () => {
    if (operation.current) return; operation.current = true; setBusy(true); setError(undefined); setCopied(false);
    try {
      const result = await serverRequest('start'); if (!alive.current) return;
      playerService.setPlaybackDevice(null); playerService.setPlaybackDeviceName(result.deviceName || null);
      setDeviceId(undefined); setReport(result); setRunning(true);
      setStreamUrl(`/api/server/stream?t=${Date.now()}`);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Unable to start the server player.'); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  };
  const stop = async (disable = false) => {
    if (operation.current) return; operation.current = true; setBusy(true); setError(undefined);
    try {
      if (enabled && paired) await serverRequest('stop');
      setRunning(false); setStreamUrl(undefined); setDeviceId(undefined); setServerAudio(null);
      playerService.setPlaybackDevice(null); playerService.setPlaybackDeviceName(null);
      dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
      setReport({ version: 1, phase: 'stopped' });
      if (disable) onModeChange(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to stop the server player.'); }
    finally { operation.current = false; setBusy(false); }
  };
  const enableAudio = () => {
    setError(undefined);
    void audio.current?.play().catch(() => setError('Audio did not start. Choose a track, then press Enable audio again.'));
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied(true); }
    catch { setError('Clipboard access is unavailable. Select and copy the report below.'); }
  };
  return <ConnectionTheme>
    {/* Keep the audio element mounted when the settings dialog is closed. */}
    <audio ref={audio} src={streamUrl} preload="none" style={{ display: 'none' }} />
    <Modal title="Server playback" open={open} onCancel={() => setOpen(false)} footer={null} className="connection-modal"
      zIndex={11000} focusTriggerAfterClose={false}>
      <div className="connection-content"><ConnectionBrand />
        <p className="connection-description">Play through this site’s server. Your device receives audio from this site.</p>
        {!paired ? <p className="connection-error">Server playback needs a QR session. Sign out and choose Log in with QR.</p> : null}
        {!enabled ? <button className="connection-button connection-button-wide" disabled={!paired} onClick={() => { setError(undefined); onModeChange(true); }}>Use server playback</button> : <>
          <p className="connection-status" role="status">{report?.phase === 'streaming' ? 'Server is sending audio' : deviceId ? 'Ready. Choose a track and enable audio.' : running ? 'Connecting the server player...' : 'Server playback selected'}</p>
          <Space wrap style={{ marginBottom: 16 }}>
            <button className="connection-button" aria-busy={busy} disabled={busy || !paired || running} onClick={() => void start()}>Start server player</button>
            <button className="connection-button connection-button-secondary" disabled={!streamUrl || busy} onClick={enableAudio}>Enable audio</button>
            <button className="connection-button connection-button-secondary" disabled={busy || !report} onClick={() => void stop()}>Stop server player</button>
          </Space>
          <p className="connection-note">Start the player, wait until it is ready, enable audio, then close this dialog and choose a song. Playback is experimental.</p>
          <button className="connection-button connection-button-secondary" disabled={busy} onClick={() => void stop(true)}>Use browser playback</button>
        </>}
        {report ? <>
          <textarea aria-label="Server playback report" readOnly value={JSON.stringify(report, null, 2)} style={{ width: '100%', minHeight: 160, margin: '18px 0', padding: 12, background: '#000', color: '#b3b3b3', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} />
          <button className="connection-button connection-button-wide" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy server report'}</button>
        </> : null}
        {error ? <p className="connection-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  </ConnectionTheme>;
}
