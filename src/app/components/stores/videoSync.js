/**
 * Привязка комнаты к <video>.
 *
 * Принципы:
 *  - состояние комнаты ({playing,pos,at,rate}) считается истиной для всех;
 *  - команды отправляют только те, кому разрешено (хост, либо все, если хост разрешил);
 *  - действия самого плеера (play/pause/currentTime, которые вызвали МЫ) не считаются действиями пользователя;
 *  - раз в LOOP_MS сверяем реальную позицию с ожидаемой: небольшой дрейф гасим скоростью ±6 %,
 *    большой — перемоткой;
 *  - буферизация у любого участника останавливает всех (сервер ждёт «готов»).
 */
import { mediaKey } from "./watchTogether.js";

export const SYNC_CONFIG = Object.freeze({
    HARD_SEEK_S: 1.5, // больше — перематываем
    SOFT_START_S: 0.25, // больше — подстраиваем скоростью
    SOFT_STOP_S: 0.08, // меньше — возвращаем обычную скорость
    SOFT_FACTOR: 0.04, // базовая поправка скорости...
    SOFT_SLOPE: 0.06, // ...растёт с расхождением (на 1 с — ещё +6 %)...
    SOFT_MAX: 0.12, // ...но не больше ±12 %
    LOOP_MS: 400,
    STALL_POLL_MS: 150, // как часто проверяем, «стоит ли» видео
    STALL_REPORT_MS: 1200, // видео стоит без данных дольше — сообщаем комнате (короткие подвисания не в счёт)
    DECODE_STALL_BUFFER_S: 1.0, // данные впереди есть, а видео стоит — это тормозит наш ПК, а не сеть: комнату не останавливаем
    HINT_STALLS: 3, // столько подвисаний за минуту — подсказываем, что делать
    HINT_COOLDOWN_MS: 5 * 60 * 1000,
    SEEK_DEBOUNCE_MS: 180,
    EXPECT_TTL_MS: 3000,
    READY_POLL_MS: 200,
    SEEK_EPS_S: 0.05,
    PAUSED_TOLERANCE_S: 0.5,
});

export class VideoSync {
    /**
     * @param {import('./watchTogether.js').SyncClient} client
     * @param {{toast?:(text:string)=>void}} [hooks]
     * @param {object} [config]
     */
    constructor(client, hooks = {}, config = {}) {
        this.client = client;
        this.hooks = hooks;
        this.cfg = { ...SYNC_CONFIG, ...config };
        this.video = null;
        this.attached = false;

        this.room = null;
        this.lastSeq = 0;
        this.expect = { play: [], pause: [], seek: [], rate: [] };
        this.pending = []; // собственные команды, эхо которых ещё не пришло
        this.seekTimer = null;
        this.startTimer = null;
        this.bufferTimer = null;
        this.stallTimer = null;
        this.stallPos = 0;
        this.stallSince = 0;
        this.stallLog = [];
        this.lastHintAt = 0;
        this.lagToasted = false;
        this.loopTimer = null;
        this.readyTimer = null;
        this.readyPending = false;
        this.notReadyReported = false;
        this.softActive = false;
        this.lastSetRate = 1;
        this.lastToastAt = 0;
        this.offs = [];
        this.handlers = null;
    }

    // ── состояние для UI/Player ─────────────────────────────────────
    get active() { return this.client.inRoom; }
    get canControl() { return this.client.canControl; }
    get isHost() { return this.client.snapshot.isHost; }
    /** гость, которому нельзя менять серию */
    get mediaLocked() { return this.active && !this.isHost; }
    /** гость, которому нельзя управлять воспроизведением */
    get playbackLocked() { return this.active && !this.canControl; }

    // ── жизненный цикл ──────────────────────────────────────────────
    attach(video) {
        if (this.attached) this.detach();
        this.video = video;
        this.attached = true;

        const v = video;
        const h = {
            play: () => this._onPlay(),
            pause: () => this._onPause(),
            seeked: () => this._onSeeked(),
            ratechange: () => this._onRate(),
            waiting: () => this._onWaiting(),
            canplay: () => this._onCanPlay(),
            playing: () => this._onCanPlay(),
            loadedmetadata: () => this._onMetadata(),
        };
        this.handlers = h;
        for (const [evt, fn] of Object.entries(h)) v.addEventListener(evt, fn);

        this.offs.push(this.client.on("state", (m) => this._onState(m)));
        this.offs.push(this.client.on("welcome", () => this._onWelcome()));
        this.offs.push(this.client.on("disconnected", () => this._clearTimers(false)));
        this.offs.push(this.client.on("members", (m) => this._onMembers(m)));

        this.loopTimer = setInterval(() => this._loop(), this.cfg.LOOP_MS);

        if (this.active) {
            this.client.sendUnavailable(false);
            this.room = this.client.snapshot.room;
            this.lastSeq = this.room?.seq || 0;
            this.readyPending = true;
            this._apply(this.room, { force: true });
            this._tryReady();
        }
    }

