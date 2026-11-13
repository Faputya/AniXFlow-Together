/**
 * Совместный просмотр — клиент комнат.
 *
 * Здесь только сеть и состояние комнаты (без DOM):
 *  - подключение к серверу синхронизации по WebSocket, переподключение;
 *  - оценка разницы часов с сервером (по ping/pong, как в NTP);
 *  - store `watch` (совместим с Svelte: $watch) и события для VideoSync.
 *
 * Привязка к <video> — в videoSync.js, открытие серии у гостя — в watchTogetherNav.js.
 */

/** Адрес сервера по умолчанию. Впишите сюда свой, например 'wss://anixflow-sync.onrender.com'.
 *  Его можно также задать в окне «Смотреть вместе»; в приглашении адрес передаётся автоматически. */
export const DEFAULT_SERVER_URL = "";

import { BridgeSocket } from "./bridgeSocket.js";

const SETTINGS_KEY = "watchTogetherSettings";
const CID_KEY = "watchTogetherCid";
const CODE_RE = /^[A-HJKMNP-Z2-9]{6,10}$/; // сейчас коды из 8 символов; 6 — у комнат на старом сервере

// ── минимальный store (контракт Svelte: subscribe/set/update) ────────────────
export function createStore(initial) {
    let value = initial;
    const subs = new Set();
    return {
        subscribe(fn) {
            subs.add(fn);
            fn(value);
            return () => subs.delete(fn);
        },
        set(v) {
            value = v;
            subs.forEach((fn) => fn(value));
        },
        update(fn) {
            this.set(fn(value));
        },
        get: () => value,
    };
}

export function derived(store, fn) {
    return {
        subscribe(cb) {
            let last;
            let first = true;
            return store.subscribe((v) => {
                const next = fn(v);
                if (first || next !== last) {
                    first = false;
                    last = next;
                    cb(next);
                }
            });
        },
    };
}

