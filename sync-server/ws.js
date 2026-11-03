'use strict';
/**
 * Минимальный WebSocket-сервер (RFC 6455) без зависимостей.
 * Поддерживает: рукопожатие, текстовые фреймы, фрагментацию, ping/pong, close.
 * Бинарные фреймы не нужны — игнорируются.
 */

const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 16 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WsConnection {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.lastPong = Date.now();
    this.onmessage = null;
    this.onclose = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.setNoDelay(true);
  }

  send(obj) {
    if (this.closed) return;
    const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    this._write(encodeFrame(0x1, payload));
  }

  ping() {
    if (!this.closed) this._write(encodeFrame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this._write(encodeFrame(0x8, payload));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  _write(buf) {
    try {
      this.socket.write(buf);
    } catch (_) {
      this._finish();
    }
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (_) {}
    if (this.onclose) this.onclose();
  }

  _fail(code) {
    this.close(code);
    this._finish();
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // защита от переполнения буфера медленным/злонамеренным клиентом
    if (this.buffer.length > MAX_PAYLOAD * 4) return this._fail(1009);

    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (!masked) return this._fail(1002); // клиент обязан маскировать
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this._fail(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_PAYLOAD) return this._fail(1009);
      if (this.buffer.length < offset + 4 + len) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const data = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + len);

      if (opcode >= 0x8) {
        // управляющие фреймы
        if (!fin || len > 125) return this._fail(1002);
        if (opcode === 0x8) {
          this.close(1000);
          this._finish();
          return;
        }
        if (opcode === 0x9) this._write(encodeFrame(0xA, data));
        if (opcode === 0xA) this.lastPong = Date.now();
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        this.fragments = [data];
        this.fragmentOpcode = opcode;
      } else if (opcode === 0x0) {
        if (!this.fragments.length) return this._fail(1002);
        this.fragments.push(data);
      } else {
        return this._fail(1002);
      }

      const total = this.fragments.reduce((n, f) => n + f.length, 0);
      if (total > MAX_PAYLOAD) return this._fail(1009);

      if (fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === 0x1 && this.onmessage) {
          this.onmessage(full.toString('utf8'));
        }
      }
    }
  }
}

/**
 * Обработка HTTP Upgrade. Возвращает WsConnection или null (если запрос некорректен).
 */
function handleUpgrade(req, socket, nextId) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const version = req.headers['sec-websocket-version'];
  if (upgrade !== 'websocket' || !key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  return new WsConnection(socket, nextId);
}

module.exports = { handleUpgrade, WsConnection, acceptKey, encodeFrame };
