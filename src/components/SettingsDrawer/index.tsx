import { useState } from 'react';
import { Button, ConfigProvider, Drawer, theme } from 'antd';
import { FiSettings } from 'react-icons/fi';
import { useAppDispatch, useAppSelector } from '../../store/store';
import { languageActions } from '../../store/slices/language';
import PlayerDiagnostics from '../DeviceConnection/PlayerDiagnostics';
import { SERVER_DIALOG_EVENT } from '../../utils/spotify/serverPlayback';

export default function SettingsDrawer() {
  const [open, setOpen] = useState(false);
  const user = useAppSelector((state) => !!state.auth.user);
  const dispatch = useAppDispatch();
  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
    <button className="navbar-icon-button" aria-label="Settings" title="Settings" onClick={() => setOpen(true)}><FiSettings size={22} /></button>
    <Drawer title="Settings" placement="left" width="min(380px, 100vw)" open={open} onClose={() => setOpen(false)} autoFocus={false}
      rootClassName="spotify-settings-drawer" zIndex={10020}>
      <div className="settings-section">
        <h2>Playback and connection</h2>
        {user ? <>
          <PlayerDiagnostics />
          <Button onClick={() => { setOpen(false); window.dispatchEvent(new Event(SERVER_DIALOG_EVENT)); }}>Server playback</Button>
        </> : <p>Log in to manage playback and check your connection.</p>}
      </div>
      <div className="settings-section">
        <h2>Language</h2>
        <Button onClick={() => { setOpen(false); dispatch(languageActions.openLanguageModal()); }}>Change language</Button>
      </div>
    </Drawer>
  </ConfigProvider>;
}
