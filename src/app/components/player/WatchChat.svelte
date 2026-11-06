<script>
    import { onMount, onDestroy, tick } from "svelte";
    import { watch, client, chatOpen } from "../stores/watchTogether.js";

    let toasts = [];
    let draft = "";
    let inputEl;
    let counter = 0;
    const timers = new Map();
    let offChat = null;
    let offError = null;

    $: s = $watch;
    $: inRoom = s.phase === "connected" || s.phase === "reconnecting";
    $: recent = s.chat.slice(-8);
    $: if (!inRoom && $chatOpen) chatOpen.set(false);
    $: if ($chatOpen) focusInput();

    // у каждого участника свой цвет: хеш имени
    function hue(name) {
        let h = 0;
        for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
        return h;
    }

    async function focusInput() {
        await tick();
        if (inputEl) inputEl.focus();
    }

    function pushToast(t) {
        const id = ++counter;
        const lifetime = Math.min(9000, 3500 + (t.text || "").length * 45);
        toasts = [...toasts, { id, leaving: false, ...t }].slice(-3);
        timers.set(id, setTimeout(() => dismiss(id), lifetime));
    }

    function dismiss(id) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
        setTimeout(() => {
            toasts = toasts.filter((t) => t.id !== id);
        }, 240);
    }

    function openChat() {
        for (const id of timers.keys()) clearTimeout(timers.get(id));
        timers.clear();
        toasts = [];
        chatOpen.set(true);
    }

    function closeChat() {
        draft = "";
        chatOpen.set(false);
    }

    function send() {
        const text = draft.trim();
        if (text) client.sendChat(text);
        closeChat();
    }

    function onInputKey(e) {
        if (e.isComposing) return;
        if (e.key === "Enter") {
            e.preventDefault();
            send();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeChat();
        }
        // ввод текста не должен срабатывать как горячие клавиши плеера
        e.stopPropagation();
    }

    function onKey(e) {
        if (!inRoom) return;
        if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
        const el = document.activeElement;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName) || el?.isContentEditable) return;
        if (document.querySelector(".modal-background")) return; // открыто окно комнаты
        e.preventDefault();
        openChat();
    }

    onMount(() => {
        offChat = client.on("chat", (m) => {
            if (m.mine || $chatOpen) return;
            if (!client.getSettings().chatToasts) return;
            pushToast({ name: m.name, text: m.text, hue: hue(m.name) });
        });
        offError = client.on("error", (m) => {
            if (m.code === "chat_rate") pushToast({ system: true, text: "Слишком быстро, подождите немного" });
            else if (m.message === "Неизвестная команда") pushToast({ system: true, text: "Сервер ещё не поддерживает чат" });
        });
        window.addEventListener("keydown", onKey);
    });

    onDestroy(() => {
        if (offChat) offChat();
        if (offError) offError();
        window.removeEventListener("keydown", onKey);
        for (const id of timers.keys()) clearTimeout(timers.get(id));
        timers.clear();
        chatOpen.set(false);
    });
</script>

{#if inRoom}
    <div class="wt-chat">
        {#if $chatOpen}
            <div class="wt-panel">
                <div class="wt-log">
                    {#each recent as m, i (m.id)}
                        <div class="wt-msg" style="opacity: {0.55 + (0.45 * (i + 1)) / recent.length}">
                            <span class="wt-name" style="color: hsl({hue(m.name)} 80% 72%)">{m.name}</span>
                            <span class="wt-text">{m.text}</span>
                        </div>
                    {:else}
                        <div class="wt-msg wt-empty">Сообщений пока нет</div>
                    {/each}
                </div>
                <input
                    bind:this={inputEl}
                    bind:value={draft}
                    class="wt-input"
                    maxlength="300"
                    placeholder="Сообщение: Enter — отправить, Esc — закрыть"
                    spellcheck="false"
                    onkeydown={onInputKey}
                />
            </div>
        {:else}
            {#each toasts as t (t.id)}
                <div
                    class="wt-toast"
                    class:leaving={t.leaving}
                    class:system={t.system}
                    style="--c: hsl({t.hue ?? 0} 80% 62%)"
                >
                    {#if !t.system}
                        <span class="wt-name" style="color: hsl({t.hue} 80% 72%)">{t.name}</span>
                    {/if}
                    <span class="wt-text">{t.text}</span>
                </div>
            {/each}
        {/if}
    </div>
{/if}

<style>
    /* Контейнер не перехватывает клики: плеер под ним остаётся полностью управляемым */
    .wt-chat {
        position: absolute;
        left: 24px;
        bottom: 118px;
        width: min(360px, 42%);
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        z-index: 3;
        pointer-events: none;
    }

    .wt-toast {
        display: flex;
        flex-direction: column;
        gap: 1px;
        max-width: 100%;
        box-sizing: border-box;
        padding: 7px 12px 8px;
        border-radius: 14px;
        border-left: 3px solid var(--c);
        color: #fff;
        background-color: rgba(18, 18, 18, 0.55);
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
        animation: wt-in 0.18s cubic-bezier(0.2, 0.8, 0.2, 1) both;
        word-break: break-word;
    }

    .wt-toast.system {
        border-left-color: rgba(255, 255, 255, 0.35);
        font-size: 13px;
        opacity: 0.9;
    }

    .wt-toast.leaving {
        animation: wt-out 0.22s ease-in both;
    }

    .wt-name {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
    }

    .wt-text {
        font-size: 14px;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        line-clamp: 4;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
    }

    .wt-panel {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: auto;
        animation: wt-in 0.16s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }

    .wt-log {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .wt-msg {
        display: flex;
        flex-direction: column;
        padding: 5px 11px 6px;
        border-radius: 12px;
        color: #fff;
        background-color: rgba(18, 18, 18, 0.5);
        backdrop-filter: blur(8px);
        word-break: break-word;
    }

    .wt-empty {
        font-size: 13px;
        opacity: 0.7;
    }

    .wt-input {
        height: 38px;
        box-sizing: border-box;
        padding: 0 14px;
        border-radius: 19px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        outline: none;
        color: #fff;
        font-size: 14px;
        background-color: rgba(18, 18, 18, 0.72);
        backdrop-filter: blur(10px);
        user-select: text;
    }

    .wt-input::placeholder {
        color: rgba(255, 255, 255, 0.5);
    }

    .wt-input:focus {
        border-color: rgba(255, 255, 255, 0.5);
    }

    @keyframes wt-in {
        from {
            opacity: 0;
            transform: translateX(-18px) scale(0.96);
        }
        to {
            opacity: 0.94;
            transform: none;
        }
    }

    @keyframes wt-out {
        from {
            opacity: 0.94;
        }
        to {
            opacity: 0;
            transform: translateX(-12px);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .wt-toast,
        .wt-panel {
            animation-duration: 1ms;
        }
    }
</style>
