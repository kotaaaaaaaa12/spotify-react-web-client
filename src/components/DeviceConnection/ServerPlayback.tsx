import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Space } from 'antd';
import { ConnectionBrand, ConnectionTheme } from './ConnectionTheme';
import { hasPairedPlaybackSession, SERVER_DIALOG_EVENT, ServerReport, ServerPlaybackRequestError, serverPlaybackState, serverRequest } from '../../utils/spotify/serverPlayback';
import { setServerAudio } from '../../utils/spotify/browserAudio';
import { playerService } from '../../services/player';
import { useAppDispatch } from '../../store/store';
import { spotifyActions } from '../../store/slices/spotify';

const descriptions: Record<string, string> = {
  cloud_drm_unavailable: 'Chrome on the server could not enable protected audio. Copy the server report.',
  cloud_drm_initialization_failed: 'Spotify could not initialize protected audio in server Chrome. Copy the server report.',
  cloud_browser_unavailable: 'The server could not launch Chrome. Wait for the Container image update, then retry.',
  cloud_browser_start_failed: 'Server Chrome did not finish starting. Copy the server report.',
  cloud_browser_exited: 'Server Chrome stopped. Retry the player.',
  cloud_browser_control_failed: 'The server lost its Chrome connection. Retry the player.',
  cloud_sdk_load_failed: 'Server Chrome could not load the Spotify player.',
  cloud_sdk_timeout: 'Spotify did not connect in server Chrome. Retry or copy the report.',
  cloud_sdk_connection_failed: 'The Spotify player could not connect from the server.',
  cloud_authentication_error: 'Spotify rejected the server login. Reconnect using Log in with QR.',
  cloud_premium_required: 'Spotify Premium is required for this player.',
  cloud_device_offline: 'Spotify disconnected the server player. Retry the player.',
  cloud_playback_error: 'Spotify could not play this track on the server.',
  cloud_autoplay_failed: 'Chrome could not activate audio on the server.',
  cloud_audio_server_unavailable: 'The server could not start its audio output.',
  cloud_audio_server_exited: 'The server audio output stopped.',
  cloud_audio_capture_unavailable: 'The server could not capture audio.',
  cloud_audio_capture_exited: 'The server audio capture stopped.',
  encoder_unavailable: 'The server could not start its audio encoder.',
  encoder_exited: 'The server audio encoder stopped.',
  encoder_input_closed: 'The audio encoder stopped receiving audio.',
};

