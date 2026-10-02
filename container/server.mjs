import { createServer } from 'node:http';
import { ServerPlayer } from './player.mjs';

export function createPlayerServer(player = new ServerPlayer()) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    const path = new URL(request.url, 'http://container').pathname;
    try {
      if (path === '/healthz' && request.method === 'GET') return json({ ok: true });
      if (path === '/status' && request.method === 'GET') return json(player.status());
      if (path === '/start' && request.method === 'POST') {
        let size = 0; const parts = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16384) return json({ error: 'Request is too large.' }, 413);
          parts.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(parts).toString()); } catch { return json({ error: 'Invalid request.' }, 400); }
        return json(await player.start(input));
      }
      if (path === '/stream' && request.method === 'GET') {
        if (!player.attach(response)) return json({ error: 'Start the server player before enabling audio.' }, 409);
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'none' }); response.flushHeaders();
        return;
      }
      return json({ error: 'Not found.' }, 404);
    } catch { return json({ error: 'The player could not process the request.' }, 400); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const player = new ServerPlayer(); const server = createPlayerServer(player);
  server.listen(8080, '0.0.0.0', () => console.log('Server player is listening on port 8080.'));
  const shutdown = async () => { await player.dispose(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
}
