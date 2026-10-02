import { useEffect, useState } from 'react';
import { pairingRequest } from '../../utils/spotify/pairing';

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
  return <main style={{ maxWidth: 520, margin: '8vh auto', padding: 24, color: '#fff', lineHeight: 1.6 }}>
    <h1 style={{ fontSize: 28, color: '#fff' }}>Connect another device</h1>
    <p>You are about to connect your Spotify account to another browser.</p>
    {info ? <>
      <p>Check that the other device shows this verification code:</p>
      <p style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4 }}>{info.code.slice(0, 4)} {info.code.slice(4)}</p>
      <label style={{ display: 'flex', gap: 12, margin: '24px 0' }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        <span>I started this connection and both verification codes match.</span>
      </label>
      <button disabled={!confirmed || busy} onClick={() => void authorize()} style={{ background: '#1ed760', color: '#000', border: 0, borderRadius: 24, padding: '12px 24px', opacity: !confirmed || busy ? 0.5 : 1 }}>
        {busy ? 'Opening Spotify...' : 'Continue with Spotify'}
      </button>
      <p>Finish signing in, then return to the other device. This phone does not receive its browser session.</p>
    </> : !error ? <p role="status">Loading connection...</p> : null}
    {error ? <p role="alert" style={{ color: '#ffb4b4' }}>{error}</p> : null}
  </main>;
}
