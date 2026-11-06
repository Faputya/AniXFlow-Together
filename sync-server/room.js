'use strict';
/**
 * AniXFlow Watch Together — логика комнат (без сети и без зависимостей).
 *
 * Транспорт (server.js) передаёт сюда соединения `conn`:
 *   { id, send(obj), close(code?) }
 * и вызывает hub.onMessage / hub.onClose / hub.tick.
 *
 * Модель синхронизации:
 *  - у комнаты одно авторитетное состояние { playing, pos, at, rate }:
 *    позиция `pos` (сек) была верна в серверный момент `at` (мс);
 *    если playing, текущая позиция = pos + (now - at) * rate.
 *  - «want» — намерение (хост нажал play), «playing» — реальное состояние.
 *    Если кто-то буферизуется (hold), playing=false, пока все не будут готовы.
 *  - при возобновлении после hold старт назначается на now + LEAD_MS,
 *    чтобы все клиенты начали одновременно.
 */

const crypto = require('node:crypto');

const LIMITS = Object.freeze({
  MAX_MEMBERS: 5,
  LEAD_MS: 600,
  HOLD_TIMEOUT_MS: 15000,
  GRACE_MS: 30000,
  UNJOINED_TIMEOUT_MS: 10000,
  MAX_ROOMS: 1000,
  NAME_MAX: 24,
  MEDIA_MAX_JSON: 2048,
  MAX_POS: 24 * 3600,
  TS_SKEW_MS: 2000,
  BUCKET_CAPACITY: 60,
  BUCKET_REFILL_PER_S: 30,
  CHAT_MAX: 300,
  CHAT_HISTORY: 30,
  CHAT_BURST: 6, // не больше 6 сообщений...
  CHAT_WINDOW_MS: 10000, // ...за 10 секунд от одного участника
});

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function num(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  // убираем управляющие символы
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** Текст чата: без управляющих символов, обрезка по символам Unicode (эмодзи не рвутся). */
function cleanChat(v) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, LIMITS.CHAT_MAX).join('');
}

function sanitizeMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const releaseId = Number(m.releaseId);
  const episodePos = Number(m.episodePos);
  if (!Number.isFinite(releaseId) || !Number.isFinite(episodePos)) return null;
  const out = {
    releaseId,
    title: str(m.title, 120),
    dubberId: Number.isFinite(Number(m.dubberId)) ? Number(m.dubberId) : null,
    dubberName: str(m.dubberName, 60),
    sourceId: Number.isFinite(Number(m.sourceId)) ? Number(m.sourceId) : null,
    sourceName: str(m.sourceName, 40),
    episodePos,
    episodeName: str(m.episodeName, 80),
    offline: m.offline === true,
    duration: Number.isFinite(Number(m.duration)) ? num(m.duration, 0, LIMITS.MAX_POS, null) : null,
  };
  if (JSON.stringify(out).length > LIMITS.MEDIA_MAX_JSON) return null;
  return out;
}

class Room {
  constructor(code, now) {
    this.code = code;
    this.createdAt = now;
    this.members = new Map(); // cid -> member
    this.hostMid = null;
    this.settings = { guestsCanControl: false };
    this.media = null;
    this.chat = [];
    this.chatSeq = 0;
    this.seq = 0;
    this.midCounter = 0;
    /** @type {Map<string,{since:number,needSeq:number}>} */
    this.hold = new Map();
    this.st = { playing: false, want: false, pos: 0, at: now, rate: 1 };
  }

  // ── вспомогательное ─────────────────────────────────────────────
  memberByMid(mid) {
    for (const m of this.members.values()) if (m.mid === mid) return m;
    return null;
  }

  connected() {
    return [...this.members.values()].filter((m) => m.conn);
  }

  currentPos(now) {
    const s = this.st;
    return s.playing ? s.pos + (Math.max(0, now - s.at) / 1000) * s.rate : s.pos;
  }

  canControl(member) {
    return member.mid === this.hostMid || this.settings.guestsCanControl;
  }

  membersView() {
    return [...this.members.values()].map((m) => ({
      mid: m.mid,
      name: m.name,
      status: m.status,
      ready: m.ready,
      connected: !!m.conn,
      duration: m.duration,
      unavailable: m.unavailable,
    }));
  }

