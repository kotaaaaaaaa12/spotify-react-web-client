import Axios from 'axios';
import { getRefreshToken } from './utils/spotify/login';
import { getFromLocalStorageWithExpiry } from './utils/localstorage';
import { cacheGet, cacheSet } from './utils/cache';
import { PAIR_MODE } from './utils/spotify/pairing';

const path = 'https://api.spotify.com/v1' as const;

const access_token = getFromLocalStorageWithExpiry('access_token') as string;

const axios = Axios.create({
  baseURL: path,
  headers: {},
});

if (access_token) {
  axios.defaults.headers.common['Authorization'] = 'Bearer ' + access_token;
}

// --- Global concurrency limiter --------------------------------------------------------------
// Several screens (Home, Artist) fan out many requests at once, and dev StrictMode doubles
// them. Spotify's tightened Feb-2026 rate limits 429 on those bursts. Cap how many requests are
// in flight at once so traffic is smoothed instead of bursted; the rest queue and drain as
// slots free up. Combined with the 429 backoff below, this keeps the app under the limit.
const MAX_CONCURRENT = 3;
let activeRequests = 0;
const waiters: Array<() => void> = [];

const acquireSlot = () =>
  new Promise<void>((resolve) => {
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++;
      resolve();
    } else {
      waiters.push(() => {
        activeRequests++;
        resolve();
      });
    }
  });

const releaseSlot = () => {
  activeRequests = Math.max(0, activeRequests - 1);
  waiters.shift()?.();
};

// --- IndexedDB response cache ----------------------------------------------------------------
// Catalog data (artists/albums/tracks) is immutable, so cache GETs of it in IndexedDB and serve
// from there on repeat views and across reloads. This is the real fix for the rate limiting:
// navigating back to a page, or hard-refreshing, no longer re-hits the network. Only static
// catalog GETs are cached — user state (/me/*), search, and all mutations always hit the API.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // catalog is static; 24h is safe
const CACHEABLE_PATH = /^\/(artists|albums|tracks)(\/|$)/;

const isCacheableGet = (config: any) =>
  (config.method || 'get').toLowerCase() === 'get' && CACHEABLE_PATH.test(config.url || '');

const cacheKeyFor = (config: any) =>
  `${config.url}?${JSON.stringify(config.params || {})}`;

axios.interceptors.request.use(async (config) => {
  const token = getFromLocalStorageWithExpiry('access_token') || await getRefreshToken();
  if (!token) throw new Error('Sign in with Spotify to browse your music.');
  if (localStorage.getItem(PAIR_MODE)) {
    config.baseURL = '/api/spotify/v1';
    // Accept Spotify pagination URLs, but never let an absolute URL skip the relay.
    if (/^https?:\/\//.test(config.url || '')) {
      const target = new URL(config.url!);
      if (target.origin !== 'https://api.spotify.com' || !target.pathname.startsWith('/v1/')) throw new Error('Invalid Spotify API destination.');
      config.url = target.pathname.slice('/v1'.length) + target.search;
    }
    if (!config.url?.startsWith('/') || config.url.startsWith('//')) throw new Error('Invalid Spotify API path.');
    config.headers.delete('Authorization');
    config.headers.set('X-Spotify-Device', '1');
    config.withCredentials = true;
  } else {
    config.baseURL = path;
    config.headers.Authorization = `Bearer ${token}`;
    config.headers.delete('X-Spotify-Device');
    config.withCredentials = false;
  }
  await acquireSlot();
  (config as any).__hasSlot = true;

  if (isCacheableGet(config)) {
    const key = cacheKeyFor(config);
    const entry = await cacheGet(key);
    if (entry && entry.expiry > Date.now()) {
      // Cache hit — short-circuit the network by serving from a one-off adapter. The response
      // still flows through the response interceptor below (so the slot is released normally).
      (config as any).adapter = async () => ({
        data: entry.data,
        status: 200,
        statusText: 'OK (cache)',
        headers: {},
        config,
        request: {},
      });
    } else {
      // Mark for storing once the network response comes back.
      (config as any).__cacheKey = key;
    }
  }

  return config;
});

axios.interceptors.response.use(
  (response) => {
    if ((response.config as any).__hasSlot) { releaseSlot(); (response.config as any).__hasSlot = false; }

    const key = (response.config as any).__cacheKey;
    if (key && response.status === 200) {
      void cacheSet(key, { data: response.data, expiry: Date.now() + CACHE_TTL_MS });
    }
    return response;
  },
  async (error) => {
    // Release this attempt's slot first so a retry (and other queued requests) can proceed.
    if (error?.config?.__hasSlot) { releaseSlot(); error.config.__hasSlot = false; }

    const response = error?.response;
    const config = error?.config;

    // Network error / no response — nothing to recover from.
    if (!response || !config) {
      if (config && error.code !== 'ERR_CANCELED') {
        const method = (config.method || 'get').toUpperCase();
        const endpoint = (config.url || '').split('?')[0];
        const viaWorker = config.baseURL === '/api/spotify/v1';
        error.message = `${viaWorker ? 'Unable to reach this site’s Spotify API relay' : 'Unable to reach Spotify Web API'} (${method} ${endpoint}; no HTTP response). Check the connection and retry.`;
      }
      return Promise.reject(error);
    }

    if (response.status === 401 && !config.__authRetried) {
      config.__authRetried = true;
      const token = await getRefreshToken();
      if (!token) return Promise.reject(error);
      config.headers.Authorization = `Bearer ${token}`;
      return axios(config);
    }

    // 429 Too Many Requests: Spotify's tightened (Feb 2026) rate limits are easy to trip when
    // a page fires a burst of calls (and dev StrictMode doubles them). Back off for the
    // server-specified `Retry-After`, then retry — bounded so we never loop forever.
    if (response.status === 429) {
      config.__retryCount = (config.__retryCount || 0) + 1;
      // Only one retry: during a global cooldown, re-issuing many times just adds load and
      // prolongs the penalty window.
      if (config.__retryCount > 1) return Promise.reject(error);
      const retryAfter = Number(response.headers?.['retry-after']);
      const waitMs = Math.min((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000, 10000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 500)));
      return axios(config);
    }

    const message = response.data?.error?.message || (typeof response.data?.error === 'string' ? response.data.error : undefined);
    error.message = `Spotify Web API (HTTP ${response.status}, ${(config.method || 'get').toUpperCase()} ${(config.url || '').split('?')[0]}): ${message || 'The request failed.'}`;
    return Promise.reject(error);
  }
);

export default axios;
