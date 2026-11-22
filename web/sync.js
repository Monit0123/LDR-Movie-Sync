/**
 * SyncClient — the wire protocol, shared by every client of FlickSync.
 *
 * Responsibilities:
 *   • one WebSocket to the relay, with automatic reconnect
 *   • clock offset estimation against the server (so "issuedAt" is comparable)
 *   • a tiny typed API for playback events
 *
 * It deliberately knows nothing about <video>, ExoPlayer or AVPlayer.
 */

export const STALE_MS = 15_000;

export class SyncClient extends EventTarget {
  constructor({ url, room, name, device }) {
    super();
    this.url = url;
    this.room = room;
    this.name = name;
    this.device = device || detectDevice();
    this.ws = null;
    this.offset = 0;          // serverNow - localNow, in ms
    this.samples = [];
    this.reconnectDelay = 600;
    this.closedByUser = false;
    this.peers = [];
    this.id = null;
    this.connected = false;
    this._timers = [];
  }

  connect() {
    this.closedByUser = false;
    this._open();
  }

  _open() {
    const url = new URL(this.url);
    url.searchParams.set('room', this.room);
    url.searchParams.set('name', this.name);
    url.searchParams.set('device', this.device);

    let ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      this._emitStatus('offline', err.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 600;
      this._emitStatus('online');
      this._startTimers();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this._handle(msg);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this._stopTimers();
      this.peers = [];
      this.dispatchEvent(new CustomEvent('peers', { detail: [] }));
      this._emitStatus('offline');
      if (!this.closedByUser) this._scheduleReconnect();
    });

    ws.addEventListener('error', () => { /* close handler does the work */ });
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const jitter = Math.random() * 250;
    this._reconnectTimer = setTimeout(() => this._open(), this.reconnectDelay + jitter);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 8000);
  }

  _startTimers() {
    this._stopTimers();
    const ping = () => this._sendRaw({ t: 'ping', c: Date.now() });
    ping();
    this._timers.push(setInterval(ping, 5000));
  }

  _stopTimers() {
    this._timers.forEach(clearInterval);
    this._timers = [];
  }

  _handle(msg) {
    switch (msg.t) {
      case 'hello':
        this.id = msg.id;
        this.peers = msg.peers || [];
        this.dispatchEvent(new CustomEvent('peers', { detail: this.peers }));
        this.dispatchEvent(new CustomEvent('welcome', { detail: msg }));
        return;
      case 'join':
      case 'leave':
        this.peers = msg.peers || [];
        this.dispatchEvent(new CustomEvent('peers', { detail: this.peers }));
        this.dispatchEvent(new CustomEvent(msg.t === 'join' ? 'peerJoin' : 'peerLeave', { detail: msg }));
        return;
      case 'pong': {
        const rtt = Date.now() - msg.c;
        if (rtt >= 0 && rtt < 4000) {
          this.samples.push({ offset: msg.s - (msg.c + rtt / 2), rtt });
          if (this.samples.length > 12) this.samples.shift();
          const recent = this.samples.slice().sort((a, b) => a.rtt - b.rtt).slice(0, 5);
          this.offset = median(recent.map((s) => s.offset));
          this.dispatchEvent(new CustomEvent('clock', { detail: { offset: this.offset, rtt } }));
        }
        return;
      }
      default:
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    }
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  _sendRaw(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Broadcast arbitrary synced state. Returns false when offline. */
  send(type, payload = {}) {
    return this._sendRaw({ t: type, ...payload, issuedAt: this.serverNow() });
  }

  load(source, position = 0, paused = true) {
    return this.send('media', { source, position, paused });
  }
  play(position) { return this.send('play', { position }); }
  pause(position) { return this.send('pause', { position }); }
  seek(position, paused = false) { return this.send('seek', { position, paused }); }
  rate(rate, position) { return this.send('rate', { rate, position }); }
  buffering(buffering) { return this.send('buffer', { buffering }); }
  chat(text) { return this.send('chat', { text }); }

  _emitStatus(state, detail) {
    this.dispatchEvent(new CustomEvent('status', { detail: { state, detail } }));
  }

  close() {
    this.closedByUser = true;
    this._stopTimers();
    clearTimeout(this._reconnectTimer);
    try { this.ws?.close(1000, 'bye'); } catch { /* noop */ }
    this.ws = null;
    this.connected = false;
  }
}

/** Convert a wire message into "where should the playhead be right now". */
export function expectedPosition(msg, serverNow) {
  const base = Number(msg.position) || 0;
  const issued = Number(msg.issuedAt) || 0;
  if (!issued) return base;
  const elapsed = (serverNow - issued) / 1000;
  if (elapsed < 0 || elapsed > 3600) return base;
  return msg.paused ? base : base + elapsed;
}

export function isStale(msg, serverNow, tolerance = STALE_MS) {
  return serverNow - (Number(msg.issuedAt) || 0) > tolerance;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function detectDevice() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  return 'web';
}

export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
