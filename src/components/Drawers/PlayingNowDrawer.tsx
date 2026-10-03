import useCompactLayout from '../../utils/useCompactLayout';
import { memo } from 'react';

// Components
import { ConfigProvider, Drawer, theme } from 'antd';
import { PlayingNow } from '../Layout/components/NowPlaying';

// Redux
import { useAppDispatch, useAppSelector } from '../../store/store';
import { isRightLayoutOpen, uiActions } from '../../store/slices/ui';

export const PlayingNowDrawer = memo(() => {
  const compact = useCompactLayout();
  const dispatch = useAppDispatch();

  const open = useAppSelector(isRightLayoutOpen);
  const details = useAppSelector((state) => !state.ui.detailsCollapsed);
  const hasTrack = useAppSelector((state) => !!state.spotify.state?.track_window.current_track);
  const devices = useAppSelector((state) => !state.ui.devicesCollapsed);

  if (!compact) return null;

  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <Drawer open={open} rootClassName="spotify-mobile-drawer" title={devices ? 'Devices' : details ? 'Now playing' : 'Queue'}
        width="100%" zIndex={10010} autoFocus={false} onClose={() => dispatch(uiActions.collapseRightLayout())}>
        {details && !hasTrack ? <p className="drawer-empty-state">No track is playing. Close this panel to return to your library.</p> : <PlayingNow />}
      </Drawer>
    </ConfigProvider>
  );
});

PlayingNowDrawer.displayName = 'PlayingNowDrawer';
