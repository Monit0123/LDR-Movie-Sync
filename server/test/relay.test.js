import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';

import { Rooms, attachRelay, normaliseCode } from '../src/relay.js';

test('room codes are normalised to a safe alphabet', () => {
  assert.equal(normaliseCode(' ab-12 cd '), 'AB12CD');
  assert.equal(normaliseCode('ab12cd'), 'AB12CD');
  assert.equal(normaliseCode('$.!'), '');
  assert.equal(normaliseCode(null), '');
});

test('rooms collect peers and drop them when empty', () => {
  const rooms = new Rooms();
  const fake = { readyState: 1, OPEN: 1, send() {} };
  const { room, peer } = rooms.join('tea42', fake, { name: 'Ana', device: 'android' });

  assert.equal(room.code, 'TEA42');
  assert.equal(peer.name, 'Ana');
  assert.deepEqual(rooms.roster(room).map((p) => p.device), ['android']);
  assert.equal(rooms.stats().peers, 1);

  rooms.leave('TEA42', peer.id);
  assert.equal(rooms.stats().rooms, 0);
});

test('a room refuses more than its peer limit', () => {
  const rooms = new Rooms({ maxPeers: 2 });
  const fake = { readyState: 1, OPEN: 1, send() {} };
  rooms.join('full', fake, { name: 'A' });
  rooms.join('full', fake, { name: 'B' });
  assert.throws(() => rooms.join('full', fake, { name: 'C' }), /room is full/);
});

test('unknown message types are not relayed', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const { rooms } = attachRelay(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const open = (name) => new WebSocket(`ws://127.0.0.1:${port}/ws?room=t1&name=${name}&device=web`);
  const a = open('A');
  const b = open('B');
  await Promise.all([once(a, 'open'), once(b, 'open')]);
  await wait(80);

  const seen = [];
  b.on('message', (raw) => seen.push(JSON.parse(raw.toString())));

  a.send(JSON.stringify({ t: 'play', position: 12.5, paused: false, issuedAt: Date.now() }));
  a.send(JSON.stringify({ t: 'evil', payload: 'should not travel' }));
  b.send(JSON.stringify({ t: 'ping', c: Date.now() }));
  await wait(250);

  const types = seen.map((m) => m.t);
  assert.ok(types.includes('play'), 'play is relayed');
  assert.ok(!types.includes('evil'), 'unknown types are dropped');
  assert.ok(types.includes('pong'), 'ping answered');

  const play = seen.find((m) => m.t === 'play');
  assert.equal(play.position, 12.5);
  assert.equal(play.name, 'A');

  assert.equal(rooms.stats().rooms, 1);
  a.close();
  b.close();
  server.closeAllConnections?.();
  server.close();
});

test('malformed json does not break the socket', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  attachRelay(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=broken&name=A&device=web`);
  await once(ws, 'open');
  ws.send('not json at all');
  ws.send(JSON.stringify({ t: 'ping', c: 1 }));
  const reply = await once(ws, 'message');
  assert.equal(JSON.parse(reply[0].toString()).t, 'pong');
  ws.close();
  server.closeAllConnections?.();
  server.close();
});

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, (...args) => resolve(args)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
