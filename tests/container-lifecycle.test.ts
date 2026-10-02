import { describe, expect, it, vi } from 'vitest';
vi.mock('@cloudflare/containers', () => ({ Container: class {
  container: any;
  constructor(ctx: any) { this.container = ctx.container; }
  async destroy() { await this.container.destroy(); }
  async fetch(request: Request) { return this.container.fetch(request); }
} }));
import { SpotifyPlayerContainer } from '../cloudflare/container-worker.mjs';
describe('Container lifecycle', () => {
  it('does not start or destroy a cold player just to stop or sign out', async () => {
    const runtime = { running: false, destroy: vi.fn() };
    const container = new SpotifyPlayerContainer({ container: runtime } as any);
    await container.stopPlayer(); expect(runtime.destroy).not.toHaveBeenCalled();
    expect(container.defaultPort).toBe(8080); expect(container.sleepAfter).toBe('10m');
  });
  it('destroys a running player and exposes failure so the authenticated owner can retry', async () => {
    const runtime = { running: true, destroy: vi.fn(async () => {}) };
    const container = new SpotifyPlayerContainer({ container: runtime } as any);
    await container.stopPlayer(); expect(runtime.destroy).toHaveBeenCalledOnce();
    runtime.destroy.mockRejectedValueOnce(Error('Platform failure'));
    await expect(container.stopPlayer()).rejects.toThrow('Platform failure');
  });
  it('waits for an in-flight startup before destroying the runtime', async () => {
    let finishStartup: (() => void) | undefined;
    const runtime = { running: false, destroy: vi.fn(), fetch: vi.fn(() => new Promise<Response>(resolve => {
      finishStartup = () => { runtime.running = true; resolve(new Response('ready')); };
    })) };
    const container = new SpotifyPlayerContainer({ container: runtime } as any);
    const starting = container.fetch(new Request('http://container/start'));
    await Promise.resolve(); const stopping = container.stopPlayer();
    expect(runtime.destroy).not.toHaveBeenCalled(); finishStartup!();
    await starting; await stopping; expect(runtime.destroy).toHaveBeenCalledOnce();
  });
});