// ── приглашения и адреса ─────────────────────────────────────────────────────
export function normalizeServerUrl(input) {
    let u = String(input || "").trim();
    if (!u) return "";
    u = u.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
    if (!/^wss?:\/\//i.test(u)) {
        // «26.1.2.3:8787» и «localhost:8787» — это сервер в локальной/виртуальной сети (без TLS),
        // а «имя.onrender.com» — обычный сайт с шифрованием
        const host = u.split(/[/:?#]/)[0];
        const plain = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
        u = (plain ? "ws://" : "wss://") + u;
    }
    return u.replace(/\/+$/, "");
}

/** Обычный (незашифрованный) ws:// — сервер в локальной или виртуальной сети. */
export function isPlainWs(url) {
    return /^ws:\/\//i.test(String(url || ""));
}

/**
 * Открывает сокет. Незашифрованный ws:// защищённая страница приложения открыть не может,
 * поэтому там, где есть мост главного процесса (window.wsBridge), используем его.
 */
export function defaultMakeSocket(url, WS) {
    if (isPlainWs(url) && globalThis.wsBridge) return new BridgeSocket(url, globalThis.wsBridge);
    return new WS(url);
}

export function httpUrlFor(wsUrl) {
    return normalizeServerUrl(wsUrl).replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

/** Принимает код, ссылку anixflow-join://КОД?server=… или текст приглашения целиком. */
export function parseInvite(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    const link = raw.match(/anixflow(?:-join)?:\/\/(?:join\/)?([A-Za-z0-9]{4,12})(?:\?([^\s]*))?/i);
    if (link) {
        const code = link[1].toUpperCase();
        let server = null;
        if (link[2]) {
            const m = link[2].match(/(?:^|&)server=([^&\s]+)/i);
            if (m) {
                try { server = normalizeServerUrl(decodeURIComponent(m[1])); } catch (_) {}
            }
        }
        return CODE_RE.test(code) ? { code, server } : null;
    }

    const bare = raw.toUpperCase().replace(/[\s-]/g, "");
    if (CODE_RE.test(bare)) return { code: bare, server: null };

    // код где-то внутри текста приглашения: «Код комнаты: K7F4-QD2M»
    const upper = raw.toUpperCase();
    const grouped = upper.match(/\b([A-HJKMNP-Z2-9]{4})-([A-HJKMNP-Z2-9]{4})\b/);
    if (grouped) return { code: grouped[1] + grouped[2], server: null };
    const inText = upper.match(/\b([A-HJKMNP-Z2-9]{8}|[A-HJKMNP-Z2-9]{6})\b/);
    return inText ? { code: inText[1], server: null } : null;
}

/** K7F4QD2M → K7F4-QD2M (так код проще читать и диктовать) */
export function formatCode(code) {
    const c = String(code || "");
    return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function buildInvite(code, serverUrl) {
    const server = normalizeServerUrl(serverUrl);
    const link = `anixflow-join://${code}` + (server ? `?server=${encodeURIComponent(server)}` : "");
    const text = `Смотрим аниме вместе в AniXFlow! Код комнаты: ${formatCode(code)}\n${link}`;
    return { code, link, text };
}

/** Ключ серии: по нему понимаем, что у хоста и у нас — одна и та же серия. */
export function mediaKey(m) {
    if (!m) return null;
    return [m.releaseId, m.dubberId ?? "-", m.sourceId ?? "-", m.episodePos].join(":");
}

/** Описание серии для комнаты из аргументов плеера. */
export function buildMediaDescriptor(args, episode, source) {
    const src = source || (typeof episode?.source === "object" ? episode.source : null);
    const isMock = !src || src.id === 0 || src.name === "Offline";
    const rel = args?.release || {};
    return {
        releaseId: rel.id ?? args?.id,
        title: rel.title_ru || rel.title_original || rel.title || "",
        dubberId: isMock ? null : (src.type?.id ?? null),
        dubberName: isMock ? "" : (src.type?.name ?? ""),
        sourceId: isMock ? null : (src.id ?? null),
        sourceName: isMock ? "" : (src.name ?? ""),
        episodePos: episode?.position ?? episode?.id ?? 1,
        episodeName: episode?.name ?? "",
        offline: Boolean(args?.isOffline && String(episode?.url || "").startsWith("anixflow://")),
    };
}

function safeStorage() {
    try {
        return globalThis.localStorage || null;
    } catch (_) {
        return null;
    }
}

function randomId(len = 20) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    const arr = new Uint8Array(len);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(arr);
    else for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
    return out;
}

const initialState = () => ({
    phase: "idle", // idle | connecting | waking | connected | reconnecting
    code: null,
    mid: null,
    hostMid: null,
    isHost: false,
    members: [],
    settings: { guestsCanControl: false, waitForStalls: true },
    media: null,
    epoch: 0, // номер «поколения» серии: команды с другим номером сервер игнорирует
    chat: [], // сообщения чата комнаты (последние 100)
    room: null, // последнее авторитетное состояние воспроизведения
    waitingNames: [],
    error: null,
    notice: null,
    serverUrl: "",
    rtt: null,
});

export class SyncClient {
    constructor(opts = {}) {
        this.WS = opts.WebSocket || globalThis.WebSocket;
        this.makeSocket = opts.makeSocket || ((url) => defaultMakeSocket(url, this.WS));
        this.fetchFn = opts.fetch || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
        this.nowFn = opts.now || Date.now;
        this.storage = opts.storage === undefined ? safeStorage() : opts.storage;
        this.timing = {
            connectTimeout: 8000,
            wakeTimeout: 75000,
            wakePoll: 3000,
            pingEvery: 5000,
            reconnectDelays: [1000, 2000, 3000, 5000],
            reconnectGiveUpMs: 5 * 60 * 1000,
            ...(opts.timing || {}),
        };

        this.store = createStore(initialState());
        this.subscribe = this.store.subscribe;
        this.listeners = new Map();

        this.cid = this._loadCid();
        this.ws = null;
        this.offset = 0;
        this.samples = [];
        this.entry = null; // {kind, code, name}
        this.pending = null; // {resolve, reject}
        this.intentionalClose = false;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.reconnectStartedAt = 0;
        this.attemptToken = 0;

        /** ключ серии, которая сейчас загружена в плеере (его выставляет VideoSync) */
        this.loadedMediaKey = null;
        this.openingKey = null;
        this.openingSince = 0;
    }

    // ── настройки ───────────────────────────────────────────────────
    getSettings() {
        let s = {};
        try { s = JSON.parse(this.storage?.getItem(SETTINGS_KEY) || "{}") || {}; } catch (_) {}
        return {
            serverUrl: normalizeServerUrl(s.serverUrl || DEFAULT_SERVER_URL),
            name: s.name || "",
            preferOffline: s.preferOffline !== false,
            chatToasts: s.chatToasts !== false,
        };
    }

    saveSettings(patch) {
        const next = { ...this.getSettings(), ...patch };
        try { this.storage?.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (_) {}
        return next;
    }

    displayName() {
        const saved = this.getSettings().name;
        if (saved) return saved;
        try {
            const p = globalThis.profileInfo;
            if (p && typeof p.login === "string" && p.login) return p.login;
        } catch (_) {}
        return "Гость";
    }

    _loadCid() {
        let cid = null;
        try { cid = this.storage?.getItem(CID_KEY); } catch (_) {}
        if (!cid || !/^[A-Za-z0-9_-]{12,64}$/.test(cid)) {
            cid = randomId(24);
            try { this.storage?.setItem(CID_KEY, cid); } catch (_) {}
        }
        return cid;
    }

    // ── события ─────────────────────────────────────────────────────
    on(evt, fn) {
        if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
        this.listeners.get(evt).add(fn);
        return () => this.listeners.get(evt)?.delete(fn);
    }

    _emit(evt, data) {
        for (const fn of [...(this.listeners.get(evt) || [])]) {
            try { fn(data); } catch (e) { console.error("[WatchTogether] listener error:", e); }
        }
    }

    _patch(p) {
        this.store.update((s) => ({ ...s, ...p }));
    }

    get snapshot() {
        return this.store.get();
    }

    get inRoom() {
        const p = this.snapshot.phase;
        return p === "connected" || p === "reconnecting";
    }

    get canControl() {
        const s = this.snapshot;
        return this.inRoom && (s.isHost || s.settings.guestsCanControl);
    }

    serverNow() {
        return this.nowFn() + this.offset;
    }

    // ── вход / выход ────────────────────────────────────────────────
    createRoom() {
        return this._start({ kind: "create" });
    }

    joinRoom(input) {
        const inv = typeof input === "string" ? parseInvite(input) : input;
        if (!inv?.code) return Promise.reject(new Error("Не удалось распознать код комнаты"));
        if (inv.server) this.saveSettings({ serverUrl: inv.server });
        return this._start({ kind: "join", code: inv.code });
    }

    async _start(entry) {
        if (this.inRoom || this.snapshot.phase === "connecting" || this.snapshot.phase === "waking") {
            throw new Error("Вы уже в комнате или подключаетесь");
        }
        const serverUrl = this.getSettings().serverUrl;
        if (!serverUrl) throw new Error("Не указан адрес сервера синхронизации");
        this.entry = { ...entry, name: this.displayName() };
        this.intentionalClose = false;
        this._patch({ ...initialState(), phase: "connecting", serverUrl });

        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
            this._connectWithWake(serverUrl).catch((e) => this._failStart(e));
        });
    }

    _failStart(err) {
        const p = this.pending;
        this.pending = null;
        this._closeSocket();
        this._patch({ ...initialState(), error: err.message || String(err), serverUrl: this.getSettings().serverUrl });
        if (p) p.reject(err);
    }

    async _connectWithWake(serverUrl) {
        const token = ++this.attemptToken;
        try {
            await this._openSocket(serverUrl, this.timing.connectTimeout, token);
            return;
        } catch (firstErr) {
            if (token !== this.attemptToken || this.intentionalClose) throw firstErr;
            if (isPlainWs(serverUrl)) {
                // сервер в локальной/виртуальной сети не «спит»: будить нечего, причина в сети или адресе
                throw new Error(
                    "Не удалось подключиться к серверу. Проверьте, что сервер запущен, что Radmin VPN (или ZeroTier) " +
                    "подключён у обоих и что Windows разрешила AniXFlow принимать подключения (брандмауэр)."
                );
            }
        }
        // бесплатные хостинги «засыпают»: будим запросом на /health и пробуем снова
        this._patch({ phase: "waking" });
        const woke = await this._wakeUp(serverUrl, token);
        if (token !== this.attemptToken || this.intentionalClose) throw new Error("Подключение отменено");
        if (!woke) throw new Error("Сервер не отвечает. Проверьте адрес в настройках или попробуйте позже.");
        this._patch({ phase: "connecting" });
        await this._openSocket(serverUrl, this.timing.connectTimeout + 7000, token);
    }

    async _wakeUp(serverUrl, token) {
        if (isPlainWs(serverUrl)) return false;
        if (!this.fetchFn) return true; // будить нечем — просто пробуем подключиться
        const url = httpUrlFor(serverUrl) + "/health";
        const deadline = this.nowFn() + this.timing.wakeTimeout;
        while (this.nowFn() < deadline) {
            if (token !== this.attemptToken || this.intentionalClose) return false;
            const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const t = setTimeout(() => ctrl?.abort(), 10000);
            try {
                // свой signal нужен, чтобы глобальный 8-секундный таймаут приложения не мешал
                const res = await this.fetchFn(url, ctrl ? { signal: ctrl.signal, cache: "no-store" } : {});
                clearTimeout(t);
                if (res.ok) return true;
            } catch (_) {
                clearTimeout(t);
            }
            await new Promise((r) => setTimeout(r, this.timing.wakePoll));
        }
        return false;
    }

    _openSocket(serverUrl, timeoutMs, token) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let ws;
            try {
                ws = this.makeSocket(serverUrl);
            } catch (e) {
                return reject(new Error("Неверный адрес сервера"));
            }
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch (_) {}
                reject(new Error("Сервер не ответил вовремя"));
            }, timeoutMs);

            ws.onopen = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (token !== this.attemptToken || this.intentionalClose) {
                    try { ws.close(); } catch (_) {}
                    return reject(new Error("Подключение отменено"));
                }
                this._attachSocket(ws);
                resolve();
            };
            ws.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error("Не удалось подключиться к серверу"));
            };
        });
    }

    _attachSocket(ws) {
        this._closeSocket();
        this.ws = ws;
        this.samples = [];
        ws.onmessage = (ev) => this._onMessage(ev.data);
        ws.onclose = () => this._onClose(ws);
        ws.onerror = () => {};
        this._ping();
        // первые замеры часов делаем чаще, потом — раз в несколько секунд
        [150, 350, 650].forEach((ms) => setTimeout(() => ws === this.ws && this._ping(), ms));
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this._ping(), this.timing.pingEvery);
    }

    _closeSocket() {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            ws.onclose = null;
            ws.onmessage = null;
            try { ws.close(); } catch (_) {}
        }
    }

    _ping() {
        this._send({ t: "ping", c: this.nowFn() });
    }

    _send(obj) {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return false;
        try {
            ws.send(JSON.stringify(obj));
            return true;
        } catch (_) {
            return false;
        }
    }

    _sendEntry() {
        const e = this.entry;
        if (!e) return;
        if (e.kind === "create") this._send({ t: "create", cid: this.cid, name: e.name });
        else this._send({ t: "join", cid: this.cid, code: e.code, name: e.name });
    }

    leave() {
        this.intentionalClose = true;
        this.attemptToken++;
        clearTimeout(this.reconnectTimer);
        this._send({ t: "leave" });
        const p = this.pending;
        this.pending = null;
        this.entry = null;
        this.loadedMediaKey = null;
        this.openingKey = null;
        // даём сообщению «leave» уйти, затем закрываем
        const ws = this.ws;
        setTimeout(() => { if (this.ws === ws) this._closeSocket(); }, 50);
        this._patch({ ...initialState(), serverUrl: this.getSettings().serverUrl });
        this._emit("left");
        if (p) p.reject(new Error("Подключение отменено"));
    }

    // ── входящие сообщения ──────────────────────────────────────────
    _onMessage(data) {
        let m;
        try { m = JSON.parse(data); } catch (_) { return; }
        switch (m.t) {
            case "pong": return this._onPong(m);
            case "welcome": return this._onWelcome(m);
            case "members": return this._onMembers(m);
            case "state": return this._onState(m);
            case "chat": return this._onChat(m);
            case "settings": this._patch({ settings: m.settings }); this._emit("settings", m.settings); return;
            case "error": return this._onError(m);
        }
    }

    _onPong(m) {
        const t2 = this.nowFn();
        const rtt = t2 - m.c;
        if (!(rtt >= 0)) return;
        const offset = m.s + rtt / 2 - t2;
        this.samples.push({ rtt, offset });
        if (this.samples.length > 8) this.samples.shift();
        const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.offset = best.offset;
        this._patch({ rtt: Math.round(best.rtt) });
        // первый замер получен — теперь можно заходить в комнату
        if (this.samples.length === 1 && this.entry && this.snapshot.phase !== "connected") this._sendEntry();
    }

    _onWelcome(m) {
        const rejoined = this.snapshot.phase === "reconnecting";
        if (!this.samples.length) this.offset = m.serverNow - this.nowFn();
        this.reconnectStartedAt = 0;
        this.entry = { kind: "join", code: m.code, name: this.entry?.name || this.displayName() };
        this._patch({
            phase: "connected",
            code: m.code,
            mid: m.mid,
            hostMid: m.host,
            isHost: m.host === m.mid,
            members: m.members,
            settings: m.settings,
            media: m.media,
            epoch: m.state?.ep ?? 0,
            chat: Array.isArray(m.chat) ? m.chat.slice(-100) : [],
            room: m.state,
            waitingNames: this._names(m.state.waiting, m.members),
            error: null,
            notice: null,
        });
        const p = this.pending;
        this.pending = null;
        if (p) p.resolve(m);
        this._emit("welcome", { ...m, rejoined });
        if (m.media) this._maybeOpenMedia(m.media);
    }

    _names(mids, members) {
        const byMid = new Map((members || []).map((x) => [x.mid, x.name]));
        return (mids || []).map((id) => byMid.get(id)).filter(Boolean);
    }

    _onMembers(m) {
        const prev = this.snapshot;
        const isHost = m.host === prev.mid;
        this._patch({ members: m.members, hostMid: m.host, isHost });
        if (isHost !== prev.isHost) {
            this.setNotice(isHost ? "Вы стали хостом комнаты" : "Хост комнаты изменился");
            this._emit("hostChanged", { isHost });
        }
        this._emit("members", m);
    }

    _onChat(m) {
        const msg = { id: m.id, mid: m.mid, name: m.name, text: m.text, ts: m.ts };
        const prev = this.snapshot.chat;
        if (prev.some((x) => x.id === msg.id)) return;
        this._patch({ chat: [...prev, msg].slice(-100) });
        this._emit("chat", { ...msg, mine: msg.mid === this.snapshot.mid });
    }

    _onState(m) {
        const patch = { room: m, waitingNames: this._names(m.waiting, this.snapshot.members) };
        if (m.ep !== undefined) patch.epoch = m.ep;
        if (m.media) patch.media = m.media;
        this._patch(patch);
        this._emit("state", m);
        if (m.media) this._maybeOpenMedia(m.media);
    }

    _onError(m) {
        if (this.pending) {
            return this._failStart(new Error(m.message || m.code));
        }
        if (m.code === "room_not_found" && this.snapshot.phase === "reconnecting") {
            this._closeSocket();
            this.entry = null;
            this._patch({ ...initialState(), error: "Комната уже закрыта", serverUrl: this.getSettings().serverUrl });
            this._emit("left");
            return;
        }
        if (m.code === "rate_limited") return;
        this._patch({ error: m.message || m.code });
        this._emit("error", m);
    }

    _onClose(ws) {
        if (ws !== this.ws) return;
        this.ws = null;
        clearInterval(this.pingTimer);
        if (this.intentionalClose) return;
        if (this.pending) return this._failStart(new Error("Соединение с сервером потеряно"));
        if (this.snapshot.phase === "connected" || this.snapshot.phase === "reconnecting") {
            if (!this.reconnectStartedAt) this.reconnectStartedAt = this.nowFn();
            this._patch({ phase: "reconnecting" });
            this._emit("disconnected");
            this._scheduleReconnect(0);
        }
    }

    _scheduleReconnect(attempt) {
        clearTimeout(this.reconnectTimer);
        if (this.nowFn() - this.reconnectStartedAt > this.timing.reconnectGiveUpMs) {
            this._closeSocket();
            this.entry = null;
            this._patch({ ...initialState(), error: "Не удалось восстановить соединение", serverUrl: this.getSettings().serverUrl });
            this._emit("left");
            return;
        }
        const delays = this.timing.reconnectDelays;
        const delay = delays[Math.min(attempt, delays.length - 1)];
        this.reconnectTimer = setTimeout(async () => {
            if (this.intentionalClose || this.snapshot.phase !== "reconnecting") return;
            const token = ++this.attemptToken;
            try {
                await this._openSocket(this.snapshot.serverUrl || this.getSettings().serverUrl, this.timing.connectTimeout, token);
                // _sendEntry вызовется после первого pong
            } catch (_) {
                if (!this.intentionalClose && this.snapshot.phase === "reconnecting") this._scheduleReconnect(attempt + 1);
            }
        }, delay);
    }

    // ── автооткрытие серии у гостя ──────────────────────────────────
    _maybeOpenMedia(media) {
        const key = mediaKey(media);
        if (!key || key === this.loadedMediaKey) return;
        const now = this.nowFn();
        if (this.openingKey === key && now - this.openingSince < 20000) return;
        this.openingKey = key;
        this.openingSince = now;
        this._emit("openMedia", media);
    }

    /** Плеер сообщает, какая серия у него загружена. */
    setLoadedMedia(media) {
        this.loadedMediaKey = mediaKey(media);
        if (this.loadedMediaKey === this.openingKey) this.openingKey = null;
    }

    clearLoadedMedia() {
        this.loadedMediaKey = null;
    }

    // ── команды ─────────────────────────────────────────────────────
    // epoch в каждой команде: если серия успела смениться, сервер отбросит команду как устаревшую
    sendPlay(pos) { return this._send({ t: "play", pos, ts: this.serverNow(), ep: this.snapshot.epoch }); }
    sendPause(pos) { return this._send({ t: "pause", pos, ep: this.snapshot.epoch }); }
    sendSeek(pos) { return this._send({ t: "seek", pos, ep: this.snapshot.epoch }); }
    sendRate(rate, pos) { return this._send({ t: "rate", rate, pos, ts: this.serverNow(), ep: this.snapshot.epoch }); }
    sendMedia(media, pos = 0, play = true) { return this._send({ t: "media", media, pos, play }); }
    sendReady(ready, pos, seq) {
        const msg = { t: "ready", ready, pos, seq, ep: this.snapshot.epoch };
        // ключ серии, открытой в плеере: сервер не примет «готов», если там другая серия
        if (this.loadedMediaKey) msg.mk = this.loadedMediaKey;
        return this._send(msg);
    }
    sendUnavailable(on) { return this._send({ t: "unavailable", on }); }
    sendMeta(duration) { return this._send({ t: "meta", duration }); }
    setGuestsCanControl(on) { return this._send({ t: "settings", guestsCanControl: !!on }); }
    setWaitForStalls(on) { return this._send({ t: "settings", waitForStalls: !!on }); }
    transferHost(mid) { return this._send({ t: "transfer", to: mid }); }
    renameSelf(name) { return this._send({ t: "name", name }); }

    /** Сообщение в чат комнаты. Возвращает true, если оно ушло на сервер. */
    sendChat(text) {
        const t = String(text || "").trim();
        if (!t || !this.inRoom) return false;
        return this._send({ t: "chat", text: Array.from(t).slice(0, 300).join("") });
    }

    setNotice(text) {
        this._patch({ notice: text });
        clearTimeout(this._noticeTimer);
        this._noticeTimer = setTimeout(() => this._patch({ notice: null }), 5000);
    }

    invite() {
        const s = this.snapshot;
        return s.code ? buildInvite(s.code, s.serverUrl) : null;
    }
}

// ── глобальный экземпляр и производные store'ы ───────────────────────────────
export const client = new SyncClient();
export const watch = client; // $watch в компонентах Svelte

/** гость, которому нельзя управлять воспроизведением (пауза, перемотка) */
export const syncPlaybackLocked = derived(client.store, (s) =>
    (s.phase === "connected" || s.phase === "reconnecting") && !(s.isHost || s.settings.guestsCanControl));

/** гость, которому нельзя менять серию/озвучку */
export const syncMediaLocked = derived(client.store, (s) =>
    (s.phase === "connected" || s.phase === "reconnecting") && !s.isHost);

/** открыто ли поле ввода чата в плеере */
export const chatOpen = createStore(false);

export const syncInRoom = derived(client.store, (s) => s.phase === "connected" || s.phase === "reconnecting");
