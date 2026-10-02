import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Spin } from 'antd';
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
  return <section style={{ padding: '28px 20px', color: '#f5f5f5' }}>
    <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>Followed artists</h1>
    <p style={{ color: '#b3b3b3', marginBottom: 20 }}>Your followed artists are synced from your Spotify account.</p>
    <Space wrap style={{ marginBottom: 20 }}>
      <Input aria-label="Search followed artists" placeholder="Search followed artists"
        value={search} onChange={(event) => setSearch(event.target.value)} allowClear />
      <Button loading={artistsStatus === 'loading'} onClick={() => dispatch(yourLibraryActions.fetchMyArtists())}>Refresh from Spotify</Button>
      <span>{myArtists.length} artists</span>
    </Space>
    {artistsStatus === 'loading' ? <div><Spin /><p>Loading your followed artists…</p></div> : null}
    {artistsError ? <Alert type="error" showIcon message="Unable to sync artists" description={artistsError} /> : null}
    {artistsStatus === 'loaded' && !artists.length ? <p>{search ? 'No artists match your search.' : 'Follow an artist on Spotify, then refresh this page.'}</p> : null}
    <GridItemList items={artists} multipleRows />
  </section>;
}
