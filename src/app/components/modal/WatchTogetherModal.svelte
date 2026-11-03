<script>
    import BaseModal from "./BaseModal.svelte";
    import WatchTogetherPanel from "../watch/WatchTogetherPanel.svelte";

    export let showed = false;
</script>

<BaseModal
    modalComponent={WatchTogetherPanel}
    {showed}
    modalSize={{ width: "540px", height: "auto" }}
    on:closeModal
/>
