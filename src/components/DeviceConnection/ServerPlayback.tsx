import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, QRCode, Space } from 'antd';
import { ConnectionBrand, ConnectionTheme } from './ConnectionTheme';
import { hasPairedPlaybackSession, SERVER_DIALOG_EVENT, ServerReport, ServerPlaybackRequestError, serverPlaybackState, serverRequest,
  soloistSettings, newSoloistBridge, SoloistSettings, SoloistBridge } from '../../utils/spotify/serverPlayback';
import { setServerAudio } from '../../utils/spotify/browserAudio';
import { playerService } from '../../services/player';
import { useAppDispatch } from '../../store/store';
import { spotifyActions } from '../../store/slices/spotify';

const descriptions: Record<string, string> = {
  soloist_process_unavailable: 'The Container could not start Spotify Soloist. Check its deployment.',
  soloist_player_exited: 'Spotify Soloist exited. Check your Soloist API key, then copy the server report.',
  soloist_build_expired: 'This Soloist build expired and could not update. Redeploy to download the current build.',
  soloist_connect_discovery_failed: 'The Container could not discover Soloist’s Connect interface. Android pairing cannot start. Copy the server report.',
  soloist_control_unavailable: 'Soloist’s local control interface could not connect. Copy the server report.',
  soloist_audio_server_unavailable: 'The Container could not start its private audio output.',
  soloist_audio_server_exited: 'The Container’s audio output stopped.',
  soloist_audio_capture_unavailable: 'The Container could not capture the Soloist audio output.',
  soloist_audio_capture_exited: 'The Container’s audio capture stopped.',
  soloist_session_lost: 'Soloist lost its saved Spotify session. Restart the player and create a new Android pairing link.',
  spotify_authentication_rejected: 'Spotify rejected the server login. Stop the player, create a new QR session, and retry.',
  spotify_audio_key_rejected: 'Spotify accepted the login but rejected audio access for this server player.',
  spotify_track_unavailable: 'The server could not load this track.',
  native_process_unavailable: 'The Container does not have a working librespot executable.',
  encoder_unavailable: 'The Container does not have a working audio encoder.',
  encoder_input_closed: 'The audio encoder stopped receiving input.',
  native_player_exited: 'The Spotify server player exited before completing playback.',
  native_connect_initialization_failed: 'Spotify Connect initialization failed after native login. Copy the server report for the error details.',
  spotify_client_token_failed: 'Spotify Connect initialization failed while requesting a client token. Copy the server report.',
  spotify_access_token_failed: 'Spotify Connect initialization failed while requesting an internal access token. Copy the server report.',
  native_player_panicked: 'The native Spotify player panicked. Copy the server report.',
  native_connect_reconnect_failed: 'The native Spotify connection exhausted its reconnect attempts. Copy the server report.',
  native_player_shutdown: 'The native audio player shut down unexpectedly. Copy the server report.',
  native_account_mismatch: 'The server was paired with a different Spotify account. Stop the player, restart it, and approve the new QR with the account linked to this site.',
  encoder_exited: 'The audio encoder exited.',
};

