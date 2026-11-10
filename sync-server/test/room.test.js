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
  assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
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
  send(hub, c, { t: 'join', cid: newCid(), code: 'ZZZZZZZZ', name: 'a' });
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

test('чат: сообщение получают все (и отправитель), имя берётся у сервера', () => {
  const { hub, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  const guestMid = gs[0].last('welcome').mid;
  host.clear(); gs[0].clear();
  send(hub, gs[0], { t: 'chat', text: '  Привет!  ', name: 'Подделка', mid: 'm1' });
  for (const c of [host, gs[0]]) {
    const m = c.last('chat');
    assert.equal(m.text, 'Привет!');
    assert.equal(m.name, 'Гость0', 'имя не из сообщения');
    assert.equal(m.mid, guestMid);
    assert.equal(m.id, 1);
  }
  send(hub, host, { t: 'chat', text: 'Второе' });
  assert.equal(gs[0].last('chat').id, 2);
});

test('чат: пустое игнорируется, управляющие символы убираются, длина ограничена без разрыва эмодзи', () => {
  const { hub, host, gs } = setup(1);
  host.clear(); gs[0].clear();
  send(hub, host, { t: 'chat', text: '   ' });
  send(hub, host, { t: 'chat', text: 42 });
  assert.equal(gs[0].all('chat').length, 0);
  send(hub, host, { t: 'chat', text: 'a\nb\u0000c\td' });
  assert.equal(gs[0].last('chat').text, 'a b c d');
  send(hub, host, { t: 'chat', text: '😀'.repeat(400) });
  const t = gs[0].last('chat').text;
  assert.equal(Array.from(t).length, LIMITS.CHAT_MAX);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(t), 'нет оборванных суррогатных пар');
});

test('чат: не больше 6 сообщений за 10 секунд, потом снова можно', () => {
  const { hub, clock, host, gs } = setup(1);
  gs[0].clear();
  for (let i = 0; i < LIMITS.CHAT_BURST; i++) send(hub, host, { t: 'chat', text: 'm' + i });
  assert.equal(gs[0].all('chat').length, LIMITS.CHAT_BURST);
  send(hub, host, { t: 'chat', text: 'лишнее' });
  assert.equal(host.last('error').code, 'chat_rate');
  assert.equal(gs[0].all('chat').length, LIMITS.CHAT_BURST);
  clock.t += LIMITS.CHAT_WINDOW_MS + 1;
  clock.t += 1;
  send(hub, host, { t: 'chat', text: 'снова' });
  assert.equal(gs[0].last('chat').text, 'снова');
});

test('чат: вошедший позже видит историю (последние 30), чат вне комнаты запрещён', () => {
  const { hub, clock, host, code } = setup(0);
  for (let i = 1; i <= 40; i++) {
    clock.t += 3000; // чтобы не упереться в лимит частоты
    send(hub, host, { t: 'chat', text: 'сообщение ' + i });
  }
  const late = conn(hub, 'late');
  send(hub, late, { t: 'join', cid: newCid(), code, name: 'Новичок' });
  const h = late.last('welcome').chat;
  assert.equal(h.length, LIMITS.CHAT_HISTORY);
  assert.equal(h[0].text, 'сообщение 11');
  assert.equal(h[h.length - 1].text, 'сообщение 40');

  const stranger = conn(hub, 'stranger');
  send(hub, stranger, { t: 'chat', text: 'я не в комнате' });
  assert.equal(stranger.last('error').code, 'not_in_room');
});

test('вход: код можно вводить с дефисом, пробелами и в нижнем регистре', () => {
  const { hub, code } = setup(0);
  const g = conn(hub, 'g');
  const grouped = (code.slice(0, 4) + ' - ' + code.slice(4)).toLowerCase();
  send(hub, g, { t: 'join', cid: newCid(), code: grouped, name: 'Гость' });
  assert.equal(g.last('welcome').code, code);
});

