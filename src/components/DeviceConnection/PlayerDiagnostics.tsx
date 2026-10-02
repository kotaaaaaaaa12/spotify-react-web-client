import { useRef, useState } from 'react';
import { Button, Modal } from 'antd';
import { ConnectionBrand, ConnectionTheme } from './ConnectionTheme';
import { PlayerCheck, PlayerReport, runPlayerDiagnostics } from '../../utils/spotify/playerDiagnostics';

function resultText(check: PlayerCheck) {
  if (check.result === 'skipped') return 'Available with QR login';
  if (check.result === 'timed_out') return 'Timed out · no HTTP response';
  if (check.result === 'no_response') return 'No HTTP response';
  return `HTTP ${check.httpStatus} · ${check.result}${check.subscription ? ` · ${check.subscription}` : ''}`;
}

export default function PlayerDiagnostics() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<PlayerReport>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const running = useRef(false);
  const run = async () => {
    setOpen(true);
    if (running.current) return;
    running.current = true; setBusy(true); setError(undefined); setReport(undefined); setCopied(false);
    try { setReport(await runPlayerDiagnostics()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to check this connection.'); }
    finally { running.current = false; setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied(true); }
    catch { setError('Clipboard access is unavailable. Select and copy the report below.'); }
  };
  return <ConnectionTheme>
    <Button onClick={() => void run()}>Check connection</Button>
    <Modal title="Player connection check" className="connection-modal" zIndex={11000} open={open} onCancel={() => setOpen(false)} footer={null} focusTriggerAfterClose={false}>
      <div className="connection-content">
        <ConnectionBrand />
        <p className="connection-description">Compare the browser’s direct request with this site’s Worker request. This checks account access and playback scope; the SDK connects separately.</p>
        {busy ? <p className="connection-status" role="status">Checking connection...</p> : null}
        {report ? <>
          <div style={{ display: 'grid', gap: 12 }}>
            {report.checks.map(check => <div key={check.name} className="connection-code" style={{ textAlign: 'left', margin: 0 }}>
              <span className="connection-code-label">{check.name}</span>
              <span style={{ color: check.result === 'accepted' ? '#1ed760' : '#fff', fontSize: 14 }}>{resultText(check)}</span>
            </div>)}
          </div>
          <p className="connection-note">A request without an HTTP response does not identify the exact cause. If these checks pass, the SDK’s remaining connection still needs investigation.</p>
          <textarea aria-label="Connection report" readOnly value={JSON.stringify(report, null, 2)} style={{ width: '100%', minHeight: 170, margin: '18px 0', padding: 12, background: '#000', border: '1px solid #333', borderRadius: 8, color: '#b3b3b3', fontFamily: 'monospace', fontSize: 12 }} />
          <button className="connection-button connection-button-wide" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy report'}</button>
          <p className="connection-note">The report contains no tokens, email addresses, or account IDs.</p>
        </> : null}
        {error ? <p className="connection-error" role="alert">{error}</p> : null}
        {!busy ? <button className="connection-button connection-button-secondary" style={{ marginTop: 16 }} onClick={() => void run()}>Run again</button> : null}
      </div>
    </Modal>
  </ConnectionTheme>;
}
