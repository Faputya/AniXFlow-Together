'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Hub, LIMITS, sanitizeMedia } = require('../room');

function makeHub() {
  const clock = { t: 1_000_000 };
  let n = 0;
  const hub = new Hub({ now: () => clock.t, rng: (m) => (n++ * 7) % m });
  return { hub, clock };
}

function conn(hub, name) {
  const c = {
    id: Math.random(),
    sent: [],
    closed: false,
    send(o) { this.sent.push(JSON.parse(JSON.stringify(o))); },
    close() { this.closed = true; },
    last(t) { return [...this.sent].reverse().find((m) => m.t === t); },
    all(t) { return this.sent.filter((m) => m.t === t); },
    clear() { this.sent.length = 0; },
  };
  hub.onConnect(c);
  c.name = name;
  c.cid = null;
  return c;
}

const send = (hub, c, msg) => hub.onMessage(c, JSON.stringify(msg));
let cidN = 0;
const newCid = () => 'client-id-' + String(++cidN).padStart(6, '0');

function setup(guests = 1) {
  const { hub, clock } = makeHub();
  const host = conn(hub, 'host');
  host.cidv = newCid();
  send(hub, host, { t: 'create', cid: host.cidv, name: 'Хост' });
  const welcome = host.last('welcome');
  const code = welcome.code;
  const gs = [];
  for (let i = 0; i < guests; i++) {
    const g = conn(hub, 'g' + i);
    g.cidv = newCid();
    send(hub, g, { t: 'join', cid: g.cidv, code, name: 'Гость' + i });
    gs.push(g);
  }
  return { hub, clock, host, gs, code, hostMid: welcome.mid };
}

/** Делает всех участников «синхронизированными» (первый ready:true) */
function syncAll(hub, ...conns) {
  for (const c of conns) send(hub, c, { t: 'ready', ready: true, seq: 0 });
}

test('создание комнаты и вход гостя', () => {
  const { host, gs, code } = setup(1);
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(gs[0].last('welcome').code, code);
  assert.equal(gs[0].last('welcome').members.length, 2);
  assert.equal(host.last('members').members.length, 2);
  assert.equal(host.last('members').host, host.last('welcome').mid);
});

test('комната вмещает максимум 5 человек', () => {
  const { hub, code, gs } = setup(4);
  const extra = conn(hub, 'x');
  send(hub, extra, { t: 'join', cid: newCid(), code, name: 'Лишний' });
  assert.equal(extra.last('error').code, 'room_full');
  assert.equal(gs.length, 4);
});

test('несуществующая комната и неверный cid', () => {
  const { hub } = makeHub();
  const c = conn(hub, 'c');
  send(hub, c, { t: 'join', cid: newCid(), code: 'ZZZZZZ', name: 'a' });
  assert.equal(c.last('error').code, 'room_not_found');
  send(hub, c, { t: 'create', cid: 'x', name: 'a' });
  assert.equal(c.last('error').code, 'bad_request');
});

test('play/pause/seek: гость без прав получает forbidden', () => {
  const { hub, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, gs[0], { t: 'pause', pos: 10 });
  assert.equal(gs[0].last('error').code, 'forbidden');
  assert.equal(host.all('state').filter((s) => s.reason === 'pause').length, 0);
});

test('host: play → всем уходит state с позицией и временем сервера', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  host.clear(); gs[0].clear();
  send(hub, host, { t: 'play', pos: 42.5, ts: clock.t - 80 });
  const s = gs[0].last('state');
  assert.equal(s.playing, true);
  assert.equal(s.pos, 42.5);
  assert.equal(s.at, clock.t - 80);
  assert.equal(s.reason, 'play');
});

test('ts клиента в будущем или слишком старый — ограничивается', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'play', pos: 1, ts: clock.t + 99999 });
  assert.equal(gs[0].last('state').at, clock.t);
  send(hub, host, { t: 'play', pos: 1, ts: clock.t - 99999 });
  assert.equal(gs[0].last('state').at, clock.t - LIMITS.TS_SKEW_MS);
});