  snapshot() {
    const s = this.st;
    return {
      seq: this.seq,
      playing: s.playing,
      want: s.want,
      pos: s.pos,
      at: s.at,
      rate: s.rate,
      waiting: [...this.hold.keys()],
    };
  }

  // ── рассылка ────────────────────────────────────────────────────
  broadcast(msg, exceptCid = null) {
    for (const m of this.members.values()) {
      if (m.conn && m.cid !== exceptCid) m.conn.send(msg);
    }
  }

  sendMembers() {
    this.broadcast({ t: 'members', host: this.hostMid, members: this.membersView() });
  }

  publish(reason, extra = {}) {
    this.seq += 1;
    this.broadcast({ t: 'state', ...this.snapshot(), reason, ...extra });
  }

  // ── hold / reconcile ────────────────────────────────────────────
  /** участники, которых нужно ждать (подключены, синхронизированы, доступны) */
  holdable(m) {
    return !!m.conn && m.status === 'synced' && !m.unavailable;
  }

  holdAll(needSeq, now) {
    for (const m of this.members.values()) {
      if (!this.holdable(m)) continue;
      m.ready = false;
      this.hold.set(m.mid, { since: now, needSeq });
    }
  }

  /**
   * Приводит реальное состояние (playing) в соответствие с намерением (want)
   * и текущим hold, затем рассылает ровно одно сообщение state.
   */
  reconcile(now, reason, { seek = false, pos = null, startAt = null, extra = {} } = {}) {
    const s = this.st;
    const effective = s.want && this.hold.size === 0;
    if (effective && !s.playing) {
      s.playing = true;
      s.at = startAt != null ? startAt : now + LIMITS.LEAD_MS;
    } else if (!effective && s.playing) {
      s.pos = pos != null ? pos : this.currentPos(now);
      s.at = now;
      s.playing = false;
    }
    this.publish(reason, { seek, ...extra });
  }

  dropFromHold(mid) {
    return this.hold.delete(mid);
  }
}