    detach() {
        if (!this.attached) return;
        const v = this.video;
        if (v && this.handlers) {
            for (const [evt, fn] of Object.entries(this.handlers)) v.removeEventListener(evt, fn);
        }
        this.offs.forEach((off) => off());
        this.offs = [];
        this._clearTimers(true);
        if (this.active) this.client.sendUnavailable(true); // ушли с плеера — остальные нас не ждут
        this.client.clearLoadedMedia();
        this.attached = false;
        this.video = null;
        this.handlers = null;
    }

    _clearTimers(all) {
        clearTimeout(this.seekTimer); this.seekTimer = null;
        clearTimeout(this.startTimer); this.startTimer = null;
        clearTimeout(this.bufferTimer); this.bufferTimer = null;
        clearInterval(this.stallTimer); this.stallTimer = null;
        clearTimeout(this.readyTimer); this.readyTimer = null;
        if (all) { clearInterval(this.loopTimer); this.loopTimer = null; }
    }

    // ── серия ───────────────────────────────────────────────────────
    /**
     * Плеер начал загружать серию. Хост сообщает о ней комнате, гость запоминает ключ.
     * @param {object} media описание серии
     * @param {{pos?:number, play?:boolean}} [start]
     */
    noteMedia(media, start = {}) {
        this.client.setLoadedMedia(media);
        this.notReadyReported = false;
        if (!this.active || !this.isHost) return;
        const roomKey = mediaKey(this.client.snapshot.media);
        if (roomKey === mediaKey(media)) return;
        this._markPending();
        this.client.sendMedia(media, start.pos ?? 0, start.play ?? true);
    }

    // ── события плеера (действия пользователя) ──────────────────────
    _expect(kind) {
        this.expect[kind].push(Date.now() + this.cfg.EXPECT_TTL_MS);
    }

    _consume(kind) {
        const now = Date.now();
        const list = this.expect[kind];
        while (list.length && list[0] < now) list.shift();
        if (!list.length) return false;
        list.shift();
        return true;
    }

    _markPending() {
        this.pending.push(Date.now() + this.cfg.EXPECT_TTL_MS);
    }

    /**
     * Можно ли отправлять команды: в плеере открыта та же серия, что и в комнате.
     * Пока хост переключает серию, старое видео успевает «выстрелить» событиями pause/seeked
     * с позицией из прошлой серии — их отправлять нельзя.
     */
    _canSend() {
        const roomMedia = this.client.snapshot.media;
        if (!roomMedia) return false;
        return this.client.loadedMediaKey === mediaKey(roomMedia);
    }

    _isPending() {
        const now = Date.now();
        while (this.pending.length && this.pending[0] < now) this.pending.shift();
        return this.pending.length > 0 || this.seekTimer != null;
    }

    _toastLocked() {
        if (this.readyPending) return; // идёт загрузка серии — автозапуск плеера не считается действием
        const now = Date.now();
        if (now - this.lastToastAt < 4000) return;
        this.lastToastAt = now;
        this.hooks.toast?.("Воспроизведением управляет хост");
    }

    _onPlay() {
        if (this._consume("play") || !this.active) return;
        if (!this.canControl) { this._toastLocked(); return this._enforce(); }
        if (!this._canSend()) return;
        this._flushSeek();
        this._markPending();
        this.client.sendPlay(this.video.currentTime);
    }

    _onPause() {
        if (this._consume("pause") || !this.active) return;
        if (!this.canControl) { this._toastLocked(); return this._enforce(); }
        if (!this._canSend()) return;
        // перетаскивание таймлайна ставит на паузу — перемотку отправим отдельно
        this._markPending();
        this.client.sendPause(this.video.currentTime);
    }

    _onSeeked() {
        if (this._consume("seek")) {
            if (this.readyPending || this.room?.seek) this._tryReady();
            return;
        }
        if (!this.active) return;
        if (!this.canControl) { this._toastLocked(); return this._enforce(); }
        if (!this._canSend()) return;
        clearTimeout(this.seekTimer);
        this.seekTimer = setTimeout(() => this._flushSeek(), this.cfg.SEEK_DEBOUNCE_MS);
    }

    _flushSeek() {
        if (this.seekTimer == null) return;
        clearTimeout(this.seekTimer);
        this.seekTimer = null;
        if (!this.video || !this.active || !this.canControl || !this._canSend()) return;
        this._markPending();
        this.client.sendSeek(this.video.currentTime);
    }