export default function ServerPlayback({ enabled, fallbackReason, onModeChange }: { enabled: boolean; fallbackReason?: string; onModeChange: (enabled: boolean) => void }) {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(enabled); const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false); const [report, setReport] = useState<ServerReport>();
  const [error, setError] = useState<string>(); const [deviceId, setDeviceId] = useState<string>();
  const [streamUrl, setStreamUrl] = useState<string>(); const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState<SoloistSettings>(); const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false); const [bridge, setBridge] = useState<SoloistBridge>(); const [bridgeCopied, setBridgeCopied] = useState(false);
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
    if (!open || !paired) return; let cancelled = false;
    void soloistSettings().then(value => { if (!cancelled) setSettings(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, paired]);

  useEffect(() => {
    if (!enabled || !running) return;
    let cancelled = false;
    const check = async () => {
      if (polling.current) return; polling.current = true;
      try {
        const result = await serverRequest('status'); if (cancelled) return;
        setReport(result);
        if (result.backend === 'soloist') setSettings({ backend: 'soloist', keyConfigured: result.keyConfigured === true, sessionStored: result.sessionStored === true });
        if (result.sessionStored && result.authentication === 'accepted') setBridge(undefined);
        if (result.phase === 'setup_required') { setRunning(false); setStreamUrl(undefined); return; }
        if (result.phase === 'failed' || result.phase === 'stopped' || result.phase === 'idle') {
          setRunning(false); setStreamUrl(undefined); setServerAudio(null);
          playerService.setPlaybackDevice(null); setDeviceId(undefined);
          dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
          if (result.errorCode) {
            const invalidCredentials = result.diagnostics?.events?.some(event => event.reason === 'invalid_credentials');
            setError(invalidCredentials ? 'Spotify accepted native login but rejected the credentials used to initialize Spotify Connect. The server cannot play audio. Copy the server report.' : descriptions[result.errorCode] || 'Server playback failed. Copy the report for diagnosis.');
            setOpen(true);
          }
          return;
        }
        if (result.authentication === 'accepted') {
          setStreamUrl(current => current || `/api/server/stream?t=${Date.now()}`);
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
          if (e instanceof ServerPlaybackRequestError) setReport(e.report);
          setError(e instanceof Error ? e.message : 'Unable to check the server player.'); setRunning(false); setStreamUrl(undefined); setServerAudio(null); setOpen(true);
          setDeviceId(undefined); playerService.setPlaybackDevice(null);
          dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
        }
      } finally { polling.current = false; }
    };
    void check(); const timer = setInterval(() => void check(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled, running, dispatch]);

  const start = useCallback(async () => {
    if (operation.current) return; operation.current = true; setBusy(true); setError(undefined); setCopied(false); setSaved(false);
    try {
      const result = await serverRequest('start'); if (!alive.current) return;
      playerService.setPlaybackDevice(null); playerService.setPlaybackDeviceName(result.deviceName || null);
      setDeviceId(undefined); setReport(result); setRunning(result.phase !== 'setup_required' && result.phase !== 'failed'); setBridge(undefined);
      setStreamUrl(result.authentication === 'accepted' ? `/api/server/stream?t=${Date.now()}` : undefined);
    } catch (e) { if (alive.current) {
      if (e instanceof ServerPlaybackRequestError) setReport(e.report);
      setError(e instanceof Error ? e.message : 'Unable to start the server player.');
      setOpen(true);
    } }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => {
    if (!enabled || !paired) return;
    setOpen(true);
    // Defer until SDK cleanup completes. Strict Mode can cancel the first setup.
    const timer = setTimeout(() => void start(), 0);
    return () => clearTimeout(timer);
  }, [enabled, paired, start]);
  const stop = async (disable = false) => {
    if (operation.current) return; operation.current = true; setBusy(true); setError(undefined);
    try {
      if (enabled && paired) await serverRequest('stop');
      setRunning(false); setStreamUrl(undefined); setDeviceId(undefined); setServerAudio(null);
      setBridge(undefined);
      playerService.setPlaybackDevice(null); playerService.setPlaybackDeviceName(null);
      dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
      setReport({ version: 1, phase: 'stopped' });
      if (disable) onModeChange(false);
    } catch (e) { if (e instanceof ServerPlaybackRequestError) setReport(e.report); setError(e instanceof Error ? e.message : 'Unable to stop the server player.'); }
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
  const saveKey = async () => {
    if (operation.current || !apiKey.trim()) return; operation.current = true; setBusy(true); setError(undefined); setSaved(false);
    try {
      const result = await soloistSettings(apiKey.trim()); setSettings(result); setApiKey(''); setSaved(true); setRunning(false); setStreamUrl(undefined); setBridge(undefined);
      setDeviceId(undefined); setServerAudio(null);
      playerService.setPlaybackDevice(null); playerService.setPlaybackDeviceName(null);
      dispatch(spotifyActions.setDeviceId({ deviceId: null })); dispatch(spotifyActions.setState({ state: null }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save the Soloist key.'); }
    finally { operation.current = false; setBusy(false); }
  };
  const pairAndroid = async () => {
    if (operation.current) return; operation.current = true; setBusy(true); setError(undefined); setBridgeCopied(false);
    try { setBridge(await newSoloistBridge()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to create the Android pairing link.'); }
    finally { operation.current = false; setBusy(false); }
  };
  const copyBridge = async () => {
    if (!bridge) return;
    try { await navigator.clipboard.writeText(bridge.link); setBridgeCopied(true); }
    catch { setError('Select and copy the Android pairing link below.'); }
  };
  return <ConnectionTheme>
    {/* Keep the audio element mounted when the settings dialog is closed. */}
    <audio ref={audio} src={streamUrl} preload="none" style={{ display: 'none' }} />
    <Modal title="Server playback" open={open} onCancel={() => setOpen(false)} footer={null} className="connection-modal"
      zIndex={11000} focusTriggerAfterClose={false}>
      <div className="connection-content"><ConnectionBrand />
        <p className="connection-description">Play through this site’s server. Your device receives audio from this site.</p>
        {fallbackReason ? <p className="connection-note">Switched to server playback automatically because the browser player could not connect: {fallbackReason}</p> : null}
        {!paired ? <p className="connection-error">Server playback needs a QR session. Sign out and choose Log in with QR.</p> : null}
        {paired ? <div style={{ marginBottom: 20 }}>
          <p className="connection-description">Spotify Soloist</p>
          <p className="connection-note">Soloist runs in Cloudflare. Add your personal <a href="https://developer.spotify.com/dashboard/soloist" target="_blank" rel="noopener noreferrer">Soloist API key</a> once. Your Spotify Client ID is a different value.</p>
          {saved ? <p className="connection-status" role="status">Saved. Start the server player to continue.</p> : settings?.keyConfigured ? <p className="connection-note">API key saved. {settings.sessionStored ? 'The paired session is saved in Cloudflare.' : 'Complete Android pairing after starting the player.'}</p> : null}
          <label htmlFor="soloist-api-key" className="connection-note">{settings?.keyConfigured ? 'Replace Soloist API key' : 'Soloist API key'}</label>
          <input id="soloist-api-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={apiKey} onChange={event => { setApiKey(event.target.value); setSaved(false); }}
            style={{ width: '100%', boxSizing: 'border-box', padding: 12, margin: '8px 0 12px', background: '#000', color: '#fff', border: '1px solid #333', borderRadius: 8 }} />
          <button className="connection-button connection-button-secondary" disabled={busy || !apiKey.trim()} onClick={() => void saveKey()}>Save Soloist key</button>
        </div> : null}
        {!enabled ? <button className="connection-button connection-button-wide" disabled={!paired} onClick={() => { setError(undefined); onModeChange(true); }}>Use server playback</button> : <>
          <p className="connection-status" role="status">{report?.phase === 'setup_required' ? 'Add a Soloist API key to continue.' : report?.phase === 'waiting_for_pairing' && report.backend === 'soloist' ? 'Waiting for Android pairing' : report?.phase === 'streaming' ? 'Server is sending audio' : deviceId ? 'Ready. Choose a track and enable audio.' : running ? 'Connecting the server player...' : 'Server playback selected'}</p>
          {report?.backend === 'soloist' && report.phase === 'waiting_for_pairing' ? <div style={{ marginBottom: 20 }}>
            <p className="connection-note">Run the Android pairing bridge in Termux, then paste the private link below. Open Spotify on the same Wi-Fi and select {report.deviceName}. Android is only needed for initial pairing.</p>
            <button className="connection-button" disabled={busy} onClick={() => void pairAndroid()}>{bridge ? 'Create a new Android pairing link' : 'Create Android pairing link'}</button>
            {bridge ? <>
              <QRCode value={bridge.link} size={180} color="#000" bgColor="#fff" style={{ margin: '16px auto', padding: 12 }} />
              <textarea aria-label="Android pairing link" readOnly value={bridge.link} style={{ width: '100%', boxSizing: 'border-box', background: '#000', color: '#bbb', padding: 12, border: '1px solid #333', borderRadius: 8 }} />
              <button className="connection-button connection-button-secondary" onClick={() => void copyBridge()}>{bridgeCopied ? 'Copied' : 'Copy Android pairing link'}</button>
              <p className="connection-note">This link expires in 20 minutes and closes after the session is saved. Keep it private.</p>
            </> : null}
          </div> : null}
          {report?.pairing ? <div style={{ marginBottom: 20 }}>
            <p className="connection-description">Authorize server playback</p>
            <p className="connection-note">Scan this QR with your phone and approve it using the same Spotify account linked to this site. This authorization is separate from library access.</p>
            <QRCode value={report.pairing.url} size={180} color="#000" bgColor="#fff" style={{ margin: '16px auto', padding: 12 }} />
            <p className="connection-status" style={{ textAlign: 'center' }}>Pairing code: {report.pairing.code}</p>
            <a className="connection-button connection-button-secondary" href={report.pairing.url} target="_blank" rel="noopener noreferrer">Open Spotify pairing</a>
          </div> : null}
          <Space wrap style={{ marginBottom: 16 }}>
            <button className="connection-button" aria-busy={busy} disabled={busy || !paired || running} onClick={() => void start()}>Start server player</button>
            <button className="connection-button connection-button-secondary" disabled={!streamUrl || busy} onClick={enableAudio}>Enable audio</button>
            <button className="connection-button connection-button-secondary" disabled={busy || !report} onClick={() => void stop()}>Stop server player</button>
          </Space>
          <p className="connection-note">The server starts automatically. Wait until it is ready, enable audio, then close this dialog and choose a song. Playback is experimental. A failed or stopped server needs Start server player to retry.</p>
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