class Hub {
  /**
   * @param {{now?:()=>number, rng?:(n:number)=>number}} [opts]
   */
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.rng = opts.rng || ((n) => crypto.randomInt(n));
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Set<object>} */
    this.conns = new Set();
  }

  // ── транспортные хуки ───────────────────────────────────────────
  onConnect(conn) {
    conn.createdAt = this.now();
    conn.cid = null;
    conn.room = null;
    conn.bucket = { tokens: LIMITS.BUCKET_CAPACITY, ts: this.now() };
    this.conns.add(conn);
  }

  onClose(conn) {
    this.conns.delete(conn);
    const room = conn.room;
    if (!room || !conn.cid) return;
    const m = room.members.get(conn.cid);
    if (!m || m.conn !== conn) return; // уже заменён новым соединением
    m.conn = null;
    m.disconnectedAt = this.now();
    m.ready = false;
    const held = room.dropFromHold(m.mid);
    room.sendMembers();
    if (held) room.reconcile(this.now(), 'member-left');
  }

  onMessage(conn, raw) {
    const now = this.now();
    if (!this.takeToken(conn, now)) {
      this.sendError(conn, 'rate_limited', 'Слишком много сообщений');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return this.sendError(conn, 'bad_request', 'Некорректный JSON');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      return this.sendError(conn, 'bad_request', 'Нет поля t');
    }

    if (msg.t === 'ping') {
      conn.send({ t: 'pong', c: msg.c, s: now });
      return;
    }

    if (msg.t === 'create') return this.handleCreate(conn, msg, now);
    if (msg.t === 'join') return this.handleJoin(conn, msg, now);

    const room = conn.room;
    const member = room && conn.cid ? room.members.get(conn.cid) : null;
    if (!room || !member || member.conn !== conn) {
      return this.sendError(conn, 'not_in_room', 'Сначала войдите в комнату');
    }
    this.handleRoomMessage(room, member, msg, now);
  }

  tick() {
    const now = this.now();
    for (const conn of [...this.conns]) {
      if (!conn.room && now - conn.createdAt > LIMITS.UNJOINED_TIMEOUT_MS) {
        try { conn.close(4000); } catch (_) {}
        this.conns.delete(conn);
      }
    }
    for (const room of [...this.rooms.values()]) {
      let changed = false;
      let holdChanged = false;
      for (const [mid, h] of [...room.hold]) {
        if (now - h.since > LIMITS.HOLD_TIMEOUT_MS) {
          room.hold.delete(mid);
          holdChanged = true;
        }
      }
      for (const m of [...room.members.values()]) {
        if (!m.conn && m.disconnectedAt != null && now - m.disconnectedAt > LIMITS.GRACE_MS) {
          this.removeMember(room, m, now, true);
          changed = true;
        }
      }
      if (room.members.size === 0) {
        this.rooms.delete(room.code);
        continue;
      }
      if (changed) room.sendMembers();
      if (holdChanged || changed) room.reconcile(now, holdChanged ? 'hold-timeout' : 'member-left');
    }
  }

  stats() {
    let members = 0;
    for (const r of this.rooms.values()) members += r.connected().length;
    return { rooms: this.rooms.size, members };
  }

  // ── создание / вход ─────────────────────────────────────────────
  makeCode() {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[this.rng(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  cleanName(v) {
    return str(v, LIMITS.NAME_MAX) || 'Гость';
  }

  validCid(v) {
    return typeof v === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(v) ? v : null;
  }

  handleCreate(conn, msg, now) {
    const cid = this.validCid(msg.cid);
    if (!cid) return this.sendError(conn, 'bad_request', 'Неверный идентификатор клиента');
    if (conn.room) return this.sendError(conn, 'bad_request', 'Вы уже в комнате');
    if (this.rooms.size >= LIMITS.MAX_ROOMS) return this.sendError(conn, 'server_busy', 'Сервер перегружен');
    const code = this.makeCode();
    if (!code) return this.sendError(conn, 'server_busy', 'Не удалось создать комнату');

    const room = new Room(code, now);
    this.rooms.set(code, room);
    const member = this.addMember(room, conn, cid, this.cleanName(msg.name), now, 'synced');
    room.hostMid = member.mid;
    this.sendWelcome(room, member, now);
  }

  handleJoin(conn, msg, now) {
    const cid = this.validCid(msg.cid);
    if (!cid) return this.sendError(conn, 'bad_request', 'Неверный идентификатор клиента');
    if (conn.room) return this.sendError(conn, 'bad_request', 'Вы уже в комнате');
    const code = str(msg.code, 12).toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return this.sendError(conn, 'room_not_found', 'Комната не найдена или уже закрыта');

    const existing = room.members.get(cid);
    if (existing) {
      // переподключение: забираем место, старое соединение закрываем
      const old = existing.conn;
      existing.conn = conn;
      existing.disconnectedAt = null;
      existing.status = 'joining';
      existing.ready = false;
      existing.unavailable = false;
      if (msg.name) existing.name = this.cleanName(msg.name);
      conn.cid = cid;
      conn.room = room;
      if (old && old !== conn) {
        old.room = null;
        try { old.close(4001); } catch (_) {}
        this.conns.delete(old);
      }
      room.dropFromHold(existing.mid);
      this.sendWelcome(room, existing, now);
      room.sendMembers();
      room.reconcile(now, 'member-rejoined');
      return;
    }

    if (room.members.size >= LIMITS.MAX_MEMBERS) {
      return this.sendError(conn, 'room_full', `В комнате уже ${LIMITS.MAX_MEMBERS} человек`);
    }
    const member = this.addMember(room, conn, cid, this.cleanName(msg.name), now, 'joining');
    this.sendWelcome(room, member, now);
    room.sendMembers();
  }

  addMember(room, conn, cid, name, now, status) {
    room.midCounter += 1;
    const member = {
      cid,
      mid: 'm' + room.midCounter,
      name,
      conn,
      status,
      ready: status === 'synced',
      unavailable: false,
      duration: null,
      joinedAt: now,
      disconnectedAt: null,
      chatTimes: [],
    };
    room.members.set(cid, member);
    conn.cid = cid;
    conn.room = room;
    return member;
  }

  sendWelcome(room, member, now) {
    member.conn.send({
      t: 'welcome',
      code: room.code,
      mid: member.mid,
      host: room.hostMid,
      members: room.membersView(),
      settings: room.settings,
      media: room.media,
      chat: room.chat,
      state: { ...room.snapshot(), pos: room.st.pos, serverNow: now },
      serverNow: now,
    });
  }

  removeMember(room, member, now, silent = false) {
    room.members.delete(member.cid);
    room.dropFromHold(member.mid);
    if (member.conn) {
      member.conn.room = null;
      member.conn.cid = null;
    }
    if (room.hostMid === member.mid) {
      const next = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)
        .find((m) => m.conn) || [...room.members.values()][0];
      room.hostMid = next ? next.mid : null;
    }
    if (!silent) {
      room.sendMembers();
      room.reconcile(now, 'member-left');
    }
  }

  // ── сообщения внутри комнаты ────────────────────────────────────
  handleRoomMessage(room, member, msg, now) {
    const s = room.st;
    const isHost = member.mid === room.hostMid;
    const clampTs = (ts) => {
      const t = Number(ts);
      if (!Number.isFinite(t)) return now;
      return Math.min(now, Math.max(now - LIMITS.TS_SKEW_MS, t));
    };
    const pos = () => num(msg.pos, 0, LIMITS.MAX_POS, null);

    switch (msg.t) {
      case 'leave': {
        const conn = member.conn;
        this.removeMember(room, member, now);
        if (room.members.size === 0) this.rooms.delete(room.code);
        if (conn) { conn.room = null; conn.cid = null; }
        return;
      }

      case 'play': {
        if (!room.canControl(member)) return this.sendError(member.conn, 'forbidden', 'Управляет только хост');
        const p = pos();
        if (p == null) return this.sendError(member.conn, 'bad_request', 'Нет позиции');
        const at = clampTs(msg.ts);
        s.want = true;
        s.pos = p;
        s.at = at;
        s.playing = false;
        return room.reconcile(now, 'play', { startAt: at, extra: { by: member.mid } });
      }

      case 'pause': {
        if (!room.canControl(member)) return this.sendError(member.conn, 'forbidden', 'Управляет только хост');
        const p = pos();
        if (p == null) return this.sendError(member.conn, 'bad_request', 'Нет позиции');
        s.want = false;
        s.pos = p;
        s.at = now;
        s.playing = false;
        return room.reconcile(now, 'pause', { extra: { by: member.mid } });
      }

      case 'seek': {
        if (!room.canControl(member)) return this.sendError(member.conn, 'forbidden', 'Управляет только хост');
        const p = pos();
        if (p == null) return this.sendError(member.conn, 'bad_request', 'Нет позиции');
        s.pos = p;
        s.at = now;
        s.playing = false;
        if (s.want) room.holdAll(room.seq + 1, now);
        return room.reconcile(now, 'seek', { seek: true, extra: { by: member.mid } });
      }

      case 'rate': {
        if (!room.canControl(member)) return this.sendError(member.conn, 'forbidden', 'Управляет только хост');
        const r = num(msg.rate, 0.25, 4, null);
        const p = pos();
        if (r == null) return this.sendError(member.conn, 'bad_request', 'Неверная скорость');
        if (s.playing) {
          s.pos = p != null ? p : room.currentPos(now);
          s.at = clampTs(msg.ts);
        } else if (p != null) {
          s.pos = p;
        }
        s.rate = r;
        return room.reconcile(now, 'rate', { extra: { by: member.mid } });
      }

      case 'media': {
        if (!isHost) return this.sendError(member.conn, 'forbidden', 'Выбирать серию может только хост');
        const media = sanitizeMedia(msg.media);
        if (!media) return this.sendError(member.conn, 'bad_request', 'Некорректное описание серии');
        const same = room.media
          && room.media.releaseId === media.releaseId
          && room.media.dubberId === media.dubberId
          && room.media.sourceId === media.sourceId
          && room.media.episodePos === media.episodePos;
        if (same) return; // повторное сообщение о той же серии
        room.media = media;
        for (const m of room.members.values()) { m.unavailable = false; m.duration = null; }
        s.pos = num(msg.pos, 0, LIMITS.MAX_POS, 0);
        s.at = now;
        s.playing = false;
        s.want = msg.play !== false; // по умолчанию серия стартует сама, как в обычном плеере
        room.holdAll(room.seq + 1, now);
        room.sendMembers();
        return room.reconcile(now, 'media', { seek: true, extra: { media, by: member.mid } });
      }

      case 'ready': {
        const ready = msg.ready === true;
        const seq = Number(msg.seq);
        if (ready) {
          const h = room.hold.get(member.mid);
          // «готов» из прошлого (до применения seek/смены серии) игнорируем
          if (h && Number.isFinite(seq) && seq < h.needSeq) return;
        }
        member.ready = ready;
        let promoted = false;
        if (ready && member.status === 'joining') {
          member.status = 'synced';
          promoted = true;
        }
        let changed = false;
        if (ready) {
          changed = room.dropFromHold(member.mid);
        } else if (room.holdable(member) && !room.hold.has(member.mid)) {
          room.hold.set(member.mid, { since: now, needSeq: 0 });
          changed = true;
        }
        if (promoted) room.sendMembers();
        if (changed) {
          const p = pos();
          // при остановке из-за буферизации берём реальную позицию того, кто тормозит
          const useP = !ready && s.playing && p != null
            && Math.abs(p - room.currentPos(now)) < 3 ? p : null;
          room.reconcile(now, ready ? 'ready' : 'buffering', { pos: useP });
        }
        return;
      }

      case 'unavailable': {
        member.unavailable = msg.on !== false;
        const changed = member.unavailable && room.dropFromHold(member.mid);
        room.sendMembers();
        if (changed) room.reconcile(now, 'unavailable');
        return;
      }

      case 'meta': {
        const d = num(msg.duration, 0, LIMITS.MAX_POS, null);
        member.duration = d;
        if (isHost && room.media) room.media.duration = d;
        return room.sendMembers();
      }

      case 'settings': {
        if (!isHost) return this.sendError(member.conn, 'forbidden', 'Только хост меняет настройки');
        room.settings = { guestsCanControl: msg.guestsCanControl === true };
        return room.broadcast({ t: 'settings', settings: room.settings });
      }

      case 'transfer': {
        if (!isHost) return this.sendError(member.conn, 'forbidden', 'Только хост может передать управление');
        const target = room.memberByMid(String(msg.to));
        if (!target || !target.conn) return this.sendError(member.conn, 'bad_request', 'Участник недоступен');
        room.hostMid = target.mid;
        return room.sendMembers();
      }

      case 'chat': {
        const text = cleanChat(msg.text);
        if (!text) return;
        member.chatTimes = member.chatTimes.filter((t) => now - t < LIMITS.CHAT_WINDOW_MS);
        if (member.chatTimes.length >= LIMITS.CHAT_BURST) {
          return this.sendError(member.conn, 'chat_rate', 'Слишком быстро, подождите немного');
        }
        member.chatTimes.push(now);
        room.chatSeq += 1;
        // имя берём у сервера, а не из сообщения: подделать автора нельзя
        const entry = { id: room.chatSeq, mid: member.mid, name: member.name, text, ts: now };
        room.chat.push(entry);
        if (room.chat.length > LIMITS.CHAT_HISTORY) room.chat.splice(0, room.chat.length - LIMITS.CHAT_HISTORY);
        return room.broadcast({ t: 'chat', ...entry });
      }

      case 'name': {
        member.name = this.cleanName(msg.name);
        return room.sendMembers();
      }

      default:
        return this.sendError(member.conn, 'bad_request', 'Неизвестная команда');
    }
  }

  // ── утилиты ─────────────────────────────────────────────────────
  sendError(conn, code, message) {
    if (!conn) return;
    try { conn.send({ t: 'error', code, message }); } catch (_) {}
  }

  takeToken(conn, now) {
    const b = conn.bucket;
    const elapsed = Math.max(0, now - b.ts) / 1000;
    b.tokens = Math.min(LIMITS.BUCKET_CAPACITY, b.tokens + elapsed * LIMITS.BUCKET_REFILL_PER_S);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

module.exports = { Hub, Room, LIMITS, sanitizeMedia, CODE_ALPHABET };