    _onRate() {
        const v = this.video;
        if (!v || !this.active) return;
        if (Math.abs(v.playbackRate - this.lastSetRate) < 0.001) return;
        if (!this.canControl) return this._enforce();
        if (!this._canSend()) return;
        this.lastSetRate = v.playbackRate;
        this._markPending();
        this.client.sendRate(v.playbackRate, v.currentTime);
    }

    _onMetadata() {
        if (!this.active) return;
        if (Number.isFinite(this.video.duration)) this.client.sendMeta(this.video.duration);
        this.readyPending = true;
        this._apply(this.room, { force: true });
        this._tryReady();
    }

    // ── буферизация и готовность ────────────────────────────────────
    /** Сколько секунд видео буферизовано впереди текущей позиции. */
    _bufferedAhead() {
        const v = this.video;
        const t = v.currentTime;
        const b = v.buffered;
        if (!b) return 0;
        for (let i = 0; i < b.length; i++) {
            if (b.start(i) <= t + 0.15 && b.end(i) > t) return b.end(i) - t;
        }
        return 0;
    }

    _onWaiting() {
        if (!this.active || !this.room?.playing || this.stallTimer) return;
        this.stallSince = Date.now();
        this.stallPos = this.video.currentTime;
        this.stallTimer = setInterval(() => this._checkStall(), this.cfg.STALL_POLL_MS);
    }

    _stopStallWatch() {
        clearInterval(this.stallTimer);
        this.stallTimer = null;
    }

    /**
     * Комнату останавливаем только при настоящей остановке из-за сети: видео стоит на месте
     * дольше STALL_REPORT_MS, данных впереди нет и мы не перематываем сами.
     * Наша собственная подстроечная перемотка и тормоза декодера комнату не останавливают.
     */
    _checkStall() {
        const v = this.video;
        if (!v || !this.active || !this.room?.playing || v.paused || v.seeking || v.readyState >= 3) {
            return this._stopStallWatch();
        }
        if (Math.abs(v.currentTime - this.stallPos) > 0.05) {
            // видео двигалось — это была не остановка, отсчёт заново
            this.stallPos = v.currentTime;
            this.stallSince = Date.now();
            return;
        }
        if (Date.now() - this.stallSince < this.cfg.STALL_REPORT_MS) return;
        this._stopStallWatch();
        this._noteStall();
        if (this._bufferedAhead() >= this.cfg.DECODE_STALL_BUFFER_S) return; // тормозит ПК, а не сеть
        this.notReadyReported = true;
        this.client.sendReady(false, v.currentTime, this.lastSeq);
    }

    /** Подсказка, если видео подвисает снова и снова. */
    _noteStall() {
        const now = Date.now();
        this.stallLog = this.stallLog.filter((t) => now - t < 60000);
        this.stallLog.push(now);
        if (this.stallLog.length >= this.cfg.HINT_STALLS && now - this.lastHintAt > this.cfg.HINT_COOLDOWN_MS) {
            this.lastHintAt = now;
            this.hooks.toast?.("Видео подвисает: попробуйте снизить качество или режим улучшения изображения");
        }
    }

    _onMembers(m) {
        const me = m.members.find((x) => x.mid === this.client.snapshot.mid);
        if (me?.lagging && !this.lagToasted) {
            this.lagToasted = true;
            this.hooks.toast?.("Комната временно не ждёт вас: видео часто подвисает");
        } else if (me && !me.lagging) {
            this.lagToasted = false;
        }
    }

    _onCanPlay() {
        this._stopStallWatch();
        if (this.notReadyReported) {
            this.readyPending = true;
            this._tryReady();
        } else if (this.readyPending) {
            this._tryReady();
        }
    }

    _tryReady() {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
        if (!this.readyPending || !this.attached || !this.active) return;
        const v = this.video;
        if (v && !v.seeking && v.readyState >= 3) {
            this.readyPending = false;
            this.notReadyReported = false;
            this.client.sendReady(true, v.currentTime, this.lastSeq);
        } else {
            this.readyTimer = setTimeout(() => this._tryReady(), this.cfg.READY_POLL_MS);
        }
    }

    // ── входящие состояния ──────────────────────────────────────────
    _onWelcome() {
        // новое подключение или возврат после обрыва — полностью пересинхронизируемся
        this.room = this.client.snapshot.room;
        this.lastSeq = this.room?.seq || 0;
        this.pending = [];
        this.readyPending = true;
        this.client.sendUnavailable(false);
        if (this.video?.readyState >= 1 && Number.isFinite(this.video.duration)) this.client.sendMeta(this.video.duration);
        this._apply(this.room, { force: true });
        this._tryReady();
    }

    _onState(m) {
        if (m.seq != null && m.seq < this.lastSeq) return; // устаревшее
        this.lastSeq = m.seq ?? this.lastSeq;
        this.room = m;
        if (m.by && m.by === this.client.snapshot.mid && this.pending.length) this.pending.shift();
        if (!this.video) return;

        const newMedia = !!m.media;
        if (m.seek || newMedia) this.readyPending = true;
        this._apply(m, { force: !!m.seek || newMedia });
        if (m.seek || newMedia) this._tryReady();
    }

