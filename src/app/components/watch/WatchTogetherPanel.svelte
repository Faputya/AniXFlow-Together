<script>
    import { createEventDispatcher } from "svelte";
    import Icon from "../elements/Icon.svelte";
    import CloseIcon from "../../icons/close.svg";
    import BaseMainButton from "../buttons/BaseMainButton.svelte";
    import { watch, client, parseInvite, normalizeServerUrl, buildInvite, formatCode } from "../stores/watchTogether.js";

    export let args = null;
    export let showed = true;

    const dispatch = createEventDispatcher();

    const saved = client.getSettings();
    let serverUrl = saved.serverUrl;
    let name = saved.name;
    let preferOffline = saved.preferOffline;
    let chatToasts = saved.chatToasts;
    let joinInput = "";
    let busy = false;
    let localError = "";
    let copied = "";
    let copiedTimer = null;

    $: s = $watch;
    $: inRoom = s.phase === "connected" || s.phase === "reconnecting";
    $: connecting = s.phase === "connecting" || s.phase === "waking";
    $: hostMember = s.members.find((m) => m.mid === s.hostMid);
    $: hostDuration = hostMember?.duration ?? null;

    function persist() {
        client.saveSettings({
            serverUrl: normalizeServerUrl(serverUrl),
            name: name.trim(),
            preferOffline,
            chatToasts,
        });
    }

    async function createRoom() {
        localError = "";
        busy = true;
        persist();
        try {
            await client.createRoom();
        } catch (e) {
            localError = e.message || String(e);
        }
        busy = false;
    }

    async function joinRoom() {
        localError = "";
        const inv = parseInvite(joinInput);
        if (!inv) {
            localError = "Не похоже на код комнаты. Код состоит из 8 символов, например K7F4-QD2M.";
            return;
        }
        busy = true;
        persist();
        try {
            await client.joinRoom(inv);
            serverUrl = client.getSettings().serverUrl;
        } catch (e) {
            localError = e.message || String(e);
        }
        busy = false;
    }

    function cancelConnect() {
        client.leave();
        busy = false;
    }

    function leaveRoom() {
        client.leave();
        localError = "";
    }

    async function copy(text, label) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); } catch (e) {}
            document.body.removeChild(ta);
        }
        copied = label;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = ""), 2000);
    }

    function statusText(m) {
        if (!m.connected) return "переподключается…";
        if (m.unavailable) return "нет этой серии";
        if (m.lagging) return "комната не ждёт: видео подвисает";
        if (m.status === "joining") return "заходит…";
        if (!m.ready) return "загружает";
        if (hostDuration && m.duration && Math.abs(m.duration - hostDuration) > 3 && m.mid !== s.hostMid) {
            return "другая длина записи";
        }
        return "готов";
    }

    function statusClass(m) {
        if (!m.connected || m.unavailable) return "bad";
        if (m.lagging || m.status === "joining" || !m.ready) return "wait";
        if (hostDuration && m.duration && Math.abs(m.duration - hostDuration) > 3 && m.mid !== s.hostMid) return "warn";
        return "ok";
    }

    function onJoinKey(e) {
        if (e.key === "Enter") joinRoom();
    }

    $: invite = inRoom && s.code ? buildInvite(s.code, s.serverUrl) : null;
</script>

