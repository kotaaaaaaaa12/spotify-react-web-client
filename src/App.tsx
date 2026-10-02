/* eslint-disable react-hooks/exhaustive-deps */
import './styles/App.scss';

// Utils
import i18next from 'i18next';
import { FC, Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPlayerAccessToken } from './utils/spotify/playerDiagnostics';

// Components
import { Alert, Button, ConfigProvider, Space } from 'antd';
import { AppLayout } from './components/Layout';
import { Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';

// Redux
import { Provider } from 'react-redux';
import { uiActions } from './store/slices/ui';
import { PersistGate } from 'redux-persist/integration/react';
import { authActions, initializeSpotifySession } from './store/slices/auth';
import { persistor, store, useAppDispatch, useAppSelector } from './store/store';

// Spotify
import WebPlayback, { WebPlaybackProps } from './utils/spotify/webPlayback';

// Pages
import SearchContainer from './pages/Search/Container';
import { playerService } from './services/player';
import { Spinner } from './components/spinner/spinner';
import { ConnectionTheme } from './components/DeviceConnection/ConnectionTheme';
import PlayerDiagnostics from './components/DeviceConnection/PlayerDiagnostics';

const FollowedArtists = lazy(() => import('./pages/FollowedArtists'));
const Home = lazy(() => import('./pages/Home'));
const Page404 = lazy(() => import('./pages/404'));
const AlbumView = lazy(() => import('./pages/Album'));
const GenrePage = lazy(() => import('./pages/Genre'));
const BrowsePage = lazy(() => import('./pages/Browse'));
const ArtistPage = lazy(() => import('./pages/Artist'));
const PlaylistView = lazy(() => import('./pages/Playlist'));
const ArtistDiscographyPage = lazy(() => import('./pages/Discography'));

const Profile = lazy(() => import('./pages/User/Home'));
const ProfileTracks = lazy(() => import('./pages/User/Songs'));
const ProfileArtists = lazy(() => import('./pages/User/Artists'));
const ProfilePlaylists = lazy(() => import('./pages/User/Playlists'));

const SearchPage = lazy(() => import('./pages/Search/Home'));
const SearchTracks = lazy(() => import('./pages/Search/Songs'));
const LikedSongsPage = lazy(() => import('./pages/LikedSongs'));
const SearchAlbums = lazy(() => import('./pages/Search/Albums'));
const SearchPlaylist = lazy(() => import('./pages/Search/Playlists'));
const SearchPageArtists = lazy(() => import('./pages/Search/Artists'));
const RecentlySearched = lazy(() => import('./pages/Search/RecentlySearched'));

window.addEventListener('resize', () => {
  const vh = window.innerWidth;
  if (vh < 950) {
    store.dispatch(uiActions.collapseLibrary());
  }
});

const SpotifyContainer: FC<{ children: any }> = memo(({ children }) => {
  const dispatch = useAppDispatch();
  const [playerError, setPlayerError] = useState<string>();
  const [playerAttempt, setPlayerAttempt] = useState(0);
  const [retryBusy, setRetryBusy] = useState(false);
  const authError = useAppSelector((state) => state.auth.error);

  const user = useAppSelector((state) => !!state.auth.user);
  const requesting = useAppSelector((state) => state.auth.requesting);

  useEffect(() => {
    dispatch(initializeSpotifySession());
  }, [dispatch]);

  const webPlaybackSdkProps: WebPlaybackProps = useMemo(
    () => ({
      playerAutoConnect: true,
      playerInitialVolume: 1.0,
      playerRefreshRateMs: 1000,
      playerName: 'Spotify React Player',
      onPlayerRequestAccessToken: () => getPlayerAccessToken(),
      onPlayerLoading: () => {},
      onPlayerWaitingForDevice: () => {
        dispatch(authActions.setPlayerLoaded({ playerLoaded: true }));
      },
      onPlayerError: (e) => {
        // Don't re-login on every player error. Non-Premium accounts emit `account_error`
        // ("premium required") and failed transfers emit errors on each attempt — calling
        // loginToSpotify() here caused an endless re-login loop. Just surface it; token
        // refresh is handled by the axios 401 interceptor + onPlayerRequestAccessToken.
        setPlayerError(e);
      },
      onPlayerDeviceSelected: () => {
        dispatch(authActions.setPlayerLoaded({ playerLoaded: true }));
      },
    }),
    [dispatch]
  );

  const retry = async () => {
    setRetryBusy(true); dispatch(authActions.clearError());
    try {
      // A player rejection can happen before the cached token's expiry. Refresh
      // before creating a replacement player, instead of replaying that token.
      if (playerError) await getPlayerAccessToken(true);
      await dispatch(initializeSpotifySession()).unwrap();
      setPlayerError(undefined); setPlayerAttempt(value => value + 1);
    } catch (e) { setPlayerError(e instanceof Error ? e.message : 'Unable to reconnect the player.'); }
    finally { setRetryBusy(false); }
  };

  const error = authError || playerError;
  const content = <>
    {error ? <ConnectionTheme><Alert className="player-connection-alert" type="error" message={authError ? 'Spotify Web API' : 'Spotify player'} description={error} showIcon
      action={<Space wrap><Button loading={retryBusy} onClick={() => void retry()}>Retry</Button><PlayerDiagnostics /></Space>}
      style={{ position: 'fixed', top: 8, left: 8, right: 8, zIndex: 10000 }} /></ConnectionTheme> : null}
    {children}
  </>;
  if (!user) return <Spinner loading={requesting}>{content}</Spinner>;
  return <WebPlayback key={playerAttempt} {...webPlaybackSdkProps}>{content}</WebPlayback>;
});

const RoutesComponent = memo(() => {
  const location = useLocation();
  const container = useRef<HTMLDivElement>(null);
  const user = useAppSelector((state) => !!state.auth.user);

  useEffect(() => {
    if (container.current) {
      container.current.scrollTop = 0;
    }
  }, [location, container]);

  const routes = useMemo(
    () =>
      [
        { path: '', element: <Home container={container} />, public: true },
        { path: '/collection/artists', element: <FollowedArtists /> },
        { path: '/collection/tracks', element: <LikedSongsPage container={container} /> },
        {
          public: true,
          path: '/playlist/:playlistId',
          element: <PlaylistView container={container} />,
        },
        { path: '/album/:albumId', element: <AlbumView container={container} /> },
        {
          path: '/artist/:artistId/discography',
          element: <ArtistDiscographyPage container={container} />,
        },
        { public: true, path: '/artist/:artistId', element: <ArtistPage container={container} /> },
        { path: '/users/:userId/artists', element: <ProfileArtists container={container} /> },
        { path: '/users/:userId/playlists', element: <ProfilePlaylists container={container} /> },
        { path: '/users/:userId/tracks', element: <ProfileTracks container={container} /> },
        { path: '/users/:userId', element: <Profile container={container} /> },
        { public: true, path: '/genre/:genreId', element: <GenrePage /> },
        { public: true, path: '/search', element: <BrowsePage /> },
        { path: '/recent-searches', element: <RecentlySearched /> },
        {
          public: true,
          path: '/search/:search',
          element: <SearchContainer container={container} />,
          children: [
            {
              path: 'artists',
              element: <SearchPageArtists container={container} />,
            },
            {
              path: 'albums',
              element: <SearchAlbums container={container} />,
            },
            {
              path: 'playlists',
              element: <SearchPlaylist container={container} />,
            },
            {
              path: 'tracks',
              element: <SearchTracks container={container} />,
            },
            {
              path: '',
              element: <SearchPage container={container} />,
            },
          ],
        },
        { path: '*', element: <Page404 /> },
      ].filter((r) => (user ? true : r.public)),
    [container, user]
  );

  return (
    <div
      className='Main-section'
      ref={container}
      style={{
        height: user ? undefined : `calc(100vh - 50px)`,
      }}
    >
      <div
        style={{
          minHeight: user ? 'calc(100vh - 230px)' : 'calc(100vh - 100px)',
          width: '100%',
        }}
      >
        <Routes>
          {routes.map((route) => (
            <Route
              key={route.path}
              path={route.path}
              element={<Suspense>{route.element}</Suspense>}
            >
              {route?.children
                ? route.children.map((child) => (
                    <Route
                      key={child.path}
                      path={child.path}
                      element={<Suspense>{child.element}</Suspense>}
                    />
                  ))
                : undefined}
            </Route>
          ))}
        </Routes>
      </div>
    </div>
  );
});

const RootComponent = () => {
  const user = useAppSelector((state) => !!state.auth.user);
  const language = useAppSelector((state) => state.language.language);
  const playing = useAppSelector((state) => !state.spotify.state?.paused);

  useEffect(() => {
    document.documentElement.setAttribute('lang', language);
    i18next.changeLanguage(language);
  }, [language]);

  const handleSpaceBar = useCallback(
    (e: KeyboardEvent) => {
      // @ts-ignore
      if (e.target?.tagName?.toUpperCase() === 'INPUT') return;
      if (playing === undefined) return;
      e.stopPropagation();
      if (e.key === ' ' || e.code === 'Space' || e.keyCode === 32) {
        e.preventDefault();
        const request = !playing ? playerService.startPlayback() : playerService.pausePlayback();
        request.then().catch(() => {});
      }
    },
    [playing]
  );

  useEffect(() => {
    if (!user) return;
    document.addEventListener('keydown', handleSpaceBar);
    return () => {
      document.removeEventListener('keydown', handleSpaceBar);
    };
  }, [user, handleSpaceBar]);

  useEffect(() => {
    if (!user) return;
    const handleContextMenu = (e: any) => {
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('keydown', handleContextMenu);
    };
  }, [user]);

  return (
    <Router>
      <AppLayout>
        <RoutesComponent />
      </AppLayout>
    </Router>
  );
};

function App() {
  return (
    <ConfigProvider theme={{ token: { fontFamily: 'SpotifyMixUI' } }}>
      <Provider store={store}>
        <PersistGate loading={null} persistor={persistor}>
          <SpotifyContainer>
            <RootComponent />
          </SpotifyContainer>
        </PersistGate>
      </Provider>
    </ConfigProvider>
  );
}

export default App;
