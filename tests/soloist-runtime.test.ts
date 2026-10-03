import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Retain the previous overlay's filename so applying this overlay updates it.
describe('Cloud Chrome across Workers RPC and durable storage', () => {
  it('reuses QR OAuth, rotates only private tokens, isolates sessions, and reconnects without native pairing', async () => {
    const fakeContainer = `import {DurableObject} from 'cloudflare:workers';
      export class Container extends DurableObject {
        constructor(ctx,env){super(ctx,env);this.container={running:false};this.phase='idle';this.launches=0;}
        async destroy(){this.container.running=false;}
        deleteSchedules(){this.callback=null;}
        async schedule(when,callback){this.callback=callback;await this.ctx.storage.setAlarm(when);}
        async alarm(){if(this.callback)await this[this.callback]();}
        async fetch(request){const path=new URL(request.url).pathname;
          if(path==='/start'){this.launch=await request.json();this.latestToken=this.launch.accessToken;this.launches++;this.container.running=true;this.phase='waiting_for_playback';return Response.json(this.report());}
          if(path==='/token'){this.latestToken=(await request.json()).accessToken;return Response.json({ok:true});}
          if(path==='/stop'){this.phase='stopped';return Response.json({checkpoint:null});}
          return Response.json(this.report());
        }
        async testInspect(){return {latestToken:this.latestToken,launch:this.launch,launches:this.launches,records:[...await this.ctx.storage.list()]};}
        async testScheduleAlarm(){await this.ctx.storage.setAlarm(Date.now()+100);}
        report(){return {backend:'cloud-browser',phase:this.phase,authentication:'accepted',audio:'pending',deviceId:'registered-cloud-device',authenticationMode:'oauth',playerRevision:'chrome-cloud-1',pcmBytes:0,audioBytes:0,
          accessToken:this.latestToken,diagnostics:{revision:'chrome-diagnostics-1',drm:'accepted',sdk:'ready',chromeVersion:'Chrome/140.0.0.0',token:this.latestToken,events:[]}};}
      }`;
    const bundle = await build({ entryPoints: ['cloudflare/container-worker.mjs'], absWorkingDir: process.cwd(), bundle: true,
      format: 'esm', platform: 'browser', write: false, external: ['cloudflare:workers'],
      plugins: [{ name: 'fake-container-runtime', setup(builder) {
        builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'fake-container', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: fakeContainer, loader: 'js' }));
      } }], });
    let tokenNumber = 0;
    const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'chrome-cloud-runtime', modules: true, compatibilityDate: '2026-10-02',
      script: bundle.outputFiles[0].text, bindings: { SPOTIFY_CLIENT_ID: 'a'.repeat(32) },
      durableObjects: { PAIR_SESSIONS: { className: 'PairingSession', useSQLite: true }, SERVER_PLAYERS: { className: 'SpotifyPlayerContainer', useSQLite: true } },
      outboundService: async request => {
        if (request.url === 'https://accounts.spotify.com/api/token') return Response.json({ access_token: `private-account-token-${++tokenNumber}`, refresh_token: 'private-refresh', expires_in: 61 });
        expect(request.url).toBe('https://api.spotify.com/v1/me'); return Response.json({ id: 'linked-user', product: 'premium' });
      },
    }));
    const origin = 'https://music.example.com'; let cookie = '';
    const call = (path: string, method = 'GET', extra: Record<string, string> = {}) => runtime.dispatchFetch(origin + path, {
      method, headers: { Cookie: cookie, ...(method === 'POST' ? { Origin: origin } : {}), ...extra },
    });
    const connect = async () => {
      const create = await call('/api/pair/new', 'POST'); cookie = create.headers.get('Set-Cookie')!.split(';')[0];
      const id = new URL((await create.json() as any).link).searchParams.get('id')!;
      const phone = await call(`/api/pair/authorize?id=${id}`, 'POST'); const state = new URL((await phone.json() as any).url).searchParams.get('state');
      await runtime.dispatchFetch(origin + `/?code=code&state=${state}`, { headers: { Cookie: phone.headers.get('Set-Cookie')!.split(';')[0] } });
      return id;
    };
    try {
      expect((await call('/api/server/start', 'POST')).status).toBe(401);
      const id = await connect();
      expect((await call('/api/pair/player_session', 'POST')).status).toBe(404);
      expect((await call('/api/server/token', 'POST')).status).toBe(404);
      expect((await call('/api/server/start', 'POST', { Origin: 'https://other.example.com' })).status).toBe(403);
      const started = await (await call('/api/server/start', 'POST', { Authorization: 'Bearer attacker' })).json() as any;
      expect(started).toMatchObject({ version: 5, backend: 'cloud-browser', phase: 'waiting_for_playback', authentication: 'accepted',
        deviceId: 'registered-cloud-device', diagnostics: { drm: 'accepted', sdk: 'ready' } });
      expect(JSON.stringify(started)).not.toMatch(/private-|attacker/);
      const namespace = await runtime.getDurableObjectNamespace('SERVER_PLAYERS');
      const stub: any = namespace.get(namespace.idFromName(`spotify-player-v1:${id}`));
      const before = await stub.testInspect();
      expect(before.launch).toMatchObject({ engine: 'browser', accessToken: 'private-account-token-1', expectedUsername: 'linked-user' });
      expect(JSON.stringify(before.records)).not.toMatch(/private-|attacker/);
      expect(before.launch).not.toHaveProperty('refreshToken');
      // Real DO alarm dispatch uses the private session operation, without a browser poll.
      await new Promise(resolve => setTimeout(resolve, 1150)); await stub.testScheduleAlarm();
      let rotated: any;
      for (let i = 0; i < 30; i++) { rotated = await stub.testInspect(); if (rotated.latestToken !== before.latestToken) break; await new Promise(resolve => setTimeout(resolve, 100)); }
      expect(rotated.latestToken).not.toBe(before.latestToken); expect(rotated.latestToken).toMatch(/^private-account-token-/);
      expect(JSON.stringify(rotated.records)).not.toContain('private-');
      const status = await (await call('/api/server/status')).json(); expect(JSON.stringify(status)).not.toContain('private-');
      await call('/api/server/stop', 'POST'); expect(await (await call('/api/server/status')).json()).toMatchObject({ phase: 'stopped', backend: 'cloud-browser' });
      expect(await (await call('/api/server/start', 'POST')).json()).toMatchObject({ authentication: 'accepted', phase: 'waiting_for_playback' });
      expect((await stub.testInspect()).launches).toBe(2);
      const ownerCookie = cookie; const otherId = await connect(); await call('/api/server/start', 'POST');
      const other: any = namespace.get(namespace.idFromName(`spotify-player-v1:${otherId}`));
      expect((await other.testInspect()).launches).toBe(1); cookie = ownerCookie;
      await call('/api/pair/logout', 'POST');
      expect((await stub.testInspect()).records).toEqual([]);
      expect((await call('/api/server/status')).status).toBe(410);
      expect((await other.testInspect()).launches).toBe(1);
    } finally { await runtime.dispose(); }
  }, 20000);
});