    _expectedPos(st, serverNow) {
        if (!st.playing) return st.pos;
        return st.pos + (Math.max(0, serverNow - st.at) / 1000) * st.rate;
    }

    _doPlay() {
        const v = this.video;
        if (!v || !v.paused) return;
        this._expect("play");
        const p = v.play();
        if (p && p.catch) p.catch(() => { this.expect.play.pop(); });
    }

    _doPause() {
        const v = this.video;
        if (!v || v.paused) return;
        this._expect("pause");
        v.pause();
    }

    _doSeek(t) {
        const v = this.video;
        if (!v) return;
        const target = Math.max(0, Number.isFinite(v.duration) ? Math.min(t, v.duration) : t);
        if (Math.abs(v.currentTime - target) < this.cfg.SEEK_EPS_S) return;
        this._expect("seek");
        v.currentTime = target;
    }

    _setRate(r) {
        const v = this.video;
        if (!v || !(r > 0)) return;
        if (Math.abs(v.playbackRate - r) < 0.001) return;
        this.lastSetRate = r;
        v.playbackRate = r;
    }

    /** Приводит видео к состоянию комнаты. */
    _apply(st, { force = false } = {}) {
        const v = this.video;
        if (!v || !st) return;
        // у комнаты ещё нет серии (хост только создал её) — подстраиваться не к чему
        if (!this.client.snapshot.media) return;
        clearTimeout(this.startTimer);
        this.startTimer = null;
        const now = this.client.serverNow();

        if (!st.playing) {
            this.softActive = false;
            this._setRate(st.rate);
            this._doPause();
            if (force || Math.abs(v.currentTime - st.pos) > this.cfg.PAUSED_TOLERANCE_S) this._doSeek(st.pos);
            return;
        }

        if (st.at > now + 20) {
            // старт назначен на ближайшее будущее: встаём в нужную точку и ждём
            this._setRate(st.rate);
            this._doPause();
            if (Math.abs(v.currentTime - st.pos) > 0.15) this._doSeek(st.pos);
            this.startTimer = setTimeout(() => {
                this.startTimer = null;
                if (this.room === st) this._apply(st, {});
            }, Math.max(0, st.at - now));
            return;
        }

        const expected = this._expectedPos(st, now);
        const diff = v.currentTime - expected;
        if (Math.abs(diff) > (force ? 0.3 : this.cfg.HARD_SEEK_S)) {
            this.softActive = false;
            this._setRate(st.rate);
            this._doSeek(expected);
        }
        if (v.paused && !v.ended) this._doPlay();
    }

    /** Гость сделал недопустимое действие — возвращаем состояние комнаты. */
    _enforce() {
        setTimeout(() => {
            if (this.attached && this.room) this._apply(this.room, {});
        }, 30);
    }

    // ── подстройка дрейфа ───────────────────────────────────────────
    _loop() {
        const v = this.video;
        const st = this.room;
        if (!v || !st || !this.active || !this.client.snapshot.media) return;
        if (v.seeking || this._isPending()) return;
        if (st.at > this.client.serverNow() + 20) return; // ждём назначенного старта

        if (!st.playing) {
            if (!v.paused) this._doPause();
            if (v.readyState >= 1 && Math.abs(v.currentTime - st.pos) > this.cfg.PAUSED_TOLERANCE_S) this._doSeek(st.pos);
            return;
        }
        if (v.ended) return;
        if (v.paused) {
            if (v.readyState >= 1) this._doPlay();
            return;
        }
        if (v.readyState < 3) return; // буферизуемся — не дёргаем

        const expected = this._expectedPos(st, this.client.serverNow());
        const diff = v.currentTime - expected;
        const abs = Math.abs(diff);

        if (abs > this.cfg.HARD_SEEK_S) {
            this.softActive = false;
            this._setRate(st.rate);
            this._doSeek(expected);
            this.readyPending = true; // после перемотки сообщим, когда догрузится
            return;
        }
        if (abs > this.cfg.SOFT_START_S || (this.softActive && abs > this.cfg.SOFT_STOP_S)) {
            this.softActive = true;
            // чем больше расхождение, тем сильнее поправка (до ±12 %): так оно гасится быстрее
            const k = Math.min(this.cfg.SOFT_MAX, this.cfg.SOFT_FACTOR + abs * this.cfg.SOFT_SLOPE);
            this._setRate(st.rate * (diff > 0 ? 1 - k : 1 + k));
        } else {
            this.softActive = false;
            this._setRate(st.rate);
        }
    }
}

export default VideoSync;
