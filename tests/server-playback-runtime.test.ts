import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

describe('server startup in the Workers runtime', () => {
  it('verifies the account and reaches the Container without unsupported redirect options', async () => {
    const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'runtime-startup.mjs', contents: `
      import { handleServerPlayback } from './cloudflare/server-playback.mjs';
      export default { async fetch(request) {
        if (new URL(request.url).searchParams.has('negative_control')) {
          try { await fetch('https://api.spotify.com/v1/me', {redirect:'error'}); return Response.json({unexpected:true}); }
          catch (error) { return Response.json({name:error.name,message:error.message}); }
        }
        let containerCalls=0, input, placement;
        const env={PAIR_SESSIONS:{idFromName:id=>id,get:()=>({fetch:async()=>Response.json({status:'ready',access_token:'private-runtime-token'})})},
          SERVER_PLAYERS:{idFromName:id=>id,get:(id,options)=>{placement=options.locationHint;return {fetch:async request=>{
            containerCalls++; input=await request.json();return Response.json({phase:'waiting_for_pairing',authentication:'pending',playerRevision:'native-device-auth-1',authenticationMode:'device',pairing:{url:'https://spotify.com/pair?code=ABC123',code:'ABC123'}});
          }}}}};
        const response=await handleServerPlayback(request,env);
        return Response.json({status:response.status,report:await response.json(),containerCalls,input,placement});
      }};` }, bundle: true, format: 'esm', platform: 'browser', write: false });
    let upstreamMode = 'ok', upstreamCalls = 0;
    const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'server-startup-regression', modules: true,
      compatibilityDate: '2026-10-02', script: bundle.outputFiles[0].text,
      outboundService: async request => {
        upstreamCalls++;
        expect(request.url).toBe('https://api.spotify.com/v1/me');
        expect(request.headers.get('Authorization')).toBe('Bearer private-runtime-token');
        if (upstreamMode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } });
        if (upstreamMode === 'invalid') return new Response('unreadable-private-data');
        if (upstreamMode === 'rejected') return new Response('private-provider-body', { status: 401 });
        return Response.json({ id: 'expected-runtime-user' });
      },
    }));
    try {
      const control = await (await runtime.dispatchFetch('http://local/?negative_control=1')).json() as any;
      expect(control.name).toBe('TypeError'); expect(control.message).toContain('Invalid redirect value'); expect(upstreamCalls).toBe(0);
      const start = () => runtime.dispatchFetch('http://local/api/server/start', { method: 'POST', headers: { Origin: 'http://local', Cookie: `__Host-spotify-pair=${'a'.repeat(32)}.${'b'.repeat(64)}` } });
      const result = await (await start()).json() as any;
      expect(result).toMatchObject({ status: 200, containerCalls: 1, placement: 'apac', input: { expectedUsername: 'expected-runtime-user' }, report: { version: 3, pairing: { code: 'ABC123' } } });
      expect(result.input).not.toHaveProperty('accessToken'); expect(upstreamCalls).toBe(1);
      for (const [mode, code] of [['redirect', 'server_account_redirect'], ['invalid', 'server_account_request_failed'], ['rejected', 'server_account_rejected']]) {
        upstreamMode = mode;
        const failed = await (await start()).json() as any;
        expect(failed.containerCalls).toBe(0); expect(failed.report).toMatchObject({ phase: 'failed', errorCode: code, startup: { revision: 'server-startup-1', stage: 'account' } });
        expect(JSON.stringify(failed.report)).not.toMatch(/private-runtime-token|private-provider-body|unreadable-private-data|untrusted/);
      }
    } finally { await runtime.dispose(); }
  }, 20000);
});