test('вход: после 5 неверных кодов соединение закрывается (перебор невозможен)', () => {
  const { hub } = makeHub();
  const c = conn(hub, 'brute');
  for (let i = 0; i < 5; i++) send(hub, c, { t: 'join', cid: newCid(), code: 'AAAAAAA' + i, name: 'x' });
  assert.equal(c.all('error').length, 5);
  assert.equal(c.closed, true);
});

test('устаревшие команды: события из прошлой серии не портят позицию новой', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  const m1 = { releaseId: 1, episodePos: 1 };
  send(hub, host, { t: 'media', media: m1 });
  const e1 = host.last('state').ep;
  assert.equal(e1, 1);
  send(hub, host, { t: 'ready', ready: true, seq: host.last('state').seq, ep: e1 });
  send(hub, gs[0], { t: 'ready', ready: true, seq: host.last('state').seq, ep: e1 });
  send(hub, host, { t: 'play', pos: 1200, ts: clock.t, ep: e1 });

  send(hub, host, { t: 'media', media: { releaseId: 1, episodePos: 2 }, pos: 0, play: true });
  const e2 = host.last('state').ep;
  assert.equal(e2, 2);
  const before = host.last('state');

  // «запоздавшие» события старого видео приходят с прошлой эпохой
  send(hub, host, { t: 'pause', pos: 1234, ep: e1 });
  send(hub, host, { t: 'seek', pos: 1234, ep: e1 });
  send(hub, host, { t: 'play', pos: 1234, ts: clock.t, ep: e1 });
  send(hub, gs[0], { t: 'ready', ready: true, seq: before.seq, ep: e1 });
  assert.equal(host.last('state').seq, before.seq, 'новых состояний не появилось');
  assert.equal(host.last('state').pos, 0);

  // команда с актуальной эпохой работает
  send(hub, host, { t: 'pause', pos: 5, ep: e2 });
  assert.equal(host.last('state').pos, 5);
});

test('проверка серии: «готов» с другой серией в плеере не снимает ожидание', () => {
  const { hub, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'media', media: { releaseId: 7, dubberId: 3, sourceId: 9, episodePos: 4 } });
  const st = host.last('state');
  assert.equal(st.waiting.length, 2);
  send(hub, host, { t: 'ready', ready: true, seq: st.seq, ep: st.ep, mk: '7:3:9:4' });
  send(hub, gs[0], { t: 'ready', ready: true, seq: st.seq, ep: st.ep, mk: '7:3:9:3' }); // открыта 3-я серия
  assert.equal(host.last('state').playing, false);
  assert.deepEqual(host.last('state').waiting, [gs[0].last('welcome').mid]);
  send(hub, gs[0], { t: 'ready', ready: true, seq: st.seq, ep: st.ep, mk: '7:3:9:4' });
  assert.equal(host.last('state').playing, true);
  // старые клиенты (без mk) продолжают работать
  const { hub: h2, host: ho2, gs: g2 } = setup(1);
  syncAll(h2, g2[0]);
  send(h2, ho2, { t: 'media', media: { releaseId: 7, dubberId: 3, sourceId: 9, episodePos: 4 } });
  const s2 = ho2.last('state');
  send(h2, ho2, { t: 'ready', ready: true, seq: s2.seq });
  send(h2, g2[0], { t: 'ready', ready: true, seq: s2.seq });
  assert.equal(ho2.last('state').playing, true);
});

test('зависание во время просмотра: ждём недолго (6 с), загрузку серии — дольше (15 с)', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'play', pos: 0, ts: clock.t });
  send(hub, gs[0], { t: 'ready', ready: false, pos: 0 });
  assert.equal(host.last('state').playing, false);
  clock.t += LIMITS.STALL_HOLD_TIMEOUT_MS + 1;
  hub.tick();
  assert.equal(host.last('state').playing, true, 'через 6 с комната продолжила без зависшего');
  assert.equal(host.last('state').reason, 'hold-timeout');

  // загрузка новой серии — прежний срок
  send(hub, host, { t: 'media', media: { releaseId: 1, episodePos: 1 } });
  clock.t += LIMITS.STALL_HOLD_TIMEOUT_MS + 1;
  hub.tick();
  assert.equal(host.last('state').playing, false, 'серия ещё грузится — ждём');
  clock.t += LIMITS.HOLD_TIMEOUT_MS;
  hub.tick();
  assert.equal(host.last('state').playing, true);
});

