/**
 * Совместный просмотр: ссылки-приглашения anixflow-join://КОД?server=…
 *
 * Клик по ссылке запускает приложение (или передаёт ссылку уже запущенному).
 * Основной способ войти в комнату — вставить код в окне «Смотреть вместе»,
 * ссылка — удобное дополнение.
 */
const path = require('node:path');

const SCHEME = 'anixflow-join';
let pending = null;
let getWindow = () => null;

function findInvite(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(SCHEME + '://')) || null;
}

function deliver(invite) {
  if (!invite) return;
  const win = getWindow();
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('watch:invite', invite);
  } else {
    pending = invite; // окно ещё грузится — отдадим при старте интерфейса
  }
}

function registerProtocol(app) {
  try {
    if (process.defaultApp) {
      // запуск из исходников (npm start)
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      // при каждом запуске перерегистрируем: после автообновления путь к exe меняется
      app.setAsDefaultProtocolClient(SCHEME);
    }
  } catch (e) {
    console.error('[watchInvite] protocol registration failed:', e);
  }
}

/** Вызывается один раз при старте приложения. */
function init({ app, ipcMain, getMainWindow }) {
  getWindow = getMainWindow;
  pending = findInvite(process.argv);
  registerProtocol(app);

  ipcMain.handle('watch:getPendingInvite', () => {
    const p = pending;
    pending = null;
    return p;
  });

  // macOS присылает ссылку событием, а не в argv
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliver(url);
  });
}

/** Вызывается из обработчика second-instance (Windows/Linux). */
function handleArgv(argv) {
  deliver(findInvite(argv));
}

module.exports = { init, handleArgv, findInvite, SCHEME };
