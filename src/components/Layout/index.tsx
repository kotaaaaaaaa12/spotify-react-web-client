import { memo, useEffect, type FC, type ReactElement } from 'react';

// Components
import { Navbar } from './components/Navbar';
import { Library } from './components/Library';
import PlayingBar from './components/PlayingBar';
import { PlayingNow } from './components/NowPlaying';
import { LanguageModal } from '../Modals/LanguageModal';
import { LibraryDrawer } from '../Drawers/LibraryDrawer';
import { PlayingNowDrawer } from '../Drawers/PlayingNowDrawer';
import { EditPlaylistModal } from '../Modals/EditPlaylistModal';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

// Redux
import { useAppDispatch, useAppSelector } from '../../store/store';
import { isActiveOnOtherDevice, spotifyActions } from '../../store/slices/spotify';
import { getLibraryCollapsed, isRightLayoutOpen, uiActions } from '../../store/slices/ui';
import { LoginFooter } from './components/LoginFooter';
import { LoginModal } from '../Modals/LoginModal';
import useCompactLayout from '../../utils/useCompactLayout';
import useIsMobile from '../../utils/isMobile';

const pct = (value: number) => `${value}%`;

export const AppLayout: FC<{ children: ReactElement }> = memo((props) => {
  const dispatch = useAppDispatch();
  const user = useAppSelector((state) => !!state.auth.user);
  const rightLayoutOpen = useAppSelector(isRightLayoutOpen);
  const libraryCollapsed = useAppSelector(getLibraryCollapsed);
  const hasState = useAppSelector((state) => !!state.spotify.state);
  const activeOnOtherDevice = useAppSelector(isActiveOnOtherDevice);

  const isTablet = useCompactLayout();

  const isMobile = useIsMobile();
  const showDetails = rightLayoutOpen && hasState && !isTablet;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: isMobile ? 'persistence-phone' : isTablet ? 'persistence-touch' : 'persistence',
    storage: localStorage,
    panelIds: isMobile ? ['center'] : showDetails ? ['left', 'center', 'details-section'] : ['left', 'center'],
  });

  useEffect(() => {
    if (isTablet) { dispatch(uiActions.collapseLibrary()); dispatch(uiActions.collapseRightLayout()); }
  }, [dispatch, isTablet]);

  useEffect(() => {
    if (user) dispatch(spotifyActions.fetchDevices());
  }, [user, dispatch]);

  // In v4, Panel `style` applies to an inner wrapper — min/max width there no longer
  // constrains the flex item, so unused outer width shows up as a gap. Use size props instead.
  const leftPanelSize = isTablet
    ? { minSize: 84, maxSize: 84, defaultSize: 84 }
    : libraryCollapsed
      ? { minSize: 85, maxSize: 85, defaultSize: 85 }
      : { minSize: 280, maxSize: pct(28), defaultSize: pct(22) };

  return (
    <>
      {/* Modals & Drawers */}
      <LanguageModal />
      <LibraryDrawer />
      <PlayingNowDrawer />
      <EditPlaylistModal />
      <LoginModal />

      {/* Main Component */}
      <div className='main-container'>
        <div
          className='app-shell-grid'
          style={{
            overflow: 'hidden',
            height: `calc(100dvh - ${user ? (isMobile ? (hasState ? 164 : 74) : isTablet ? (hasState ? 105 : 14) : 105) + (activeOnOtherDevice ? 36 : 0) : 70}px - env(safe-area-inset-bottom, 0px))`,
          }}
        >
          <div className='app-shell-header'>
            <Navbar />
          </div>

          <div className='app-shell-content'>
            <Group
              orientation='horizontal'
              defaultLayout={defaultLayout}
              onLayoutChanged={onLayoutChanged}
              style={{ height: '100%', width: '100%' }}
            >
              {!isMobile ? <Panel
                id='left'
                className='mobile-hidden'
                groupResizeBehavior={libraryCollapsed ? 'preserve-pixel-size' : 'preserve-relative-size'}
                {...leftPanelSize}
                style={{ borderRadius: 5 }}
              >
                <Library />
              </Panel> : null}

              {!isMobile ? <Separator className='resize-handler' /> : null}

              <Panel id='center' style={{ borderRadius: 5 }}>
                {/* Home | Playlists */}
                {props.children}
              </Panel>

              {showDetails ? (
                <>
                  {!isTablet ? <Separator className='resize-handler' /> : null}
                  <Panel
                    id='details-section'
                    minSize={pct(23)}
                    maxSize={pct(30)}
                    defaultSize={pct(25)}
                    style={{ borderRadius: 5 }}
                  >
                    <PlayingNow />
                  </Panel>
                </>
              ) : null}
            </Group>
          </div>
        </div>
      </div>

      {<footer>{user ? <PlayingBar /> : <LoginFooter />}</footer>}
    </>
  );
});

AppLayout.displayName = 'AppLayout';
