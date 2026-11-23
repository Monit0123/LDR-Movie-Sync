import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

/**
 * Room registry.
 *
 * A room is just a set of sockets. No persistence, no accounts, nothing to leak.
 * Rooms are deleted as soon as the last member leaves.
 */
export class Rooms {
  constructor({ maxPeers = 4, idleTtlMs = 1000 * 60 * 60 } = {}) {
    this.rooms = new Map();
    this.maxPeers = maxPeers;
    this.idleTtlMs = idleTtlMs;
    const sweeper = setInterval(() => this.sweep(), 60_000);
    sweeper.unref?.();
  }

  join(code, socket, profile) {
    const key = normaliseCode(code);
    if (!key) throw new Error('room code required');

    let room = this.rooms.get(code.length ? key : key);
    if (!room) {
      room = { code: key, peers: new Map(), createdAt: Date.now(), lastSeen: Date.now() };
      this.rooms.set(key, room);
    }
    if (room.peers.size >= this.maxPeers) {
      const err = new Error('room is full');
      err.code = 'ROOM_FULL';
      throw err;
    }

    const peer = {
      id: randomUUID().slice(0, 8),
      name: String(profile.name || 'Guest').slice(0, 24),
      device: ['android', 'mac', 'web'].includes(profile.device) ? profile.device : 'web',
      socket,
      joinedAt: Date.now(),
    };
    room.peers.set(peer.id, peer);
    room.lastSeen = Date.now();
    return { room, peer };
  }

  leave(code, peerId) {
    const key = normaliseCode(code);
    const room = this.rooms.get(key);
    if (!room) return null;
    room.peers.delete(peerId);
    room.lastSeen = Date.now();
    if (room.peers.size === 0) this.rooms.delete(key);
    return room;
  }

  get(code) {
    return this.rooms.get(normaliseCode(code)) || null;
  }

  broadcast(room, message, exceptId) {
    const payload = JSON.stringify(message);
    for (const peer of room.peers.values()) {
      if (peer.id === exceptId) continue;
      if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(payload);
    }
  }

  roster(room) {
    return [...room.peers.values()].map(({ id, name, device }) => ({ id, name, device }));
  }

  sweep() {
    const now = Date.now();
    for (const [key, room] of this.rooms) {
      if (room.peers.size === 0 && now - room.lastSeen > this.idleTtlMs) this.rooms.delete(key);
    }
  }

  stats() {
    let peers = 0;
    for (const room of this.rooms.values()) peers += room.peers.size;
    return { rooms: this.rooms.size, peers };
  }
}

export function normaliseCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

/** Attach the relay to an existing http.Server. */
export function attachRelay(httpServer, { path = '/ws', rooms = new Rooms(), log = () => {} } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const code = normaliseCode(url.searchParams.get('room'));
    const profile = {
      name: url.searchParams.get('name') || 'Guest',
      device: url.searchParams.get('device') || 'web',
    };

    if (!code) {
      ws.close(4000, 'room required');
      return;
    }

    let room;
    let peer;
    try {
      ({ room, peer } = rooms.join(code, ws, profile));
    } catch (err) {
      ws.close(4003, err.code === 'ROOM_FULL' ? 'room full' : 'bad request');
      return;
    }

    const send = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    send({ t: 'hello', id: peer.id, room: room.code, peers: rooms.roster(room) });
    rooms.broadcast(room, { t: 'join', peer: { id: peer.id, name: peer.name, device: peer.device }, peers: rooms.roster(room) }, peer.id);
    log(`+ ${code} ${peer.name} (${peer.device}) [${room.peers.size}]`);

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, 30_000);
    heartbeat.unref?.();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'ping') {
        send({ t: 'pong', c: msg.c, s: Date.now() });
        return;
      }
      if (msg.t === 'bye') {
        ws.close(1000, 'bye');
        return;
      }
      // Only relay whitelisted state messages, stamped with sender identity.
      if (!RELAYED.has(msg.t)) return;
      delete msg.s;
      rooms.broadcast(
        room,
        { ...msg, from: peer.id, name: peer.name, device: peer.device, relayedAt: Date.now() },
        peer.id,
      );
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      const remaining = rooms.leave(code, peer.id);
      rooms.broadcast(remaining || { peers: new Map() }, {
        t: 'leave',
        from: peer.id,
        name: peer.name,
        peers: remaining ? rooms.roster(remaining) : [],
      });
      log(`- ${code} ${peer.name} [${remaining ? remaining.peers.size : 0}]`);
    });

    ws.on('error', () => ws.close());
    ws.isAlive = true;
  });

  return { wss, rooms };
}

const RELAYED = new Set(['media', 'play', 'pause', 'seek', 'rate', 'buffer', 'chat', 'chatTyping', 'sync']);
