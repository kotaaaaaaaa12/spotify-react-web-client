import { useEffect, useState } from 'react';
import { pairingRequest } from '../../utils/spotify/pairing';
import { ConnectionBrand, ConnectionTheme } from '../../components/DeviceConnection/ConnectionTheme';

export default function PairDevice() {
  const id = new URLSearchParams(location.search).get('id') || '';
  const [info, setInfo] = useState<{ code: string; expiresAt: number }>();
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (!/^[a-f0-9]{32}$/.test(id)) { setError('This connection link is invalid.'); return; }
    pairingRequest(`info?id=${id}`).then(data => { if (active) setInfo(data); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id]);
  const authorize = async () => {
    setBusy(true); setError(undefined);
    try {
      const data = await pairingRequest(`authorize?id=${id}`, 'POST');
      const url = new URL(data.url);
      if (url.origin !== 'https://accounts.spotify.com') throw new Error('Invalid Spotify authorization URL.');
      location.assign(url.href);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to start Spotify sign-in.'); setBusy(false); }
  };
  return <ConnectionTheme><main className="connection-page"><section className="connection-card connection-content">
    <ConnectionBrand />
    <div className="connection-steps"><span>1 · Scan</span><span className="is-active">2 · Confirm</span><span>3 · Log in</span></div>
    <h1 className="connection-heading">Log in with QR</h1>
    <p className="connection-description">Sign in on this phone to connect your Spotify account to the other browser.</p>
    {info ? <>
      <div className="connection-code"><span className="connection-code-label">Check this code on both screens</span><strong>{info.code.slice(0, 4)} {info.code.slice(4)}</strong></div>
      <label className="connection-confirm">
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        <span>I started this connection and both verification codes match.</span>
      </label>
      <button className="connection-button connection-button-wide" disabled={!confirmed || busy} onClick={() => void authorize()}>
        {busy ? 'Opening Spotify...' : 'Continue with Spotify'}
      </button>
      <p className="connection-note">Keep the other window open. It will finish signing in automatically.</p>
    </> : !error ? <p className="connection-status" role="status">Loading connection...</p> : null}
    {error ? <p className="connection-error" role="alert">{error}</p> : null}
  </section></main></ConnectionTheme>;
}
