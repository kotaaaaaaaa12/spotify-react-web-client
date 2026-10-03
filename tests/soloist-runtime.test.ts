import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

describe('Soloist pairing across Workers RPC and durable storage', () => {
  it('stores a private key, pairs only the linked account, seals credentials, and restores after stop', async () => {
    const fakeContainer = `import {DurableObject} from 'cloudflare:workers';
      export class Container extends DurableObject {
        constructor(ctx,env){super(ctx,env);this.container={running:false};this.phase='idle';}
        async destroy(){this.container.running=false;}
        async fetch(request){const path=new URL(request.url).pathname;
          if(path==='/start'){this.launch=await request.json();this.container.running=true;this.phase=this.launch.checkpoint?'waiting_for_playback':'waiting_for_pairing';return Response.json(this.report());}
          if(path==='/stop'){this.phase='stopped';return Response.json({checkpoint:this.paired?'c2Vzc2lvbi1jcmVkZW50aWFscw==':null});}
          if(path==='/zeroconf/getInfo')return Response.json({status:101,remoteName:this.launch.name,deviceID:'cloud-device-id',publicKey:'public-key',tokenType:'accesstoken',clientID:'native-client',scope:'streaming'});
          if(path==='/zeroconf/addUser'){this.paired=true;this.phase='waiting_for_playback';return Response.json({status:101});}
          return Response.json(this.report());
        }
        report(){return {backend:'soloist',phase:this.phase,authentication:this.phase==='waiting_for_playback'?'accepted':'pending',discovery:'accepted',playerRevision:'soloist-cloud-1',pcmBytes:0,audioBytes:0};}
      }`;
    const bundle = await build({ entryPoints: ['cloudflare/container-worker.mjs'], absWorkingDir: process.cwd(), bundle: true,
      format: 'esm', platform: 'browser', write: false, external: ['cloudflare:workers'],
      plugins: [{ name: 'fake-container-runtime', setup(builder) {
        builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'fake-container', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: fakeContainer, loader: 'js' }));
      } }], });
    const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'soloist-cloud-runtime', modules: true, compatibilityDate: '2026-10-02',
      script: bundle.outputFiles[0].text, bindings: { SPOTIFY_CLIENT_ID: 'a'.repeat(32) },
      durableObjects: { PAIR_SESSIONS: { className: 'PairingSession', useSQLite: true }, SERVER_PLAYERS: { className: 'SpotifyPlayerContainer', useSQLite: true } },
      outboundService: async request => {
        if (request.url === 'https://accounts.spotify.com/api/token') return Response.json({ access_token: 'private-account-token', refresh_token: 'private-refresh', expires_in: 3600 });
        expect(request.url).toBe('https://api.spotify.com/v1/me'); return Response.json({ id: 'linked-user' });
      },
    }));
    const origin = 'https://music.example.com'; let cookie = '';
    const call = (path: string, method = 'GET', body?: object, extra: Record<string, string> = {}) => runtime.dispatchFetch(origin + path, {
      method, headers: { Cookie: cookie, ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    try {
      expect((await call('/api/soloist/settings')).status).toBe(401);
      const create = await call('/api/pair/new', 'POST'); cookie = create.headers.get('Set-Cookie')!.split(';')[0];
      const id = new URL((await create.json() as any).link).searchParams.get('id');
      const phone = await call(`/api/pair/authorize?id=${id}`, 'POST');
      const state = new URL((await phone.json() as any).url).searchParams.get('state');
      await runtime.dispatchFetch(origin + `/?code=code&state=${state}`, { headers: { Cookie: phone.headers.get('Set-Cookie')!.split(';')[0] } });
      expect(await (await call('/api/server/start', 'POST')).json()).toMatchObject({ backend: 'soloist', phase: 'setup_required' });
      const key = 'private-soloist-key';
      const denied = await call('/api/soloist/settings', 'POST', { apiKey: key }, { Origin: 'https://other.example.com' }); expect(denied.status).toBe(403);
      const configured = await call('/api/soloist/settings', 'POST', { apiKey: key }); expect(configured.status).toBe(200);
      expect(await configured.json()).toEqual({ backend: 'soloist', keyConfigured: true, sessionStored: false });
      const started = await (await call('/api/server/start', 'POST')).json() as any;
      expect(started).toMatchObject({ version: 4, backend: 'soloist', phase: 'waiting_for_pairing', keyConfigured: true });
      expect(JSON.stringify(started)).not.toContain(key);
      const issued = await (await call('/api/soloist/bridge/new', 'POST')).json() as any;
      const link = new URL(issued.link), secret = new URLSearchParams(link.hash.slice(1)).get('token')!;
      expect(link.search).toBe(''); expect(link.pathname).toBe('/cloud-pair');
      const bridge = (method = 'GET', username = 'linked-user') => runtime.dispatchFetch(origin + `/api/soloist/bridge?id=${id}`, {
        method, headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: method === 'POST' ? new URLSearchParams({ action: 'addUser', userName: username, blob: 'private-received-blob', clientKey: '', tokenType: 'accesstoken' }).toString() : undefined,
      });
      expect((await bridge()).status).toBe(200); // Response objects survive actual DO RPC.
      expect(await (await bridge('POST', 'other-user')).json()).toMatchObject({ status: 202 });
      expect(await (await bridge('POST')).json()).toMatchObject({ status: 101 });
      expect((await bridge()).status).toBe(401);
      const restored = await (await call('/api/server/status')).json() as any;
      expect(restored).toMatchObject({ authentication: 'accepted', sessionStored: true });
      expect(JSON.stringify(restored)).not.toMatch(/private-|c2Vzc2lvbi/);
      await call('/api/server/stop', 'POST');
      expect(await (await call('/api/server/start', 'POST')).json()).toMatchObject({ phase: 'waiting_for_playback', sessionStored: true, authentication: 'accepted' });
      await call('/api/pair/logout', 'POST');
      expect((await bridge()).status).toBe(401);
      expect((await call('/api/soloist/settings')).status).toBe(410);
    } finally { await runtime.dispose(); }
  }, 20000);
});