export default function ServerPlayback({ enabled, fallbackReason, onModeChange }: { enabled: boolean; fallbackReason?: string; onModeChange: (enabled: boolean) => void }) {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false); const [report, setReport] = useState<ServerReport>();
  const [error, setError] = useState<string>(); const [deviceId, setDeviceId] = useState<string>();
  const [streamUrl, setStreamUrl] = useState<string>(); const [copied, setCopied] = useState(false);
  const audio = useRef<HTMLAudioElement>(null); const operation = useRef(false);
  const alive = useRef(true); const polling = useRef(false); const epoch = useRef(0);
  const paired = hasPairedPlaybackSession();
  const clearDevice = useCallback(() => {
    setStreamUrl(undefined); setDeviceId(undefined); setServerAudio(null);
    playerService.setPlaybackDevice(null); playerService.setPlaybackDeviceName(null);
    dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
  }, [dispatch]);
  useEffect(() => {
    alive.current = true;
    const show = () => setOpen(true); window.addEventListener(SERVER_DIALOG_EVENT, show);
    return () => { alive.current = false; ++epoch.current; window.removeEventListener(SERVER_DIALOG_EVENT, show); setServerAudio(null); playerService.setCloudPlaybackState('off'); };
  }, []);
  useEffect(() => {
    setServerAudio(enabled && streamUrl ? audio.current : null);
    if (enabled && streamUrl && deviceId) playerService.setCloudPlaybackState('ready');
  }, [enabled, streamUrl, deviceId]);
  const acceptReport = useCallback((result: ServerReport) => {
    setReport(result);
    if (['failed', 'stopped', 'idle', 'setup_required'].includes(result.phase)) {
      playerService.setCloudPlaybackState('failed');
      setRunning(false); clearDevice();
      if (result.phase === 'failed' || result.backend === 'soloist' || result.phase === 'setup_required') {
        setError(result.backend === 'soloist' ? 'The previous Container image is still active. Wait for its update, then retry.' : descriptions[result.errorCode || ''] || 'Server playback failed. Copy the report.'); setOpen(true);
      }
      return;
    }
    setRunning(true);
    if (result.authentication === 'accepted' && result.deviceId) {
      setDeviceId(result.deviceId); playerService.setPlaybackDevice(result.deviceId);
      playerService.setPlaybackDeviceName(result.deviceName || null);
      dispatch(spotifyActions.setDeviceId({ deviceId: result.deviceId })); dispatch(spotifyActions.setActiveDevice({ activeDevice: result.deviceId }));
      setStreamUrl(current => current || `/api/server/stream?t=${Date.now()}`);
    }
  }, [clearDevice, dispatch]);
  useEffect(() => {
    if (!enabled || !running) return; let cancelled = false;
    const check = async () => {
      if (polling.current) return; polling.current = true; const currentEpoch = epoch.current;
      try {
        const result = await serverRequest('status'); if (cancelled || currentEpoch !== epoch.current) return;
        acceptReport(result);
        if (result.authentication === 'accepted' && result.deviceId) {
          const state = await playerService.fetchPlaybackState().catch(() => undefined); if (cancelled || currentEpoch !== epoch.current) return;
          if (state !== undefined) dispatch(spotifyActions.setState({ state: serverPlaybackState(state, result.deviceId) }));
        }
      } catch (e) {
        if (!cancelled && currentEpoch === epoch.current) {
          if (e instanceof ServerPlaybackRequestError) setReport(e.report);
          setError(e instanceof Error ? e.message : 'Unable to check the server player.');
          playerService.setCloudPlaybackState('failed');
          setRunning(false); clearDevice(); setOpen(true);
        }
      } finally { polling.current = false; }
    };
    void check(); const timer = setInterval(() => void check(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled, running, dispatch, acceptReport, clearDevice]);
  const start = useCallback(async () => {
    if (operation.current) return; operation.current = true; ++epoch.current;
    playerService.setCloudPlaybackState('starting');
    setBusy(true); setError(undefined); setCopied(false); clearDevice();
    try {
      const result = await serverRequest('start'); if (!alive.current) return; acceptReport(result);
    } catch (e) { if (alive.current) {
      if (e instanceof ServerPlaybackRequestError) setReport(e.report);
      setError(e instanceof Error ? e.message : 'Unable to start the server player.'); setRunning(false); setOpen(true);
      playerService.setCloudPlaybackState('failed');
    } } finally { operation.current = false; if (alive.current) setBusy(false); }
  }, [acceptReport, clearDevice]);
  useEffect(() => {
    if (!enabled || !paired) return;
    // Defer until the local SDK has disconnected, including Strict Mode cleanup.
    const timer = setTimeout(() => void start(), 0); return () => clearTimeout(timer);
  }, [enabled, paired, start]);
  const stop = async (disable = false) => {
    if (operation.current) return; operation.current = true; ++epoch.current; setBusy(true); setError(undefined);
    try {
      if (enabled && paired) await serverRequest('stop');
      setRunning(false); clearDevice(); playerService.setCloudPlaybackState(disable ? 'off' : 'failed');
      setReport({ version: 5, phase: 'stopped' }); if (disable) onModeChange(false);
    } catch (e) { if (e instanceof ServerPlaybackRequestError) setReport(e.report); setError(e instanceof Error ? e.message : 'Unable to stop the server player.'); }
    finally { operation.current = false; setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied(true); }
    catch { setError('Select and copy the report below.'); }
  };
  return <ConnectionTheme>
    <audio ref={audio} src={streamUrl} preload="none" style={{ display: 'none' }}
      onError={() => { if (streamUrl) { setError('The audio connection stopped. Retry the server player.'); setOpen(true); } }} />
    <Modal title="Server playback" open={open} onCancel={() => setOpen(false)} footer={null} className="connection-modal" zIndex={11000} focusTriggerAfterClose={false}>
      <div className="connection-content"><ConnectionBrand />
        <p className="connection-description">Choose a song and listen here. Playback runs on the server.</p>
        {fallbackReason ? <p className="connection-note">Server playback was selected because this device could not connect to Spotify.</p> : null}
        {!paired ? <p className="connection-error">Use Log in with QR to connect your account first.</p> : null}
        {!enabled ? <button className="connection-button connection-button-wide" disabled={!paired} onClick={() => onModeChange(true)}>Use server playback</button> : <>
          <p className="connection-status" role="status">{deviceId ? 'Ready. Close this dialog and choose a song.' : busy || running ? 'Starting the server player…' : 'Server player stopped'}</p>
          <Space wrap style={{ marginBottom: 16 }}>
            <button className="connection-button" disabled={busy || !paired} onClick={() => void start()}>{running ? 'Reconnect' : 'Start server player'}</button>
            <button className="connection-button connection-button-secondary" disabled={!streamUrl || busy} onClick={() => {
              setError(undefined); void audio.current?.play().catch(() => setError('Choose a song, then tap Enable audio again.'));
            }}>Enable audio</button>
            <button className="connection-button connection-button-secondary" disabled={busy || !running} onClick={() => void stop()}>Stop</button>
          </Space>
          <p className="connection-note">If Safari stays silent, tap Enable audio once.</p>
          <button className="connection-button connection-button-secondary" disabled={busy} onClick={() => void stop(true)}>Use browser playback</button>
        </>}
        {report ? <details style={{ marginTop: 18 }}><summary>Diagnostics</summary>
          <textarea aria-label="Server playback report" readOnly value={JSON.stringify(report, null, 2)} style={{ width: '100%', boxSizing: 'border-box', minHeight: 160, margin: '12px 0', padding: 12, background: '#000', color: '#b3b3b3', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} />
          <button className="connection-button connection-button-wide" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy server report'}</button>
        </details> : null}
        {error ? <p className="connection-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  </ConnectionTheme>;
}
