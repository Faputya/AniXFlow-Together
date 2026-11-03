'use strict';
/**
 * AniXFlow Watch Together — сервер комнат.
 * Запуск:  node server.js      (порт из переменной PORT, по умолчанию 8787)
 * Зависимостей нет, нужен только Node.js 18+.
 */

const http = require('node:http');
const { Hub } = require('./room');
const { handleUpgrade } = require('./ws');

const MAX_CONN_PER_IP = 20;
const WS_PING_MS = 25000;
const WS_DEAD_MS = 70000;

function createServer({ hub = new Hub(), log = () => {} } = {}) {
  let nextId = 1;
  const perIp = new Map();

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      const body = JSON.stringify({ ok: true, name: 'anixflow-sync', ...hub.stats() });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*', // клиент «будит» спящий хостинг запросом на /health
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || socket.remoteAddress || 'unknown';
    const count = perIp.get(ip) || 0;
    if (count >= MAX_CONN_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ws = handleUpgrade(req, socket, nextId++);
    if (!ws) return;
    perIp.set(ip, count + 1);

    hub.onConnect(ws);
    ws.onmessage = (text) => {
      try {
        hub.onMessage(ws, text);
      } catch (e) {
        log('handler error', e);
      }
    };
    ws.onclose = () => {
      perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
      try { hub.onClose(ws); } catch (e) { log('close error', e); }
    };
  });

  const timers = [];
  timers.push(setInterval(() => {
    try { hub.tick(); } catch (e) { log('tick error', e); }
  }, 1000));
  timers.push(setInterval(() => {
    const now = Date.now();
    for (const ws of hub.conns) {
      if (ws.closed) continue;
      if (now - ws.lastPong > WS_DEAD_MS) { ws.close(1001); continue; }
      ws.ping();
    }
  }, WS_PING_MS));
  timers.forEach((t) => t.unref());

  server.stopTimers = () => timers.forEach(clearInterval);
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  const server = createServer({ log: (...a) => console.error('[sync]', ...a) });
  server.listen(port, '0.0.0.0', () => {
    console.log(`AniXFlow sync server слушает порт ${port}`);
  });
  const stop = () => { server.stopTimers(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
