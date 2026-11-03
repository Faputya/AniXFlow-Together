/**
 * Совместный просмотр — открытие серии у гостя.
 *
 * Когда хост выбирает серию, клиент присылает событие openMedia. Здесь мы находим
 * ту же серию и озвучку через API Anixart (или берём скачанный файл) и открываем плеер.
 */
import { Pages } from "../../pages.js";
import utils from "../../utils.js";
import { client, parseInvite } from "./watchTogether.js";

let initialized = false;
let openToken = 0;

function hexPath(p) {
    return Array.from(new TextEncoder().encode(p))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function epPos(ep) {
    return ep?.position ?? ep?.id;
}

async function loadLibrary() {
    try {
        return (await window.offlineApi?.getLibrary?.()) || [];
    } catch (_) {
        return [];
    }
}

async function loadRelease(releaseId) {
    try {
        const r = await window.anixApi.release.info(releaseId, true);
        return r?.release ?? null;
    } catch (e) {
        console.warn("[WatchTogether] release.info failed:", e);
        return null;
    }
}

async function loadEpisodes(media) {
    if (media.dubberId == null || media.sourceId == null) return null;
    try {
        const res = await window.anixApi.release.getEpisodes(media.releaseId, media.dubberId, media.sourceId);
        const list = res?.episodes ?? null;
        if (list) utils.sortEpisodes(list);
        return list;
    } catch (e) {
        console.warn("[WatchTogether] getEpisodes failed:", e);
        return null;
    }
}

/**
 * Собирает аргументы для страницы плеера (как это делает список серий на странице релиза).
 * Возвращает { args } или { error } с понятным текстом.
 */
export async function resolvePlayerArgs(media, { preferOffline = true } = {}) {
    const [library, release, episodes] = await Promise.all([
        loadLibrary(),
        loadRelease(media.releaseId),
        loadEpisodes(media),
    ]);

    const onlineEp = episodes ? episodes.find((e) => epPos(e) == media.episodePos) : null;
    const lib = library.find((a) => a.id === media.releaseId);
    const libEp = lib?.episodes?.find((e) => e.id === media.episodePos);
    const releaseObj = release || {
        id: media.releaseId,
        title_ru: media.title || lib?.title || "Аниме",
        title_original: media.title || lib?.title || "",
    };

    // скачанная серия: берём файл (так же, как при запуске из списка серий)
    if (libEp && (preferOffline || !onlineEp)) {
        let eps;
        let current;
        if (episodes && onlineEp) {
            eps = episodes.map((ep) => {
                const m = lib.episodes.find((e) => e.id === epPos(ep));
                return m ? { ...ep, url: `anixflow://${hexPath(m.filePath)}`, isOffline: true } : ep;
            });
            current = eps.find((e) => epPos(e) == media.episodePos);
        } else {
            const mockSource = { id: 0, name: "Offline", type: { id: 0, name: "Оффлайн" }, "@id": 0 };
            eps = lib.episodes.map((e) => ({
                position: e.id,
                name: e.title,
                source: mockSource,
                url: `anixflow://${hexPath(e.filePath)}`,
            }));
            current = eps.find((e) => e.position == media.episodePos);
        }
        const offlineUrl = current.url;
        return {
            args: {
                src: offlineUrl,
                currentQuality: 720,
                availableQuality: { 720: { src: offlineUrl } },
                release: releaseObj,
                episodes: eps,
                currentEpisode: current,
                isOffline: true,
            },
            offline: true,
        };
    }

    if (!onlineEp) {
        const what = media.dubberName ? ` в озвучке «${media.dubberName}»` : "";
        return {
            error: media.dubberId == null
                ? "Хост смотрит скачанную серию, которой нет у вас. Скачайте её или попросите хоста запустить серию из онлайн-списка."
                : `Не нашли серию «${media.episodeName || media.episodePos}»${what}. Возможно, у вас она недоступна.`,
        };
    }

    // онлайн: ссылку на видео плеер получит сам (playVideo), если src не задан
    return {
        args: {
            src: "",
            currentQuality: String(readPlayingSettings()?.defaultQuality || "720"),
            availableQuality: {},
            release: releaseObj,
            episodes,
            currentEpisode: onlineEp,
        },
        offline: false,
    };
}

function readPlayingSettings() {
    try {
        return JSON.parse(localStorage.getItem("playingSettings") || "{}") || {};
    } catch (_) {
        return {};
    }
}

function markWatched(media) {
    try {
        const ps = readPlayingSettings();
        if (ps.disableHistory || !window.anixApi?.client?.token || media.sourceId == null) return;
        window.anixApi.release.markEpisodeAsWatched(media.releaseId, media.sourceId, media.episodePos)?.catch?.(() => {});
        window.anixApi.release.addToHistory(media.releaseId, media.sourceId, media.episodePos)?.catch?.(() => {});
    } catch (_) {}
}

function toUser(text) {
    client.setNotice(text);
    try {
        window.notify?.send?.({ title: "Совместный просмотр", body: text, message: text });
    } catch (_) {}
}

export async function openMedia(media) {
    const token = ++openToken;
    try {
        const { args, error, offline } = await resolvePlayerArgs(media, {
            preferOffline: client.getSettings().preferOffline,
        });
        if (token !== openToken || !client.inRoom) return;
        if (error) {
            client.sendUnavailable(true); // остальные не будут нас ждать
            toUser(error);
            return;
        }
        if (!offline) markWatched(media);
        window.updateViewportComponent?.(Pages.PLAYER, args);
    } catch (e) {
        console.error("[WatchTogether] openMedia failed:", e);
        client.sendUnavailable(true);
        toUser("Не удалось открыть серию, выбранную хостом");
    }
}

/** Вход по приглашению из ссылки anixflow-join://… (приходит из главного процесса). */
export async function joinFromInvite(text) {
    const inv = parseInvite(text);
    if (!inv) return;
    if (client.inRoom) {
        client.setNotice("Вы уже в комнате — сначала выйдите из неё");
        return;
    }
    try {
        await client.joinRoom(inv);
    } catch (e) {
        toUser(e.message || "Не удалось войти в комнату");
    }
}

export function initWatchTogetherNav() {
    if (initialized) return;
    initialized = true;
    client.on("openMedia", (media) => openMedia(media));
    client.on("left", () => { openToken++; });

    try {
        window.watchApi?.onInvite?.((text) => joinFromInvite(text));
        window.watchApi?.getPendingInvite?.().then((text) => { if (text) joinFromInvite(text); }).catch(() => {});
    } catch (_) {}
}
