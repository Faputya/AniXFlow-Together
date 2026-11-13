'use strict';
/**
 * Режим «сервер на компьютере хоста + Radmin VPN / ZeroTier»:
 *  - мост WebSocket (ws:// через главный процесс) вместе с клиентом комнат;
 *  - менеджер локального сервера;
 *  - распознавание сетей и нормализация адресов.
 * Пропускается, если рядом нет исходников приложения.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../server');

const SRC = path.resolve(__dirname, '../../src');
const STORES = path.join(SRC, 'app/components/stores');
const HAVE_SRC = fs.existsSync(path.join(SRC, 'wsBridge.js'));
const T = HAVE_SRC ? test : test.skip;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000, label = 'условие') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return; await sleep(15); }
  throw new Error('не дождались: ' + label);
}
const memStorage = (preset) => {
  const m = new Map(Object.entries(preset || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

/** Имитация preload + ipcMain: интерфейс вызывает те же команды, что и в приложении. */
function makeBridge(wsBridge, opts = {}) {
  const handlers = {};
  const ipcMain = { on: (ch, fn) => { handlers[ch] = fn; } };
  const listeners = new Map();
  const sender = {
    id: opts.senderId ?? 1,
    send: (ch, msg) => { const fn = listeners.get(msg.id); if (fn) setImmediate(() => fn(msg)); },
    isDestroyed: () => false,
    once() {},
  };
  const event = { sender };
  const api = wsBridge.init({ ipcMain, isTrustedSender: opts.isTrustedSender || (() => true), WebSocketImpl: opts.WebSocketImpl });
  return {
    api,
    handlers,
    event,
    bridge: {
      open: (id, url, onEvent) => { listeners.set(id, onEvent); handlers['ws:open'](event, id, url); },
      send: (id, data) => handlers['ws:send'](event, id, data),
      close: (id, code) => handlers['ws:close'](event, id, code),
      release: (id) => listeners.delete(id),
    },
  };
}

T('ws:// через мост: комната, чат и синхронизация идут по тому же протоколу', async (t) => {
  const { SyncClient } = await import(path.join(STORES, 'watchTogether.js'));
  const { BridgeSocket } = await import(path.join(STORES, 'bridgeSocket.js'));
  const wsBridge = require(path.join(SRC, 'wsBridge.js'));

  const server = createServer();
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const { bridge } = makeBridge(wsBridge);
  globalThis.wsBridge = bridge; // так это выглядит в приложении: window.wsBridge из preload
  const clients = [];
  t.after(() => {
    clients.forEach((c) => { try { c.leave(); } catch (_) {} });
    delete globalThis.wsBridge;
    server.stopTimers(); server.close();
  });

  const url = `ws://127.0.0.1:${port}`;
  const mk = (name) => {
    const c = new SyncClient({
      fetch: null,
      storage: memStorage({ watchTogetherSettings: JSON.stringify({ serverUrl: url, name }) }),
    });
    clients.push(c);
    return c;
  };
  const host = mk('Хост');
  const guest = mk('Гость');

  await host.createRoom();
  assert.ok(host.ws instanceof BridgeSocket, 'для ws:// используется мост, а не встроенный WebSocket');
  assert.equal(host.snapshot.phase, 'connected');
  assert.match(host.snapshot.code, /^[A-HJKMNP-Z2-9]{8}$/);

  await guest.joinRoom(host.snapshot.code);
  assert.equal(guest.snapshot.members.length, 2);

  host.sendChat('привет по Radmin');
  await waitFor(() => guest.snapshot.chat.length === 1, 3000, 'чат дошёл');
  assert.equal(guest.snapshot.chat[0].text, 'привет по Radmin');

  const media = { releaseId: 5, episodePos: 1, title: 'Тест', dubberId: null, sourceId: null };
  host.sendMedia(media, 0, false);
  await waitFor(() => guest.snapshot.media?.releaseId === 5, 3000, 'серия дошла');
  assert.equal(guest.snapshot.media.dubberId, null, 'null не превратился в 0');

  // обрыв связи на мосту: клиент переподключается и остаётся в комнате
  guest.ws.close();
  await waitFor(() => guest.snapshot.phase === 'reconnecting', 3000, 'reconnecting');
  await waitFor(() => guest.snapshot.phase === 'connected', 8000, 'снова в комнате');
  assert.equal(guest.snapshot.members.length, 2);
  assert.ok(guest.snapshot.chat.length >= 1, 'история чата вернулась');
});

