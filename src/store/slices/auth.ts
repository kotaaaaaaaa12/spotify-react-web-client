import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import axios from '../../axios';
import login from '../../utils/spotify/login';
import { authService } from '../../services/auth';
import type { User } from '../../interfaces/user';

const initialState: {
  token?: string; playerLoaded: boolean; user?: User; requesting: boolean; error?: string;
} = { requesting: true, playerLoaded: false };

export const fetchUser = createAsyncThunk('auth/fetchUser', async () => {
  const response = await authService.fetchUser();
  return response.data;
});

export const initializeSpotifySession = createAsyncThunk('auth/initializeSession', async (_, thunkAPI) => {
  const [token] = await login.getToken();
  if (token) {
    axios.defaults.headers.common.Authorization = `Bearer ${token}`;
    await thunkAPI.dispatch(fetchUser()).unwrap();
  }
  return token || undefined;
});

export const loginToSpotify = createAsyncThunk('auth/loginToSpotify', async () => {
  await login.logInWithSpotify();
});

const authSlice = createSlice({
  name: 'auth', initialState,
  reducers: {
    setRequesting(state, action: PayloadAction<{ requesting: boolean }>) {
      state.requesting = action.payload.requesting;
    },
    setToken(state, action: PayloadAction<{ token?: string }>) { state.token = action.payload.token; },
    setPlayerLoaded(state, action: PayloadAction<{ playerLoaded: boolean }>) {
      state.playerLoaded = action.payload.playerLoaded;
    },
    clearError(state) { state.error = undefined; },
  },
  extraReducers: (builder) => {
    builder.addCase(initializeSpotifySession.fulfilled, (state, action) => {
      state.token = action.payload;
      state.requesting = false;
    });
    builder.addCase(initializeSpotifySession.rejected, (state, action) => {
      state.requesting = false;
      state.error = action.error.message || 'Spotify sign-in failed.';
    });
    builder.addCase(fetchUser.fulfilled, (state, action) => {
      state.user = action.payload;
      state.requesting = false;
    });
    builder.addCase(fetchUser.rejected, (state, action) => {
      state.requesting = false;
      state.error = action.error.message || 'Unable to load your Spotify account. Retry the connection.';
    });
    builder.addCase(loginToSpotify.rejected, (state, action) => {
      state.requesting = false;
      state.error = action.error.message;
    });
  },
});

export const authActions = { ...authSlice.actions, loginToSpotify, fetchUser, initializeSpotifySession };
export default authSlice.reducer;
