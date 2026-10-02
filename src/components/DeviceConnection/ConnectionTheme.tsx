import { ConfigProvider, theme } from 'antd';
import type { ReactNode } from 'react';
import { connectionCss } from '../../../cloudflare/connection-theme.mjs';

export function ConnectionTheme({ children }: { children: ReactNode }) {
  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#1ed760', colorBgElevated: '#121212', fontFamily: 'SpotifyMixUI, system-ui, sans-serif', borderRadius: 8 } }}>
    <style>{connectionCss}</style>{children}
  </ConfigProvider>;
}

export function ConnectionBrand() {
  return <p className="connection-brand"><span className="connection-mark" aria-hidden="true">♪</span>Spotify Web Client</p>;
}

export function QrIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM12 3v9H3M12 15v6M21 12h-6" />
  </svg>;
}