T('ws:// недоступен: понятное сообщение про сеть, брандмауэр и VPN', async (t) => {
  const { SyncClient } = await import(path.join(STORES, 'watchTogether.js'));
  const wsBridge = require(path.join(SRC, 'wsBridge.js'));
  const { bridge } = makeBridge(wsBridge);
  globalThis.wsBridge = bridge;
  t.after(() => { delete globalThis.wsBridge; });
  const c = new SyncClient({
    fetch: null,
    storage: memStorage({ watchTogetherSettings: JSON.stringify({ serverUrl: 'ws://127.0.0.1:1', name: 'x' }) }),
  });
  await assert.rejects(() => c.createRoom(), /Radmin|брандмауэр/);
  assert.equal(c.snapshot.phase, 'idle');
});

T('мост: неверный адрес, лимит соединений, чужой источник и лишние данные', async () => {
  const wsBridge = require(path.join(SRC, 'wsBridge.js'));
  const events = [];
  const created = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.l = {}; created.push(this); }
    addEventListener(n, fn) { this.l[n] = fn; }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; }
  }
  const handlers = {};
  const ipcMain = { on: (ch, fn) => { handlers[ch] = fn; } };
  const sender = { id: 7, send: (ch, m) => events.push(m), isDestroyed: () => false, once() {} };
  const ev = { sender };
  wsBridge.init({ ipcMain, isTrustedSender: () => true, WebSocketImpl: FakeWS });

  handlers['ws:open'](ev, 'a', 'file:///etc/passwd');
  assert.deepEqual(events.map((e) => e.type), ['error', 'close'], 'не-ws адреса отклоняются');
  assert.equal(created.length, 0);

  events.length = 0;
  for (let i = 0; i < wsBridge.MAX_SOCKETS_PER_WINDOW; i++) handlers['ws:open'](ev, 'c' + i, 'ws://10.0.0.1:8787');
  assert.equal(created.length, wsBridge.MAX_SOCKETS_PER_WINDOW);
  handlers['ws:open'](ev, 'extra', 'ws://10.0.0.1:8787');
  assert.equal(events.at(-1).type, 'close', 'сверх лимита — отказ');
  assert.equal(created.length, wsBridge.MAX_SOCKETS_PER_WINDOW);

  // отправка: только строки, только в открытое соединение, не больше лимита
  created[0].readyState = 1;
  handlers['ws:send'](ev, 'c0', '{"t":"ping"}');
  handlers['ws:send'](ev, 'c0', { evil: true });
  handlers['ws:send'](ev, 'c0', 'x'.repeat(wsBridge.MAX_MESSAGE + 1));
  assert.deepEqual(created[0].sent, ['{"t":"ping"}']);
  handlers['ws:send'](ev, 'c1', 'не открыто');
  assert.deepEqual(created[1].sent, []);

  // чужой источник: ничего не происходит
  const before = created.length;
  const handlers2 = {};
  wsBridge.init({ ipcMain: { on: (ch, fn) => { handlers2[ch] = fn; } }, isTrustedSender: () => false, WebSocketImpl: FakeWS });
  handlers2['ws:open']({ sender: { id: 9, send() {}, isDestroyed: () => false, once() {} } }, 'z', 'ws://10.0.0.1:1');
  assert.equal(created.length, before);
});