<div class="wt flex-column">
    <div class="wt-head flex-row">
        <span class="wt-title">Смотреть вместе</span>
        <button class="wt-close" title="Закрыть" onclick={() => dispatch("closeModal")}>
            <Icon src={CloseIcon} varColor="--main-text-color" size={{ width: 18, height: 18 }} />
        </button>
    </div>

    {#if inRoom}
        <div class="wt-code-box flex-row">
            <div class="flex-column">
                <span class="wt-label">Код комнаты</span>
                <span class="wt-code">{formatCode(s.code)}</span>
            </div>
            <div class="wt-copy flex-column">
                <BaseMainButton height={32} style="primary" onClickCallback={() => copy(invite.text, "text")}>
                    <span class="wt-btn-text">{copied === "text" ? "Скопировано" : "Скопировать приглашение"}</span>
                </BaseMainButton>
                <button class="wt-link" onclick={() => copy(invite.link, "link")}>
                    {copied === "link" ? "Ссылка скопирована" : "Скопировать только ссылку"}
                </button>
            </div>
        </div>

        {#if s.phase === "reconnecting"}
            <div class="wt-banner wait">Связь с сервером потеряна, переподключаемся…</div>
        {:else if s.waitingNames.length}
            <div class="wt-banner wait">Ждём: {s.waitingNames.join(", ")}</div>
        {:else if s.notice}
            <div class="wt-banner">{s.notice}</div>
        {/if}

        <div class="wt-now">
            {#if s.media}
                <span class="wt-label">Сейчас в комнате</span>
                <span class="wt-now-title">{s.media.title || "Без названия"}</span>
                <span class="wt-now-sub">
                    {s.media.dubberName ? `${s.media.dubberName} | ` : ""}{s.media.episodeName || `Серия ${s.media.episodePos}`}
                </span>
            {:else if s.isHost}
                <span class="wt-now-sub">Откройте любую серию — она автоматически запустится у всех участников.</span>
            {:else}
                <span class="wt-now-sub">Ждём, пока хост выберет серию. Она откроется у вас сама.</span>
            {/if}
        </div>

        <span class="wt-label">Участники ({s.members.length} из 5)</span>
        <div class="wt-members flex-column">
            {#each s.members as m (m.mid)}
                <div class="wt-member flex-row">
                    <span class="wt-dot {statusClass(m)}"></span>
                    <span class="wt-mname">{m.name}{m.mid === s.mid ? " (вы)" : ""}</span>
                    {#if m.mid === s.hostMid}<span class="wt-tag">хост</span>{/if}
                    <span class="wt-mstatus {statusClass(m)}">{statusText(m)}</span>
                    {#if s.isHost && m.mid !== s.mid && m.connected}
                        <button class="wt-link" onclick={() => client.transferHost(m.mid)}>сделать хостом</button>
                    {/if}
                </div>
            {/each}
        </div>

        {#if s.isHost}
            <label class="wt-check flex-row">
                <input
                    type="checkbox"
                    checked={s.settings.guestsCanControl}
                    onchange={(e) => client.setGuestsCanControl(e.currentTarget.checked)}
                />
                <span>Гости тоже могут ставить паузу и перематывать</span>
            </label>
            <label class="wt-check flex-row">
                <input
                    type="checkbox"
                    checked={s.settings.waitForStalls !== false}
                    onchange={(e) => client.setWaitForStalls(e.currentTarget.checked)}
                />
                <span>Останавливать просмотр, если у кого-то зависло видео</span>
            </label>
            <span class="wt-note">Серию и озвучку выбираете только вы.</span>
        {:else}
            <span class="wt-note">
                {s.settings.guestsCanControl
                    ? "Хост разрешил всем ставить паузу и перематывать. Серию и озвучку выбирает хост."
                    : "Воспроизведением, серией и озвучкой управляет хост."}
            </span>
        {/if}

        <label class="wt-check flex-row">
            <input type="checkbox" bind:checked={preferOffline} onchange={persist} />
            <span>Если серия скачана — смотреть из файла</span>
        </label>

        <label class="wt-check flex-row">
            <input type="checkbox" bind:checked={chatToasts} onchange={persist} />
            <span>Показывать новые сообщения чата в углу плеера</span>
        </label>
        <span class="wt-note">В плеере чат открывается клавишей Enter или кнопкой с облачком в панели управления.</span>

        <div class="wt-actions flex-row">
            <BaseMainButton height={34} style="default" onClickCallback={leaveRoom}>
                <span class="wt-btn-text">Выйти из комнаты</span>
            </BaseMainButton>
        </div>
    {:else if connecting}
        <div class="wt-connecting flex-column">
            <span class="wt-spinner"></span>
            <span class="wt-conn-text">
                {s.phase === "waking"
                    ? "Сервер просыпается, это может занять до минуты…"
                    : "Подключаемся к серверу…"}
            </span>
            <BaseMainButton height={32} style="default" onClickCallback={cancelConnect}>
                <span class="wt-btn-text">Отмена</span>
            </BaseMainButton>
        </div>
    {:else}
        <p class="wt-intro">
            Создайте комнату и отправьте друзьям код. Серия, озвучка, пауза и перемотка будут
            одинаковыми у всех — до 5 человек.
        </p>

        <label class="wt-label" for="wt-name">Ваше имя в комнате</label>
        <input id="wt-name" class="wt-input" bind:value={name} maxlength="24" placeholder="Как вас называть" onchange={persist} />

        <label class="wt-label" for="wt-server">Адрес сервера</label>
        <input
            id="wt-server"
            class="wt-input"
            bind:value={serverUrl}
            placeholder="wss://адрес-вашего-сервера"
            spellcheck="false"
            onchange={persist}
        />
        <span class="wt-note">
            Если вас пригласили, адрес приходит вместе с кодом — вводить его не нужно.
        </span>

        <label class="wt-check flex-row">
            <input type="checkbox" bind:checked={preferOffline} onchange={persist} />
            <span>Если серия скачана — смотреть из файла</span>
        </label>

        <div class="wt-actions flex-row">
            <BaseMainButton height={36} style="primary" isLoading={busy} onClickCallback={createRoom}>
                <span class="wt-btn-text">Создать комнату</span>
            </BaseMainButton>
        </div>

        <div class="wt-or flex-row"><span></span><em>или войти по коду</em><span></span></div>

        <div class="wt-join flex-row">
            <input
                class="wt-input grow"
                bind:value={joinInput}
                placeholder="Код или ссылка-приглашение"
                spellcheck="false"
                onkeydown={onJoinKey}
            />
            <BaseMainButton height={36} style="default" isLoading={busy} onClickCallback={joinRoom}>
                <span class="wt-btn-text">Войти</span>
            </BaseMainButton>
        </div>

        {#if localError || s.error}
            <div class="wt-error">{localError || s.error}</div>
        {/if}
    {/if}
</div>

<style>
    .wt {
        box-sizing: border-box;
        padding: 24px 30px 28px;
        gap: 10px;
        color: var(--main-text-color);
        max-height: 82vh;
        overflow-y: auto;
        user-select: none;
    }

    .wt-head {
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
    }

    .wt-title {
        font-size: 24px;
        font-weight: bold;
    }

    .wt-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        transition: background-color 0.2s;
    }

    .wt-close:hover {
        background-color: var(--select-button-left-color);
    }

    .wt-intro {
        margin: 0 0 6px;
        color: var(--secondary-text-color);
        line-height: 1.45;
        font-size: 14px;
    }

    .wt-label {
        font-size: 13px;
        color: var(--secondary-text-color);
        margin-top: 4px;
    }

    .wt-input {
        height: 36px;
        box-sizing: border-box;
        padding: 0 14px;
        border-radius: 18px;
        border: 1px solid transparent;
        background-color: var(--alt-background-color);
        color: var(--main-text-color);
        font-size: 14px;
        outline: none;
        user-select: text;
    }

    .wt-input:focus {
        border-color: var(--third-text-color);
    }

    .grow {
        flex: 1;
        min-width: 0;
    }

    .wt-note {
        font-size: 12px;
        color: var(--third-text-color);
        line-height: 1.4;
    }

    .wt-check {
        align-items: center;
        gap: 10px;
        font-size: 14px;
        cursor: pointer;
        margin-top: 4px;
    }

    .wt-actions {
        margin-top: 8px;
    }

    .wt-btn-text {
        padding: 0 18px;
        font-size: 14px;
        white-space: nowrap;
    }

    .wt-or {
        align-items: center;
        gap: 12px;
        margin: 10px 0 2px;
        color: var(--third-text-color);
        font-size: 12px;
    }

    .wt-or span {
        flex: 1;
        height: 1px;
        background-color: var(--alt-gray-background-color);
    }

    .wt-or em {
        font-style: normal;
    }

    .wt-join {
        gap: 10px;
        align-items: center;
    }

    .wt-error {
        margin-top: 6px;
        padding: 10px 14px;
        border-radius: 12px;
        font-size: 13px;
        line-height: 1.4;
        color: #fff;
        background-color: var(--danger-color);
    }

    .wt-connecting {
        align-items: center;
        gap: 16px;
        padding: 28px 0 8px;
    }

    .wt-conn-text {
        color: var(--secondary-text-color);
        font-size: 14px;
        text-align: center;
    }

    .wt-spinner {
        width: 30px;
        height: 30px;
        border: 3px solid var(--main-text-color);
        border-bottom-color: transparent;
        border-radius: 50%;
        display: inline-block;
        box-sizing: border-box;
        animation: wt-rotation 1s linear infinite;
    }

    @keyframes wt-rotation {
        to { transform: rotate(360deg); }
    }

    .wt-code-box {
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 18px;
        border-radius: 16px;
        background-color: var(--alt-background-color);
    }

    .wt-code {
        font-size: 34px;
        font-weight: bold;
        letter-spacing: 0.18em;
        user-select: text;
    }

    .wt-copy {
        align-items: stretch;
        gap: 6px;
    }

    .wt-link {
        font-size: 12px;
        color: var(--secondary-text-color);
        text-decoration: underline;
        text-underline-offset: 3px;
        padding: 2px 4px;
    }

    .wt-link:hover {
        color: var(--main-text-color);
    }

    .wt-banner {
        padding: 9px 14px;
        border-radius: 12px;
        font-size: 13px;
        background-color: var(--alt-gray-background-color);
    }

    .wt-banner.wait {
        background-color: var(--hold-on-color);
        color: #fff;
    }

    .wt-now {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .wt-now-title {
        font-size: 16px;
        font-weight: 600;
    }

    .wt-now-sub {
        font-size: 13px;
        color: var(--secondary-text-color);
        line-height: 1.4;
    }

    .wt-members {
        gap: 2px;
    }

    .wt-member {
        align-items: center;
        gap: 10px;
        padding: 7px 4px;
        border-bottom: 1px solid var(--alt-gray-background-color);
        font-size: 14px;
    }

    .wt-mname {
        font-weight: 500;
    }

    .wt-tag {
        font-size: 11px;
        padding: 1px 8px;
        border-radius: 10px;
        background-color: var(--main-text-color);
        color: var(--background-color);
    }

    .wt-mstatus {
        margin-left: auto;
        font-size: 12px;
    }

    .wt-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        flex-shrink: 0;
        background-color: var(--gray-btn);
    }

    .wt-dot.ok { background-color: var(--watching-color); }
    .wt-dot.wait { background-color: var(--hold-on-color); }
    .wt-dot.warn { background-color: var(--warning-color); }
    .wt-dot.bad { background-color: var(--dropped-color); }

    .wt-mstatus.ok { color: var(--secondary-text-color); }
    .wt-mstatus.wait { color: var(--hold-on-color); }
    .wt-mstatus.warn { color: var(--warning-color); }
    .wt-mstatus.bad { color: var(--dropped-color); }
</style>
