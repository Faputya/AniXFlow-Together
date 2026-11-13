'use strict';
/**
 * Мост WebSocket для интерфейса.
 *
 * Страница приложения (app://) считается защищённой, поэтому Chromium не позволяет ей открывать обычные
 * ws:// к другим компьютерам, например по Radmin VPN или ZeroTier. Соединение открывается здесь,
 * в главном процессе, а интерфейс получает события через IPC (см. preload.js и bridgeSocket.js).
 *
 * Мост не пересылает ничего, кроме текстовых сообщений протокола комнат: ограничены число соединений
 * на окно и размер сообщения.
 */

const MAX_SOCKETS_PER_WINDOW = 4;
const MAX_MESSAGE = 64 * 1024;
const URL_RE = /^wss?:\/\/[^\s]+$/i;

function init({ ipcMain, isTrustedSender = () => true, WebSocketImpl = globalThis.WebSocket }) {
  /** @type {Map<string, any>} ключ — `${id окна}:${id соединения}` */
  const sockets = new Map();
  const watched = new Set();

  const keyOf = (sender, id) => `${sender.id}:${id}`;

  function emit(sender, id, payload) {
    try {
      if (!sender.isDestroyed || !sender.isDestroyed()) sender.send('ws:event', { id, ...payload });
    } catch (_) {}
  }

  function countFor(sender) {
    let n = 0;
    for (const k of sockets.keys()) if (k.startsWith(`${sender.id}:`)) n++;
    return n;
  }

  function closeAllFor(senderId) {
    for (const [k, ws] of [...sockets]) {
      if (k.startsWith(`${senderId}:`)) {
        try { ws.close(1000); } catch (_) {}
        sockets.delete(k);
      }
    }
  }

  ipcMain.on('ws:open', (event, id, url) => {
    if (!isTrustedSender(event)) return;
    const sender = event.sender;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64 || typeof url !== 'string') return;

    const fail = (message) => {
      emit(sender, id, { type: 'error', message });
      emit(sender, id, { type: 'close', code: 1006 });
    };
    if (!URL_RE.test(url) || url.length > 300) return fail('Неверный адрес');
    if (!WebSocketImpl) return fail('WebSocket недоступен');
    if (countFor(sender) >= MAX_SOCKETS_PER_WINDOW) return fail('Слишком много соединений');
    if (sockets.has(keyOf(sender, id))) return;

    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      return fail('Не удалось открыть соединение');
    }
    const key = keyOf(sender, id);
    sockets.set(key, ws);

    if (!watched.has(sender.id) && typeof sender.once === 'function') {
      watched.add(sender.id);
      sender.once('destroyed', () => {
        watched.delete(sender.id);
        closeAllFor(sender.id);
      });
    }

    ws.addEventListener('open', () => emit(sender, id, { type: 'open' }));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string' && ev.data.length <= MAX_MESSAGE) emit(sender, id, { type: 'message', data: ev.data });
    });
    ws.addEventListener('error', () => emit(sender, id, { type: 'error' }));
    ws.addEventListener('close', (ev) => {
      sockets.delete(key);
      emit(sender, id, { type: 'close', code: ev.code });
    });
  });

  ipcMain.on('ws:send', (event, id, data) => {
    if (!isTrustedSender(event)) return;
    const ws = sockets.get(keyOf(event.sender, id));
    if (!ws || ws.readyState !== 1) return;
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    try { ws.send(data); } catch (_) {}
  });

  ipcMain.on('ws:close', (event, id, code) => {
    if (!isTrustedSender(event)) return;
    const k = keyOf(event.sender, id);
    const ws = sockets.get(k);
    if (!ws) return;
    const c = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    try { ws.close(c); } catch (_) {}
  });

  return { closeAllFor, count: () => sockets.size };
}

module.exports = { init, MAX_SOCKETS_PER_WINDOW, MAX_MESSAGE };
