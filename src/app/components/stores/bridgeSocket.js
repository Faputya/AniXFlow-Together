/**
 * Сокет с интерфейсом, похожим на WebSocket, который работает через мост главного процесса.
 * Нужен для ws:// к другим компьютерам (Radmin VPN, ZeroTier и т. п.): защищённая страница приложения
 * не может открыть такое соединение сама. Подробности — в src/wsBridge.js.
 */
export class BridgeSocket {
    /**
     * @param {string} url адрес ws://…
     * @param {{open:Function,send:Function,close:Function,release:Function}} [bridge] по умолчанию window.wsBridge
     */
    constructor(url, bridge = globalThis.wsBridge) {
        this.url = url;
        this.readyState = 0; // 0 подключение, 1 открыто, 2 закрывается, 3 закрыто
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this._bridge = bridge;
        this._id = "ws" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        bridge.open(this._id, url, (e) => this._onEvent(e));
    }

    send(data) {
        if (this.readyState !== 1) throw new Error("Соединение не открыто");
        this._bridge.send(this._id, String(data));
    }

    close(code) {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        this._bridge.close(this._id, code);
    }

    _onEvent(e) {
        switch (e && e.type) {
            case "open":
                this.readyState = 1;
                if (this.onopen) this.onopen({});
                break;
            case "message":
                if (this.onmessage) this.onmessage({ data: e.data });
                break;
            case "error":
                if (this.onerror) this.onerror({});
                break;
            case "close":
                if (this.readyState === 3) break;
                this.readyState = 3;
                try { this._bridge.release(this._id); } catch (_) {}
                if (this.onclose) this.onclose({ code: e.code });
                break;
        }
    }
}

export default BridgeSocket;