test('pause фиксирует позицию, playing=false', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'play', pos: 10, ts: clock.t });
  clock.t += 5000;
  send(hub, host, { t: 'pause', pos: 15.1 });
  const s = gs[0].last('state');
  assert.equal(s.playing, false);
  assert.equal(s.pos, 15.1);
  assert.equal(s.want, false);
});

test('буферизация гостя ставит всех на паузу, готовность — возобновляет с отложенным стартом', () => {
  const { hub, clock, host, gs } = setup(1);
  const g = gs[0];
  syncAll(hub, g);
  send(hub, host, { t: 'play', pos: 100, ts: clock.t });
  clock.t += 3000;
  g.clear(); host.clear();

  send(hub, g, { t: 'ready', ready: false, pos: 103.05, seq: 1 });
  let s = host.last('state');
  assert.equal(s.playing, false);
  assert.equal(s.pos, 103.05, 'берём реальную позицию того, кто тормозит');
  assert.equal(s.waiting.length, 1);
  assert.equal(s.want, true);

  clock.t += 2000;
  send(hub, g, { t: 'ready', ready: true, seq: s.seq });
  s = host.last('state');
  assert.equal(s.playing, true);
  assert.equal(s.waiting.length, 0);
  assert.equal(s.at, clock.t + LIMITS.LEAD_MS, 'старт назначен чуть в будущем, чтобы все начали вместе');
  assert.equal(s.pos, 103.05);
});

test('seek во время просмотра: все ждут, устаревший ready игнорируется', () => {
  const { hub, clock, host, gs } = setup(2);
  const [g1, g2] = gs;
  syncAll(hub, g1, g2);
  send(hub, host, { t: 'play', pos: 0, ts: clock.t });
  clock.t += 1000;
  host.clear(); g1.clear(); g2.clear();

  send(hub, host, { t: 'seek', pos: 600 });
  const s = g1.last('state');
  assert.equal(s.seek, true);
  assert.equal(s.playing, false);
  assert.equal(s.pos, 600);
  assert.equal(s.waiting.length, 3, 'ждём хоста и двух гостей');

  // g1 присылает «готов» со старым seq (до применения seek) — не считается
  send(hub, g1, { t: 'ready', ready: true, seq: s.seq - 1 });
  assert.equal(g1.last('state').waiting.length, 3);

  send(hub, host, { t: 'ready', ready: true, seq: s.seq });
  send(hub, g1, { t: 'ready', ready: true, seq: s.seq });
  assert.equal(host.last('state').playing, false);
  send(hub, g2, { t: 'ready', ready: true, seq: s.seq });
  const r = host.last('state');
  assert.equal(r.playing, true);
  assert.equal(r.pos, 600);
});

test('seek на паузе не создаёт ожидания', () => {
  const { hub, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'seek', pos: 50 });
  const s = gs[0].last('state');
  assert.equal(s.waiting.length, 0);
  assert.equal(s.playing, false);
  assert.equal(s.pos, 50);
});

test('смена серии: только хост, всем уходит media, старт после готовности всех', () => {
  const { hub, clock, host, gs } = setup(1);
  const g = gs[0];
  syncAll(hub, g);
  const media = { releaseId: 7, title: 'Тест', dubberId: 3, dubberName: 'AniLibria', sourceId: 9, sourceName: 'Libria', episodePos: 2, episodeName: '2 серия' };

  send(hub, g, { t: 'media', media });
  assert.equal(g.last('error').code, 'forbidden');

  send(hub, host, { t: 'media', media });
  const s = g.last('state');
  assert.equal(s.reason, 'media');
  assert.equal(s.media.releaseId, 7);
  assert.equal(s.pos, 0);
  assert.equal(s.playing, false);
  assert.equal(s.waiting.length, 2);

  send(hub, host, { t: 'ready', ready: true, seq: s.seq });
  send(hub, g, { t: 'ready', ready: true, seq: s.seq });
  const r = host.last('state');
  assert.equal(r.playing, true);
  assert.equal(r.at, clock.t + LIMITS.LEAD_MS);

  // повтор той же серии ничего не меняет
  host.clear();
  send(hub, host, { t: 'media', media });
  assert.equal(host.all('state').length, 0);
});

