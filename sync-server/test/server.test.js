'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createServer } = require('../server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
    }
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    ws,
    opened,
    send: (o) => ws.send(JSON.stringify(o)),
    next: (pred, ms = 2000) => {
      const found = inbox.find(pred);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout waiting for message')), ms).unref();
      });
    },
    close: () => ws.close(),
  };
}

test('сквозной сценарий по настоящим WebSocket-соединениям', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => { server.stopTimers(); server.close(); });

  // HTTP health
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);

  const host = client(port);
  const guest = client(port);
  await Promise.all([host.opened, guest.opened]);

  host.send({ t: 'ping', c: 1 });
  const pong = await host.next((m) => m.t === 'pong');
  assert.equal(pong.c, 1);
  assert.ok(Math.abs(pong.s - Date.now()) < 2000);

  host.send({ t: 'create', cid: 'host-client-0001', name: 'Хост' });
  const w1 = await host.next((m) => m.t === 'welcome');
  guest.send({ t: 'join', cid: 'guest-client-0001', code: w1.code.toLowerCase(), name: 'Гость' });
  const w2 = await guest.next((m) => m.t === 'welcome');
  assert.equal(w2.code, w1.code);
  assert.equal(w2.members.length, 2);

  guest.send({ t: 'ready', ready: true, seq: 0 });
  await host.next((m) => m.t === 'members' && m.members.every((x) => x.status === 'synced'));

  host.send({ t: 'play', pos: 12.5, ts: Date.now() });
  const st = await guest.next((m) => m.t === 'state' && m.reason === 'play');
  assert.equal(st.playing, true);
  assert.equal(st.pos, 12.5);

  // юникод и длинное сообщение (>125 байт, расширенная длина фрейма)
  host.send({ t: 'media', media: { releaseId: 1, episodePos: 1, title: 'Тётя Ёжик '.repeat(10), episodeName: 'Серия 1' } });
  const media = await guest.next((m) => m.t === 'state' && m.reason === 'media');
  assert.ok(media.media.title.startsWith('Тётя Ёжик'));

  host.close();
  await guest.next((m) => m.t === 'members' && m.members.some((x) => !x.connected));
  guest.close();
});

test('слишком большое сообщение закрывает соединение, сервер жив', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => { server.stopTimers(); server.close(); });

  const c = client(port);
  await c.opened;
  const closed = new Promise((resolve) => { c.ws.onclose = (e) => resolve(e.code); });
  c.ws.send('x'.repeat(40_000));
  const code = await closed;
  assert.ok(code === 1009 || code === 1006, 'код закрытия: ' + code);

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
});

test('обычный HTTP-запрос к /ws без Upgrade и мусор в сокет не роняют сервер', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => { server.stopTimers(); server.close(); });

  const res = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res.status, 404);

  await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('data', () => {});
    s.on('close', resolve);
    s.on('error', resolve);
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
});
