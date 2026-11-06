'use strict';
/**
 * Сквозная проверка синхронизации: настоящий сервер + настоящие SyncClient/VideoSync
 * + имитация <video> (асинхронные события, время перемотки, буферизация).
 * Пропускается, если рядом нет исходников приложения (например, при деплое одной папки sync-server).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../server');

const SRC = path.resolve(__dirname, '../../src/app/components/stores');
const HAVE_SRC = fs.existsSync(path.join(SRC, 'videoSync.js'));

class FakeVideo extends EventTarget {
  constructor({ seekMs = 80, duration = 1400 } = {}) {
    super();
    this._t = 0; this._rate = 1; this.paused = true; this.readyState = 4;
    this.seeking = false; this.duration = duration; this.ended = false; this.seekMs = seekMs;
    this.last = Date.now();
    this.clock = setInterval(() => {
      const now = Date.now(); const dt = (now - this.last) / 1000; this.last = now;
      if (!this.paused && this.readyState >= 3 && !this.seeking) this._t += dt * this._rate;
    }, 10);
  }
  _emit(name) { setTimeout(() => this.dispatchEvent(new Event(name)), 0); }
  get currentTime() { return this._t; }
  set currentTime(v) {
    this._t = v; this.seeking = true; this._emit('seeking');
    setTimeout(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); }, this.seekMs);
  }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._rate = r; this._emit('ratechange'); }
  play() { if (this.paused) { this.paused = false; this._emit('play'); this._emit('playing'); } return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this._emit('pause'); } }
  stall(ms) {
    this.readyState = 1; this._emit('waiting');
    setTimeout(() => { this.readyState = 4; this._emit('canplay'); this._emit('playing'); }, ms);
  }
  destroy() { clearInterval(this.clock); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 4000, label = 'условие') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return; await sleep(20); }
  throw new Error('не дождались: ' + label);
}

function memStorage(preset) {
  const m = new Map(Object.entries(preset || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

const MEDIA = { releaseId: 42, title: 'Тест', dubberId: 1, dubberName: 'Озвучка', sourceId: 2, sourceName: 'Kodik', episodePos: 1, episodeName: '1 серия' };

(HAVE_SRC ? test : test.skip)('синхронизация хоста и гостя на реальном сервере', async (t) => {
  const { SyncClient } = await import(path.join(SRC, 'watchTogether.js'));
  const { VideoSync } = await import(path.join(SRC, 'videoSync.js'));

  const server = createServer();
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const url = `ws://127.0.0.1:${port}`;
  const peers = [];
  t.after(() => {
    peers.forEach((p) => { try { p.sync.detach(); p.client.leave(); p.video.destroy(); } catch (_) {} });
    server.stopTimers(); server.close();
  });

  const cfg = { LOOP_MS: 100, BUFFER_REPORT_DELAY_MS: 120, SEEK_DEBOUNCE_MS: 60 };
  function peer(name, skewMs = 0, seekMs = 80) {
    const client = new SyncClient({
      WebSocket: globalThis.WebSocket, fetch: null, now: () => Date.now() + skewMs,
      storage: memStorage({ watchTogetherSettings: JSON.stringify({ serverUrl: url, name }) }),
    });
    const video = new FakeVideo({ seekMs });
    const toasts = [];
    const sync = new VideoSync(client, { toast: (x) => toasts.push(x) }, cfg);
    const p = { name, client, video, sync, toasts, opened: [] };
    client.on('openMedia', (m) => p.opened.push(m));
    peers.push(p);
    return p;
  }

  const host = peer('Хост');
  const guest = peer('Гость', 7000, 250); // часы гостя спешат на 7 с, перемотка медленная

  await host.client.createRoom();
  host.sync.attach(host.video);
  host.sync.noteMedia(MEDIA, { pos: 0, play: false });
  await waitFor(() => host.client.snapshot.media, 2000, 'media у хоста');

  await guest.client.joinRoom(host.client.snapshot.code);
  await waitFor(() => guest.opened.length === 1, 2000, 'гость получил openMedia');
  assert.equal(guest.opened[0].releaseId, 42);
  guest.sync.attach(guest.video);
  guest.sync.noteMedia(MEDIA);
  await waitFor(() => guest.client.snapshot.members.every((m) => m.status === 'synced'), 2000, 'гость synced');

  const skew = Math.abs(guest.client.offset + 7000 - host.client.offset);
  assert.ok(skew < 120, `часы выровнены, ошибка ${skew} мс`);

  await t.test('play хоста запускает гостя, позиции близки', async () => {
    host.video.play();
    await waitFor(() => !guest.video.paused, 2000, 'гость играет');
    await sleep(1500);
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.35, `разница ${host.video.currentTime - guest.video.currentTime}`);
    assert.ok(host.video.currentTime > 1.2);
  });

  await t.test('pause хоста останавливает гостя на той же позиции', async () => {
    host.video.pause();
    await waitFor(() => guest.video.paused, 2000, 'гость на паузе');
    await sleep(300);
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.4);
  });

  await t.test('перемотка хоста во время просмотра: ждём медленного гостя и стартуем вместе', async () => {
    host.video.play();
    await waitFor(() => !guest.video.paused, 2000, 'гость играет');
    host.video.currentTime = 600;
    await waitFor(() => guest.video.currentTime > 599 && guest.video.currentTime < 603, 3000, 'гость перемотан');
    // пока гость перематывается (250 мс), хост не уходит вперёд
    await waitFor(() => !host.video.paused && !guest.video.paused, 3000, 'оба играют');
    await sleep(1200);
    assert.ok(host.video.currentTime > 600.8 && host.video.currentTime < 604, 'хост ' + host.video.currentTime);
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.4, 'разница ' + (host.video.currentTime - guest.video.currentTime));
  });

  await t.test('буферизация у гостя останавливает всех и возобновляет вместе', async () => {
    guest.video.stall(900);
    await waitFor(() => host.video.paused, 2000, 'хост ждёт');
    assert.deepEqual(host.client.snapshot.waitingNames, ['Гость']);
    await waitFor(() => !host.video.paused && !guest.video.paused, 4000, 'оба снова играют');
    await sleep(1000);
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.45, 'разница ' + (host.video.currentTime - guest.video.currentTime));
  });

  await t.test('гость не может поставить паузу сам: действие откатывается', async () => {
    guest.video.pause();
    await waitFor(() => !guest.video.paused, 2000, 'пауза гостя откатилась');
    assert.equal(host.video.paused, false);
    assert.ok(guest.toasts.length >= 1);
  });

  await t.test('небольшой дрейф гасится скоростью, без перемотки', async () => {
    const before = guest.video.currentTime;
    guest.video._t += 0.7; // гость убежал вперёд на 0.7 с
    let sawSoft = false; let seeks = 0;
    guest.video.addEventListener('seeking', () => seeks++);
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (guest.video.playbackRate < 1) sawSoft = true;
      if (Math.abs(host.video.currentTime - guest.video.currentTime) < 0.15 && sawSoft) break;
      await sleep(50);
    }
    assert.ok(sawSoft, 'скорость гостя временно снижалась');
    assert.equal(seeks, 0, 'перемотки не было');
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.25, 'разница ' + (host.video.currentTime - guest.video.currentTime));
    // подстройка заканчивается, когда расхождение < 0.08 с, — скорость возвращается к 1
    await waitFor(() => Math.abs(guest.video.playbackRate - 1) < 0.001, 6000, 'скорость вернулась к 1');
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.12);
  });

  await t.test('большой дрейф исправляется перемоткой', async () => {
    guest.video._t += 5;
    await waitFor(() => Math.abs(host.video.currentTime - guest.video.currentTime) < 0.6, 5000, 'гость вернулся');
  });

  await t.test('разрыв связи у гостя: он возвращается и синхронизируется', async () => {
    guest.client.ws.close();
    await waitFor(() => guest.client.snapshot.phase === 'reconnecting', 2000, 'reconnecting');
    await waitFor(() => guest.client.snapshot.phase === 'connected', 6000, 'снова в комнате');
    await sleep(1500);
    assert.equal(guest.client.snapshot.members.length, 2, 'место сохранилось');
    assert.ok(!guest.video.paused);
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.6);
  });

  await t.test('чат: сообщения доходят, свои помечены, после обрыва связи история на месте', async () => {
    const got = [];
    const mineFlags = [];
    guest.client.on('chat', (m) => { got.push(m); mineFlags.push(m.mine); });
    host.client.sendChat('привет всем');
    await waitFor(() => got.length === 1, 2000, 'сообщение у гостя');
    assert.equal(got[0].text, 'привет всем');
    assert.equal(got[0].name, 'Хост');
    assert.equal(got[0].mine, false);

    assert.equal(guest.client.sendChat('   '), false, 'пустое не отправляется');
    assert.equal(guest.client.sendChat('  и тебе!  '), true);
    await waitFor(() => host.client.snapshot.chat.length === 2, 2000, 'ответ у хоста');
    await waitFor(() => got.length === 2, 2000, 'эхо у отправителя');
    assert.equal(mineFlags[1], true, 'своё сообщение помечено mine');
    assert.equal(host.client.snapshot.chat[1].text, 'и тебе!');

    guest.client.ws.close();
    await waitFor(() => guest.client.snapshot.phase === 'reconnecting', 2000, 'reconnecting');
    await waitFor(() => guest.client.snapshot.phase === 'connected', 6000, 'снова в комнате');
    assert.equal(guest.client.snapshot.chat.length, 2, 'история вернулась с сервера');
    assert.equal(guest.client.snapshot.chat[0].text, 'привет всем');
  });

  await t.test('хост меняет серию: гость получает openMedia и ждёт', async () => {
    guest.opened.length = 0;
    host.sync.noteMedia({ ...MEDIA, episodePos: 2, episodeName: '2 серия' }, { pos: 0, play: true });
    await waitFor(() => guest.opened.length === 1, 2000, 'openMedia у гостя');
    assert.equal(guest.opened[0].episodePos, 2);
    assert.equal(host.video.paused, true, 'хост ждёт загрузки гостя');
  });

  await t.test('разрешение гостям управлять: гость ставит паузу, хост подчиняется', async () => {
    guest.sync.noteMedia({ ...MEDIA, episodePos: 2 });
    guest.sync._onMetadata();
    host.sync._onMetadata();
    await waitFor(() => !host.video.paused && !guest.video.paused, 4000, 'оба играют после смены серии');
    host.client.setGuestsCanControl(true);
    await waitFor(() => guest.client.canControl, 2000, 'гость получил право');
    guest.video.pause();
    await waitFor(() => host.video.paused, 2000, 'хост на паузе');
  });
});