test('новичок (joining) не останавливает остальных, пока не сообщит ready', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'play', pos: 5, ts: clock.t });
  const late = conn(hub, 'late');
  const { code } = host.last('welcome');
  send(hub, late, { t: 'join', cid: newCid(), code, name: 'Опоздавший' });
  host.clear();

  send(hub, late, { t: 'ready', ready: false, seq: 0 });
  assert.equal(host.all('state').length, 0, 'ready:false от joining игнорируется');
  assert.equal(late.last('welcome').state.playing, true, 'новичок видит текущее состояние');

  send(hub, late, { t: 'ready', ready: true, seq: 0 });
  assert.equal(host.last('members').members.find((m) => m.name === 'Опоздавший').status, 'synced');
});

test('таймаут ожидания: зависший участник не блокирует комнату вечно', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'play', pos: 0, ts: clock.t });
  send(hub, gs[0], { t: 'ready', ready: false, pos: 0 });
  assert.equal(host.last('state').playing, false);
  clock.t += LIMITS.HOLD_TIMEOUT_MS + 1;
  hub.tick();
  const s = host.last('state');
  assert.equal(s.playing, true);
  assert.equal(s.reason, 'hold-timeout');
});

test('неподходящая серия (unavailable) не задерживает остальных', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  const media = { releaseId: 1, episodePos: 1 };
  send(hub, host, { t: 'media', media });
  const s = host.last('state');
  send(hub, host, { t: 'ready', ready: true, seq: s.seq });
  send(hub, gs[0], { t: 'unavailable', on: true });
  assert.equal(host.last('state').playing, true);
  assert.equal(host.last('state').at, clock.t + LIMITS.LEAD_MS);
});

test('отключение гостя снимает ожидание; возврат в течение 30 с сохраняет место', () => {
  const { hub, clock, host, gs, code } = setup(1);
  const g = gs[0];
  syncAll(hub, g);
  send(hub, host, { t: 'play', pos: 0, ts: clock.t });
  send(hub, g, { t: 'ready', ready: false, pos: 0 });
  assert.equal(host.last('state').playing, false);

  hub.onClose(g);
  assert.equal(host.last('state').playing, true, 'комната продолжает без отвалившегося');
  assert.equal(host.last('members').members.find((m) => !m.connected).name, 'Гость0');

  clock.t += 10_000;
  const g2 = conn(hub, 'g0-again');
  send(hub, g2, { t: 'join', cid: g.cidv, code, name: 'Гость0' });
  const w = g2.last('welcome');
  assert.equal(w.members.length, 2, 'место сохранено, дубля нет');
  assert.equal(w.state.playing, true);
});

test('по истечении grace место освобождается, хост передаётся', () => {
  const { hub, clock, host, gs } = setup(1);
  const g = gs[0];
  hub.onClose(host);
  clock.t += LIMITS.GRACE_MS + 1;
  hub.tick();
  const m = g.last('members');
  assert.equal(m.members.length, 1);
  assert.equal(m.host, m.members[0].mid, 'гость стал хостом');
});

test('пустая комната удаляется', () => {
  const { hub, clock, host, gs } = setup(1);
  hub.onClose(host);
  hub.onClose(gs[0]);
  clock.t += LIMITS.GRACE_MS + 1;
  hub.tick();
  assert.equal(hub.rooms.size, 0);
});

test('явный выход гостя и передача хоста', () => {
  const { hub, host, gs } = setup(2);
  const [g1, g2] = gs;
  const mid2 = g2.last('welcome').mid;
  send(hub, host, { t: 'transfer', to: mid2 });
  assert.equal(g1.last('members').host, mid2);
  send(hub, g1, { t: 'transfer', to: mid2 });
  assert.equal(g1.last('error').code, 'forbidden');
  send(hub, g1, { t: 'leave' });
  assert.equal(host.last('members').members.length, 2);
});

