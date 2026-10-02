import { useEffect, useState } from 'react';
import { Modal, QRCode, Typography } from 'antd';
import { DeviceConnection, pairingRequest, savePairedToken } from '../../utils/spotify/pairing';
import { ConnectionBrand, ConnectionTheme, QrIcon } from './ConnectionTheme';

export default function DeviceConnectionButton() {
  const [open, setOpen] = useState(false);
  const [connection, setConnection] = useState<DeviceConnection>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setOpen(true); setBusy(true); setError(undefined); setConnection(undefined);
    try { setConnection(await pairingRequest('new', 'POST')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to start a device connection.'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!open || !connection) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (Date.now() >= connection!.expiresAt) { setError('This connection expired. Create a new connection.'); return; }
      try {
        const data = await pairingRequest('session');
        if (!active) return;
        if (data.status === 'ready') {
          savePairedToken(data);
          location.assign('/');
          return;
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Unable to check this connection.');
        return;
      }
      if (active) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [open, connection]);

  return <ConnectionTheme>
    <button onClick={() => void start()} className="connection-button connection-button-secondary"><QrIcon />Log in with QR</button>
    <Modal title="Log in with QR" className="connection-modal" open={open} onCancel={() => setOpen(false)} footer={null} focusTriggerAfterClose={false}
      styles={{ content: { background: '#121212', border: '1px solid #282828', borderRadius: 12, padding: 28 }, header: { background: 'transparent' } }}>
      <div className="connection-content">
        <ConnectionBrand />
        <div className="connection-steps"><span className="is-active">1 · Scan</span><span>2 · Confirm</span><span>3 · Log in</span></div>
        <p className="connection-description">Scan with your phone, then sign in to Spotify there to connect this browser.</p>
        {busy ? <p className="connection-status" role="status">Creating your QR code...</p> : null}
        {connection ? <>
          <div className="connection-qr"><QRCode value={connection.link} size={216} bgColor="#ffffff" color="#000000" bordered={false} style={{ padding: 12, borderRadius: 8 }} /></div>
          <div className="connection-code"><span className="connection-code-label">Check this code on both screens</span><strong>{connection.code.slice(0, 4)} {connection.code.slice(4)}</strong></div>
          <div className="connection-link"><Typography.Paragraph copyable={{ text: connection.link }}>{connection.link}</Typography.Paragraph></div>
          {!error ? <p className="connection-status" role="status"><span className="connection-dot" />Waiting for your phone...</p> : null}
          <p className="connection-note">Expires in 10 minutes. Keep this window open until sign-in finishes.</p>
        </> : null}
        {error ? <p className="connection-error" role="alert">{error}</p> : null}
        {error ? <button className="connection-button connection-button-wide" disabled={busy} onClick={() => void start()}>Create a new QR code</button> : null}
      </div>
    </Modal>
  </ConnectionTheme>;
}
