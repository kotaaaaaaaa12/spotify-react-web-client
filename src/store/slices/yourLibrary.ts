import { createAsyncThunk, createSelector, createSlice, PayloadAction } from '@reduxjs/toolkit';

// Services
import { collectLibraryPages } from '../../services/libraryPagination';
import { userService } from '../../services/users';
import { albumsService } from '../../services/albums';
import { playlistService } from '../../services/playlists';

// Interfaces
import type { RootState } from '../store';
import type { Album } from '../../interfaces/albums';
import type { Artist } from '../../interfaces/artist';
import type { Playlist } from '../../interfaces/playlists';
import { LIKED_SONGS_IMAGE } from '../../constants/spotify';

export interface YourLibraryState {
  myAlbums: Album[];
  myArtists: Artist[];
  artistsStatus: 'idle' | 'loading' | 'loaded' | 'error';
  artistsError?: string;
  myPlaylists: Playlist[];

  search: string;
  view: 'GRID' | 'LIST' | 'COMPACT';
  orderBy: 'name' | 'added_at' | 'default';
  filter: 'ALL' | 'ALBUMS' | 'ARTISTS' | 'PLAYLISTS';
}

const initialState: YourLibraryState = {
  search: '',
  myAlbums: [],
  view: 'LIST',
  filter: 'ALL',
  myArtists: [],
  artistsStatus: 'idle',
  myPlaylists: [],
  orderBy: 'default',
};

export const fetchMyPlaylists = createAsyncThunk('yourLibrary/fetchMyPlaylists', async () => {
  return collectLibraryPages(async (params) => {
    const response = await playlistService.getMyPlaylists(params);
    return response.data;
  }, 'offset');
});

export const fetchMyAlbums = createAsyncThunk('yourLibrary/fetchMyAlbums', async () => {
  return collectLibraryPages(async (params) => {
    const response = await albumsService.fetchSavedAlbums(params);
    return { items: response.data.items.map((item) => item.album), next: response.data.next };
  }, 'offset');
});

export const fetchMyArtists = createAsyncThunk('yourLibrary/fetchMyArtists', async () => {
  return collectLibraryPages(async (params) => {
    const response = await userService.fetchFollowedArtists(params);
    return response.data.artists;
  }, 'after');
}, {
  condition: (_, { getState }) => (getState() as RootState).yourLibrary.artistsStatus !== 'loading',
});

const yourLibrarySlice = createSlice({
  name: 'yourLibrary',
  initialState,
  reducers: {
    setFilter(state, action: PayloadAction<{ filter: YourLibraryState['filter'] }>) {
      state.filter = action.payload.filter;
    },
    setSearch(state, action: PayloadAction<{ search: string }>) {
      state.search = action.payload.search;
    },
    setView(state, action: PayloadAction<{ view: YourLibraryState['view'] }>) {
      state.view = action.payload.view;
    },
    setOrderBy(state, action: PayloadAction<{ orderBy: YourLibraryState['orderBy'] }>) {
      state.orderBy = action.payload.orderBy;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchMyPlaylists.fulfilled, (state, action) => {
      state.myPlaylists = action.payload;
    });
    builder.addCase(fetchMyAlbums.fulfilled, (state, action) => {
      state.myAlbums = action.payload;
    });
    builder.addCase(fetchMyArtists.pending, (state) => {
      state.artistsStatus = 'loading';
      state.artistsError = undefined;
    });
    builder.addCase(fetchMyArtists.rejected, (state, action) => {
      state.artistsStatus = 'error';
      state.artistsError = action.error.message || 'Unable to load artists.';
    });
    builder.addCase(fetchMyArtists.fulfilled, (state, action) => {
      state.myArtists = action.payload;
      state.artistsStatus = 'loaded';
    });
  },
});

export const getLibraryItems = createSelector(
  [
    (state: RootState) => state.auth.user,
    (state: RootState) => state.yourLibrary.filter,
    (state: RootState) => state.yourLibrary.myAlbums,
    (state: RootState) => state.yourLibrary.myArtists,
    (state: RootState) => state.yourLibrary.myPlaylists,
    (state: RootState) => state.yourLibrary.search,
  ],
  (user, filter, myAlbums, myArtists, myPlaylists, search) => {
    const matchesSearch = (item: { name?: string }) =>
      !search.trim() || item.name?.toLowerCase().includes(search.trim().toLowerCase());

    if (filter === 'ALBUMS') return myAlbums.filter(matchesSearch);
    if (filter === 'ARTISTS') return myArtists.filter(matchesSearch);
    if (filter === 'PLAYLISTS') return myPlaylists.filter(matchesSearch);

    if (!user) return [];
    if (!myAlbums.length && !myArtists.length && !myPlaylists.length) return [];

    const likedSongs: Playlist = {
      id: 'liked-songs',
      name: 'Liked Songs',
      snapshot_id: '',
      collaborative: false,
      public: false,
      description: '',
      href: '',
      type: 'playlist',
      tracks: { href: '', total: 0 },
      external_urls: { spotify: '' },
      followers: { href: '', total: 0 },
      uri: `spotify:user:${user?.id}:collection`,
      images: [{ url: LIKED_SONGS_IMAGE, width: 300, height: 300 }],
      owner: user!,
    };

    return [
      myPlaylists.slice(0, 3),
      likedSongs,
      myAlbums.slice(0, 2),
      myPlaylists.slice(3, 6),
      myArtists.slice(0, 1),
      myAlbums.slice(2, 5),
      myArtists.slice(1, 2),
      myPlaylists.slice(6, 10),
      myAlbums.slice(5, 9),
      myArtists.slice(2, 6),
      myPlaylists.slice(10, 15),
      myAlbums.slice(9, 13),
      myArtists.slice(6, 10),
      myPlaylists.slice(15, 20),
      myAlbums.slice(13, 17),
      myArtists.slice(10, 14),
      myPlaylists.slice(20, 25),
      myAlbums.slice(17, 21),
      myArtists.slice(14, 18),
      myPlaylists.slice(25, 30),
      myAlbums.slice(21, 25),
      myArtists.slice(18, 22),
      myPlaylists.slice(30, 35),
      myAlbums.slice(25, 43),
      // all the rest
      myPlaylists.slice(35),
      myArtists.slice(22),
      myAlbums.slice(43),
    ]
      .filter((r) => r)
      .flat()
      .filter(matchesSearch);
  }
);

export const getUserPlaylists = createSelector(
  [(state: RootState) => state.yourLibrary.myPlaylists, (state: RootState) => state.auth.user],
  (playlists, user) => {
    return playlists.filter((playlist) => playlist.owner?.id === user?.id);
  }
);

export const yourLibraryActions = {
  fetchMyAlbums,
  fetchMyArtists,
  fetchMyPlaylists,
  ...yourLibrarySlice.actions,
};

export default yourLibrarySlice.reducer;