test('guestsCanControl разрешает гостям пауза/перемотка, но не смену серии', () => {
  const { hub, host, gs } = setup(1);
  const g = gs[0];
  syncAll(hub, g);
  send(hub, g, { t: 'settings', guestsCanControl: true });
  assert.equal(g.last('error').code, 'forbidden');
  send(hub, host, { t: 'settings', guestsCanControl: true });
  assert.equal(g.last('settings').settings.guestsCanControl, true);
  send(hub, g, { t: 'pause', pos: 9 });
  assert.equal(host.last('state').reason, 'pause');
  send(hub, g, { t: 'media', media: { releaseId: 1, episodePos: 1 } });
  assert.equal(g.last('error').code, 'forbidden');
});

test('rate: корректно пересчитывает позицию', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'play', pos: 0, ts: clock.t });
  clock.t += 10_000;
  send(hub, host, { t: 'rate', rate: 1.5, pos: 10, ts: clock.t });
  const s = gs[0].last('state');
  assert.equal(s.rate, 1.5);
  assert.equal(s.pos, 10);
  send(hub, host, { t: 'rate', rate: 99, pos: 10 });
  assert.equal(gs[0].last('state').rate, 4, 'скорость ограничена');
});

test('ping возвращает время сервера даже вне комнаты', () => {
  const { hub, clock } = makeHub();
  const c = conn(hub, 'c');
  send(hub, c, { t: 'ping', c: 123 });
  assert.deepEqual(c.last('pong'), { t: 'pong', c: 123, s: clock.t });
});

test('невалидные сообщения не роняют сервер', () => {
  const { hub, host } = setup(1);
  hub.onMessage(host, 'не json');
  assert.equal(host.last('error').code, 'bad_request');
  send(hub, host, { t: 'play', pos: 'abc' });
  assert.equal(host.last('error').code, 'bad_request');
  send(hub, host, { t: 'wat' });
  assert.equal(host.last('error').code, 'bad_request');
  send(hub, host, { t: 'media', media: { releaseId: 'x' } });
  assert.equal(host.last('error').code, 'bad_request');
});

test('соединение без входа в комнату закрывается по таймауту', () => {
  const { hub, clock } = makeHub();
  const c = conn(hub, 'idle');
  clock.t += LIMITS.UNJOINED_TIMEOUT_MS + 1;
  hub.tick();
  assert.equal(c.closed, true);
});

test('ограничение частоты сообщений', () => {
  const { hub, host } = setup(0);
  for (let i = 0; i < LIMITS.BUCKET_CAPACITY + 20; i++) send(hub, host, { t: 'ping', c: i });
  assert.equal(host.last('error').code, 'rate_limited');
});

test('sanitizeMedia: обрезает лишнее и отбрасывает мусор', () => {
  assert.equal(sanitizeMedia(null), null);
  assert.equal(sanitizeMedia({ releaseId: 1 }), null);
  const m = sanitizeMedia({ releaseId: 5, episodePos: 3, title: 'x'.repeat(500), evil: '<script>', offline: 'yes' });
  assert.equal(m.title.length, 120);
  assert.equal(m.evil, undefined);
  assert.equal(m.offline, false);
});

test('создание комнаты посреди серии: media несёт позицию и состояние play', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  const media = { releaseId: 4, episodePos: 5 };
  send(hub, host, { t: 'media', media, pos: 750.5, play: false });
  const s = gs[0].last('state');
  assert.equal(s.pos, 750.5);
  assert.equal(s.want, false);
  assert.equal(s.by, host.last('welcome').mid);
  // «ready» от всех — но играть не начинаем, т.к. play:false
  send(hub, host, { t: 'ready', ready: true, seq: s.seq });
  send(hub, gs[0], { t: 'ready', ready: true, seq: s.seq });
  assert.equal(host.last('state').playing, false);
  assert.equal(host.last('state').waiting.length, 0);
});

test('в командах есть by — по нему клиент узнаёт эхо собственных действий', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  const mid = host.last('welcome').mid;
  send(hub, host, { t: 'play', pos: 1, ts: clock.t });
  assert.equal(gs[0].last('state').by, mid);
  send(hub, host, { t: 'pause', pos: 2 });
  assert.equal(gs[0].last('state').by, mid);
  send(hub, host, { t: 'seek', pos: 3 });
  assert.equal(gs[0].last('state').by, mid);
});
