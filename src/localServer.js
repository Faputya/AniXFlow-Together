'use strict';
/**
 * Сервер комнат прямо в приложении.
 *
 * Хост запускает его кнопкой в окне «Смотреть вместе», а друзья подключаются по адресу его компьютера
 * в виртуальной сети (Radmin VPN, ZeroTier, Tailscale, Hamachi) или в локальной сети. Отдельно ставить
 * Node.js и держать окно командной строки не нужно. Внешний хостинг тоже не нужен, а значит, нет
 * зависимости от доступности чужих сайтов у провайдера.
 */
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 8787;

function ipToInt(ip) {
  return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
}

/** Определяет, какая это сеть, по имени адаптера и диапазону адреса. */
function classify(name, ip) {
  const n = String(name || '').toLowerCase();
  if (/radmin/.test(n) || ip.startsWith('26.')) return 'Radmin VPN';
  if (/hamachi/.test(n) || ip.startsWith('25.')) return 'Hamachi';
  if (/zerotier/.test(n) || ip.startsWith('10.147.')) return 'ZeroTier';
  const v = ipToInt(ip);
  if (/tailscale/.test(n) || (v >= ipToInt('100.64.0.0') && v <= ipToInt('100.127.255.255'))) return 'Tailscale';
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || (v >= ipToInt('172.16.0.0') && v <= ipToInt('172.31.255.255'))) {
    return 'Локальная сеть';
  }
  return 'Сеть';
}

const VPN_KINDS = ['Radmin VPN', 'ZeroTier', 'Hamachi', 'Tailscale'];

/** IPv4-адреса этого компьютера: сначала виртуальные сети, потом локальная. */
function listAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, infos] of Object.entries(interfaces || {})) {
    for (const info of infos || []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (!v4 || info.internal || info.address.startsWith('169.254.')) continue;
      out.push({ name, ip: info.address, kind: classify(name, info.address) });
    }
  }
  const rank = (a) => {
    const i = VPN_KINDS.indexOf(a.kind);
    return i === -1 ? VPN_KINDS.length : i;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

function friendlyError(err, port) {
  if (err && err.code === 'EADDRINUSE') {
    return new Error(`Порт ${port} уже занят (возможно, сервер уже запущен в другом окне). Закройте его или выберите другой порт.`);
  }
  if (err && err.code === 'EACCES') return new Error(`Нет прав открыть порт ${port}. Выберите другой.`);
  return new Error('Не удалось запустить сервер: ' + ((err && err.message) || err));
}

function createManager({ createServer, interfaces = () => os.networkInterfaces(), log = () => {} }) {
  let server = null;
  let port = null;

  const manager = {
    status() {
      const p = port ?? DEFAULT_PORT;
      return {
        running: !!server,
        port,
        addresses: listAddresses(interfaces()).map((a) => ({ ...a, url: `ws://${a.ip}:${p}` })),
      };
    },

    async start(wanted = DEFAULT_PORT) {
      if (server) return manager.status();
      const want = Number.isInteger(Number(wanted)) && Number(wanted) >= 0 && Number(wanted) <= 65535
        ? Number(wanted)
        : DEFAULT_PORT;
      const srv = createServer({ log });
      try {
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(want, '0.0.0.0', () => {
            srv.removeListener('error', reject);
            resolve();
          });
        });
      } catch (e) {
        srv.stopTimers && srv.stopTimers();
        throw friendlyError(e, want);
      }
      server = srv;
      port = srv.address().port;
      return manager.status();
    },

    async stop() {
      if (!server) return manager.status();
      const srv = server;
      server = null;
      port = null;
      srv.stopTimers && srv.stopTimers();
      srv.closeAll && srv.closeAll();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        srv.close(() => { clearTimeout(t); resolve(); });
      });
      return manager.status();
    },
  };
  return manager;
}

/** Подключение к приложению: IPC-команды для интерфейса. */
function init({ app, ipcMain }) {
  const { createServer } = require(path.join(__dirname, '..', 'sync-server', 'server.js'));
  const manager = createManager({ createServer, log: (...a) => console.error('[local sync]', ...a) });
  ipcMain.handle('localServer:status', () => manager.status());
  ipcMain.handle('localServer:start', (_e, p) => manager.start(p));
  ipcMain.handle('localServer:stop', () => manager.stop());
  app.on('will-quit', () => { manager.stop(); });
  return manager;
}

module.exports = { init, createManager, listAddresses, classify, DEFAULT_PORT };
