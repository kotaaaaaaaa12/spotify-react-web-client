import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Chrome's debug port is bound to loopback, never exposed by the Worker.
export class ChromeControl {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.closed = false;
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data); const task = this.pending.get(message.id);
        if (!task) return; clearTimeout(task.timer); this.pending.delete(message.id);
        if (message.error) task.reject(new Error('Chrome command failed.')); else task.resolve(message.result);
      } catch { /* Unsolicited browser events are not diagnostics. */ }
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close());
  }
  static async connect(profile, active) {
    let port;
    for (let i = 0; i < 200 && active(); i++) {
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port > 0 && port <= 65535) break; } catch { /* Chrome is starting. */ }
      await wait(100);
    }
    if (!active() || !port) throw new Error('Chrome did not start.');
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json(); const endpoint = new URL(data.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.port !== String(port)) throw new Error('Invalid Chrome endpoint.');
    const socket = new WebSocket(endpoint.href);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome did not connect.')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome did not connect.')); }, { once: true });
    });
    const control = new ChromeControl(socket);
    control.version = /^Chrome\/\d+(?:\.\d+){0,3}$/.test(data.Browser || '') ? data.Browser : undefined;
    return control;
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Chrome connection closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Chrome command timed out.')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId; await this.send('Runtime.enable', {}, sessionId);
  }
  async report() {
    const result = await this.send('Runtime.evaluate', { expression: 'window.__cloudPlayerReport || null', returnByValue: true }, this.sessionId);
    return result.result?.value;
  }
  activate() {
    return this.send('Runtime.evaluate', { expression: 'window.__activateCloudPlayer?.()', userGesture: true, awaitPromise: true }, this.sessionId);
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('Chrome connection closed.')); }
    this.pending.clear(); try { this.socket.close(); } catch { /* Already closed. */ }
  }
}
