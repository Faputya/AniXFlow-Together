<script>
    import { createEventDispatcher } from "svelte";
    import { watch } from "../stores/watchTogether.js";

    const dispatch = createEventDispatcher();

    $: s = $watch;
    $: inRoom = s.phase === "connected" || s.phase === "reconnecting";
    $: line =
        s.phase === "reconnecting"
            ? "Переподключение…"
            : s.waitingNames.length
              ? `Ждём: ${s.waitingNames.join(", ")}`
              : s.notice || "";
</script>

{#if inRoom}
    <div class="wt-badge flex-column">
        <button
            class="wt-pill flex-row"
            title="Комната для совместного просмотра"
            onclick={(e) => {
                e.stopPropagation();
                dispatch("open");
            }}
        >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13Zm8 0c-.29 0-.62.02-.97.05A4.2 4.2 0 0 1 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z" />
            </svg>
            <span>{s.members.length}</span>
            <span class="wt-role">{s.isHost ? "хост" : "гость"}</span>
        </button>
        {#if line}
            <div class="wt-line" class:wait={s.waitingNames.length > 0 || s.phase === "reconnecting"}>{line}</div>
        {/if}
    </div>
{/if}

<style>
    .wt-badge {
        position: absolute;
        top: 18px;
        right: 24px;
        z-index: 4;
        align-items: flex-end;
        gap: 6px;
    }

    .wt-pill {
        align-items: center;
        gap: 7px;
        height: 30px;
        padding: 0 14px;
        border-radius: 15px;
        color: #fff;
        font-size: 13px;
        background-color: rgba(30, 30, 30, 0.75);
        border: 1px solid rgba(255, 255, 255, 0.18);
        backdrop-filter: blur(8px);
        transition: background-color 0.2s;
    }

    .wt-pill:hover {
        background-color: rgba(60, 60, 60, 0.9);
    }

    .wt-role {
        opacity: 0.7;
    }

    .wt-line {
        padding: 5px 12px;
        border-radius: 12px;
        font-size: 12px;
        color: #fff;
        background-color: rgba(30, 30, 30, 0.75);
        backdrop-filter: blur(8px);
    }

    .wt-line.wait {
        background-color: rgba(223, 150, 14, 0.9);
    }
</style>