test('частые зависания: на третий раз за минуту комната перестаёт ждать этого участника', () => {
  const { hub, clock, host, gs } = setup(1);
  const g = gs[0];
  syncAll(hub, g);
  send(hub, host, { t: 'play', pos: 0, ts: clock.t });
  const mid = g.last('welcome').mid;

  for (let i = 0; i < 2; i++) {
    clock.t += 5000;
    send(hub, g, { t: 'ready', ready: false, pos: 10 });
    assert.equal(host.last('state').playing, false, `зависание ${i + 1}: ждём`);
    send(hub, g, { t: 'ready', ready: true, seq: host.last('state').seq });
    assert.equal(host.last('state').playing, true);
  }
  clock.t += 5000;
  send(hub, g, { t: 'ready', ready: false, pos: 10 });
  assert.equal(host.last('state').playing, true, 'третий раз — не ждём');
  const me = host.last('members').members.find((m) => m.mid === mid);
  assert.equal(me.lagging, true);

  // пока «отстающий», он не задерживает ни перемотку, ни смену серии
  send(hub, host, { t: 'seek', pos: 300 });
  const r = host.last('state');
  assert.deepEqual(r.waiting, [host.last('welcome').mid], 'ждём только хоста');

  // через 90 секунд статус снимается
  clock.t += LIMITS.LAG_MS + 1;
  hub.tick();
  assert.equal(host.last('members').members.find((m) => m.mid === mid).lagging, false);
});

test('хост может отключить ожидание зависших участников', () => {
  const { hub, clock, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, gs[0], { t: 'settings', waitForStalls: false });
  assert.equal(gs[0].last('error').code, 'forbidden');
  send(hub, host, { t: 'settings', waitForStalls: false });
  assert.equal(gs[0].last('settings').settings.waitForStalls, false);
  assert.equal(gs[0].last('settings').settings.guestsCanControl, false, 'прочие настройки не сбросились');
  send(hub, host, { t: 'play', pos: 0, ts: clock.t });
  send(hub, gs[0], { t: 'ready', ready: false, pos: 0 });
  assert.equal(host.last('state').playing, true, 'комната не остановилась');
  // но на загрузке серии ожидание остаётся
  send(hub, host, { t: 'settings', guestsCanControl: true });
  assert.equal(gs[0].last('settings').settings.waitForStalls, false);
  send(hub, host, { t: 'media', media: { releaseId: 1, episodePos: 1 } });
  assert.equal(host.last('state').waiting.length, 2);
});

test('серия без озвучки (из оффлайн-раздела): null не превращается в 0, ключ серии совпадает', () => {
  const m = sanitizeMedia({ releaseId: 7, episodePos: 4, dubberId: null, sourceId: null });
  assert.equal(m.dubberId, null);
  assert.equal(m.sourceId, null);
  assert.equal(m.duration, null);

  const { hub, host, gs } = setup(1);
  syncAll(hub, gs[0]);
  send(hub, host, { t: 'media', media: { releaseId: 7, episodePos: 4, dubberId: null, sourceId: null } });
  const st = host.last('state');
  assert.equal(st.media.dubberId, null);
  // клиент считает ключ как releaseId:dubber:source:episode, где пустое — «-»
  send(hub, host, { t: 'ready', ready: true, seq: st.seq, ep: st.ep, mk: '7:-:-:4' });
  send(hub, gs[0], { t: 'ready', ready: true, seq: st.seq, ep: st.ep, mk: '7:-:-:4' });
  assert.equal(host.last('state').playing, true);
});