T('менеджер локального сервера: запуск, подключение, остановка, занятый порт', async () => {
  const { createManager } = require(path.join(SRC, 'localServer.js'));
  const fakeIfaces = () => ({ 'Radmin VPN': [{ family: 'IPv4', internal: false, address: '26.10.20.30' }] });
  const mgr = createManager({ createServer, interfaces: fakeIfaces });
  assert.equal(mgr.status().running, false);

  const st = await mgr.start(0);
  assert.equal(st.running, true);
  assert.ok(st.port > 0);
  assert.equal(st.addresses[0].url, `ws://26.10.20.30:${st.port}`);
  assert.equal(st.addresses[0].kind, 'Radmin VPN');

  const health = await fetch(`http://127.0.0.1:${st.port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);

  // повторный запуск ничего не ломает
  assert.equal((await mgr.start(0)).port, st.port);

  // занятый порт — понятная ошибка
  const mgr2 = createManager({ createServer, interfaces: fakeIfaces });
  await assert.rejects(() => mgr2.start(st.port), /уже занят/);

  // остановка закрывает и открытые соединения комнат
  const ws = new WebSocket(`ws://127.0.0.1:${st.port}`);
  await new Promise((r) => { ws.onopen = r; });
  const closed = new Promise((r) => { ws.onclose = r; });
  const t0 = Date.now();
  const stopped = await mgr.stop();
  assert.equal(stopped.running, false);
  await closed;
  assert.ok(Date.now() - t0 < 1500, 'остановка быстрая, без ожидания зависших соединений');
  await assert.rejects(() => fetch(`http://127.0.0.1:${st.port}/health`));
});

T('определение сети по адресу: Radmin, ZeroTier, Tailscale, локальная; виртуальные сети первыми', () => {
  const { listAddresses, classify } = require(path.join(SRC, 'localServer.js'));
  assert.equal(classify('Ethernet', '192.168.0.108'), 'Локальная сеть');
  assert.equal(classify('Ethernet 2', '26.4.5.6'), 'Radmin VPN');
  assert.equal(classify('Radmin VPN', '10.1.1.1'), 'Radmin VPN');
  assert.equal(classify('ZeroTier One', '172.27.1.2'), 'ZeroTier');
  assert.equal(classify('x', '10.147.17.5'), 'ZeroTier');
  assert.equal(classify('x', '100.100.1.1'), 'Tailscale');
  assert.equal(classify('x', '100.200.1.1'), 'Сеть');
  assert.equal(classify('x', '25.1.1.1'), 'Hamachi');

  const list = listAddresses({
    Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.0.108' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    'Radmin VPN': [{ family: 'IPv4', internal: false, address: '26.1.2.3' }],
    Липкий: [{ family: 'IPv4', internal: false, address: '169.254.1.1' }],
  });
  assert.deepEqual(list.map((a) => a.ip), ['26.1.2.3', '192.168.0.108']);
});

T('адреса: IP и localhost без схемы — ws://, домены — wss://', async () => {
  const { normalizeServerUrl, isPlainWs, parseInvite, buildInvite } = await import(path.join(STORES, 'watchTogether.js'));
  assert.equal(normalizeServerUrl('26.1.2.3:8787'), 'ws://26.1.2.3:8787');
  assert.equal(normalizeServerUrl('localhost:8787'), 'ws://localhost:8787');
  assert.equal(normalizeServerUrl('anixflow.onrender.com'), 'wss://anixflow.onrender.com');
  assert.equal(normalizeServerUrl('https://anixflow.onrender.com/'), 'wss://anixflow.onrender.com');
  assert.equal(normalizeServerUrl('http://10.0.0.5:8787'), 'ws://10.0.0.5:8787');
  assert.equal(normalizeServerUrl('  '), '');
  assert.equal(isPlainWs('ws://26.1.2.3:8787'), true);
  assert.equal(isPlainWs('wss://x.com'), false);

  // адрес сервера путешествует вместе с приглашением, друзьям вводить его не нужно
  const inv = buildInvite('K7F4QD2M', 'ws://26.1.2.3:8787');
  const parsed = parseInvite(inv.text);
  assert.equal(parsed.code, 'K7F4QD2M');
  assert.equal(parsed.server, 'ws://26.1.2.3:8787');
});
