import { useCallback, useState } from 'react';

import { Alert, Button, ConfigProvider, Modal, Popconfirm, Space, theme } from 'antd';
import { Link } from 'react-router-dom';
import { CloseIcon } from '../../../Icons';
import { WhiteButton } from '../../../Button';

// Utils
import { useTranslation } from 'react-i18next';

// Redux
import { uiActions } from '../../../../store/slices/ui';
import { loginToSpotify } from '../../../../store/slices/auth';
import { useAppDispatch, useAppSelector } from '../../../../store/store';

// Constants
import { ARTISTS_DEFAULT_IMAGE } from '../../../../constants/spotify';
import { signOutSpotify } from '../../../../utils/spotify/login';
import DeviceConnectionButton from '../../../DeviceConnection';
import PlayerDiagnostics from '../../../DeviceConnection/PlayerDiagnostics';
import { ConnectionTheme } from '../../../DeviceConnection/ConnectionTheme';
import { SERVER_DIALOG_EVENT } from '../../../../utils/spotify/serverPlayback';
import useIsMobile from '../../../../utils/isMobile';

const LoginButton = () => {
  const { t } = useTranslation(['home']);
  const dispatch = useAppDispatch();
  const tooltipOpen = useAppSelector((state) => state.ui.loginButtonOpen);

  const onClose = useCallback(() => {
    dispatch(uiActions.closeLoginButton());
  }, [dispatch]);

  return (
    <Popconfirm
      icon={null}
      open={tooltipOpen}
      onCancel={onClose}
      placement='bottomLeft'
      rootClassName='login-tooltip'
      cancelText={<CloseIcon />}
      title={t('You’re logged out')}
      cancelButtonProps={{ type: 'text' }}
      okButtonProps={{ className: 'white-button small' }}
      description={t('Log in to add this to your Liked Songs.')}
    >
      <WhiteButton title={t('Log In')} onClick={() => dispatch(loginToSpotify())} />
    </Popconfirm>
  );
};

const Header = ({ opacity }: { opacity: number; title?: string }) => {
  const isMobile = useIsMobile();
  const { t } = useTranslation(['navbar']);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();
  const signOut = async () => {
    setSignOutBusy(true); setSignOutError(undefined);
    try { await signOutSpotify(); location.assign('/'); }
    catch (error) { setSignOutError(error instanceof Error ? error.message : 'Unable to sign out. Try again.'); setSignOutBusy(false); }
  };

  const user = useAppSelector(
    (state) => state.auth.user,
    (prev, next) => prev?.id === next?.id
  );

  return (
    <><div
      className={`flex r-0 w-full flex-row items-center justify-between bg-gray-900 rounded-t-md z-10`}
      style={{ backgroundColor: `rgba(12, 12, 12, ${opacity}%)` }}
    >
      <div className='flex flex-row items-center'>
        <Space wrap>
          {!isMobile ? (
            <a
              target='_blank'
              rel='noreferrer'
              className='contact-me'
              href='https://github.com/francoborrelli/spotify-react-web-client'
            >
              <span>{t('Source code')}</span>
            </a>
          ) : null}

          {/*
          <div className='news'>
            <News />
          </div> */}

          {user ? <Link to="/collection/artists" title="Followed artists" style={{ whiteSpace: 'nowrap', color: '#fff' }}>{isMobile ? 'Artists' : 'Followed artists'}</Link> : null}
          {user ? <PlayerDiagnostics /> : null}
          {user ? <ConnectionTheme><Button style={{ minHeight: 44 }} onClick={() => window.dispatchEvent(new Event(SERVER_DIALOG_EVENT))}>Server playback</Button></ConnectionTheme> : null}
          {user ? <Button type="text" style={{ color: 'white' }} onClick={() => { setSignOutError(undefined); setSignOutOpen(true); }}>Sign out</Button> : null}
          {user ? (
            <div className='avatar-container'>
              <Link to={`/users/${user!.id}`}>
                <img
                  className='avatar'
                  id='user-avatar'
                  alt='User Avatar'
                  style={{ marginTop: -1 }}
                  src={
                    user?.images && user.images.length ? user.images[0].url : ARTISTS_DEFAULT_IMAGE
                  }
                />
              </Link>
            </div>
          ) : (
            <><DeviceConnectionButton /><LoginButton /></>
          )}
        </Space>
      </div>
    </div>
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <Modal title={<span style={{ color: '#fff' }}>Sign out of this browser?</span>} open={signOutOpen}
        onCancel={() => setSignOutOpen(false)} onOk={() => void signOut()} okText="Sign out" cancelText="Cancel"
        confirmLoading={signOutBusy} closable={!signOutBusy} maskClosable={!signOutBusy} keyboard={!signOutBusy}
        cancelButtonProps={{ disabled: signOutBusy, autoFocus: false }} okButtonProps={{ autoFocus: false }} focusTriggerAfterClose={false}>
        <p style={{ color: '#fff' }}>Your Spotify library will stay in your account.</p>
        {signOutError ? <Alert type="error" showIcon message={signOutError} /> : null}
      </Modal>
    </ConfigProvider></>
  );
};

export default Header;
