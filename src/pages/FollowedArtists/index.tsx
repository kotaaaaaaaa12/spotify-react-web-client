import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, ConfigProvider, Input, Spin, theme } from 'antd';
import { FiSearch, FiRefreshCw } from 'react-icons/fi';
import { GridItemList } from '../../components/Lists/list';
import { useAppDispatch, useAppSelector } from '../../store/store';
import { yourLibraryActions } from '../../store/slices/yourLibrary';

export default function FollowedArtists() {
  const dispatch = useAppDispatch();
  const { myArtists, artistsStatus, artistsError } = useAppSelector((state) => state.yourLibrary);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (artistsStatus === 'idle') dispatch(yourLibraryActions.fetchMyArtists());
  }, [dispatch, artistsStatus]);
  const artists = useMemo(() => myArtists.filter((artist) =>
    artist.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  ).sort((a, b) => a.name.localeCompare(b.name)), [myArtists, search]);
  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#1ed760' } }}><section className="followed-artists-page">
    <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>Followed artists</h1>
    <p style={{ color: '#b3b3b3', marginBottom: 20 }}>Your followed artists are synced from your Spotify account.</p>
    <div className="followed-artists-toolbar">
      <Input className="followed-artists-search" size="large" prefix={<FiSearch aria-hidden="true" />} aria-label="Search followed artists" placeholder="Search followed artists"
        value={search} onChange={(event) => setSearch(event.target.value)} allowClear />
      <Button className="followed-artists-refresh" size="large" icon={<FiRefreshCw aria-hidden="true" />} loading={artistsStatus === 'loading'} onClick={() => dispatch(yourLibraryActions.fetchMyArtists())}>Refresh from Spotify</Button>
      <span className="followed-artists-count">{search.trim() ? `${artists.length} of ` : ''}{myArtists.length} artists</span>
    </div>
    {artistsStatus === 'loading' ? <div><Spin /><p>Loading your followed artists…</p></div> : null}
    {artistsError ? <Alert type="error" showIcon message="Unable to sync artists" description={artistsError} /> : null}
    {artistsStatus === 'loaded' && !artists.length ? <p>{search ? 'No artists match your search.' : 'Follow an artist on Spotify, then refresh this page.'}</p> : null}
    <GridItemList items={artists} multipleRows />
  </section></ConfigProvider>;
}
