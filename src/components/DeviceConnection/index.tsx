import { useEffect, useState } from 'react';
import { Alert, Button, ConfigProvider, Modal, QRCode, Space, Typography, theme } from 'antd';
import { DeviceConnection, pairingRequest, savePairedToken } from '../../utils/spotify/pairing';

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

  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
    <Button onClick={() => void start()} size="small" style={{ color: '#fff' }}>Connect with phone</Button>
    <Modal title={<span style={{ color: '#fff' }}>Connect with another device</span>} open={open} onCancel={() => setOpen(false)} footer={null} focusTriggerAfterClose={false}>
      <Space direction="vertical" size="middle" style={{ width: '100%', color: '#fff' }}>
        <p>Scan this code with your phone, or open the connection link on another device.</p>
        <p>Check that both screens show the same verification code before signing in with Spotify.</p>
        {busy ? <p role="status">Creating a connection...</p> : null}
        {connection ? <>
          <QRCode value={connection.link} bgColor="#ffffff" color="#000000" style={{ margin: '0 auto' }} />
          <Typography.Title level={3} style={{ textAlign: 'center', letterSpacing: 3, color: '#fff' }}>{connection.code.slice(0, 4)} {connection.code.slice(4)}</Typography.Title>
          <Typography.Paragraph copyable={{ text: connection.link }} style={{ overflowWrap: 'anywhere', color: '#fff' }}>{connection.link}</Typography.Paragraph>
          <p>This link expires in ten minutes. Keep this window open until the connection finishes.</p>
        </> : null}
        {error ? <Alert type="error" showIcon message={error} /> : null}
        {error ? <Button loading={busy} onClick={() => void start()}>Create a new connection</Button> : null}
      </Space>
    </Modal>
  </ConfigProvider>;
}
