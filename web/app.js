import { SyncClient, wsUrl, expectedPosition, isStale, detectDevice } from './sync.js';
import { createAdapter, clamp } from './players.js';

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const ui = {
  app: $('app'),
  screen: $('screen'),
  video: $('video'),
  embedHolder: $('embedHolder'),
  screenIdle: $('screenIdle'),
  idleSamples: $('idleSamples'),
  controls: $('controls'),
  playProxy: $('playProxy'),
  seek: $('seek'),
  timeNow: $('timeNow'),
  timeTotal: $('timeTotal'),
  syncState: $('syncState'),
  syncLabel: $('syncLabel'),
  volume: $('volume'),
  muteBtn: $('muteBtn'),
  volWrap: document.querySelector('.vol'),
  fullBtn: $('fullBtn'),
  bufferBadge: $('bufferBadge'),
  bufferText: $('bufferText'),
  unmuteBtn: $('unmuteBtn'),
  resyncBtn: $('copyStateBtn'),
  theaterBtn: $('theaterBtn'),
  stageNote: $('stageNote'),
  roomChip: $('roomChip'),
  roomCode: $('roomCode'),
  peersStrip: $('peersStrip'),
  peerList: $('peerList'),
  peerCount: $('peerCount'),
  lobby: $('lobby'),
  joinForm: $('joinForm'),
  nameInput: $('nameInput'),
  codeInput: $('codeInput'),
  createBtn: $('createBtn'),
  lobbyHint: $('lobbyHint'),
  serverState: $('serverState'),
  urlForm: $('urlForm'),
  urlInput: $('urlInput'),
  loadBtn: $('loadBtn'),
  quickSites: $('quickSites'),
  messages: $('messages'),
  chatForm: $('chatForm'),
  chatInput: $('chatInput'),
  chatDot: $('chatDot'),
  reactions: $('reactions'),
  toasts: $('toasts'),
  optWait: $('optWait'),
  optDrift: $('optDrift'),
  optData: $('optData'),
  panel: $('panel'),
  scrim: $('scrim'),
  sideToggle: $('sideToggle'),
  sideClose: $('sideClose'),
  recentSection: $('recentSection'),
  recentList: $('recentList'),
};

const state = {
  room: null,
  name: localStorage.getItem('flicksync:name') || '',
  client: null,
  adapter: null,
  source: null,
  remote: null,
  suppressUntil: 0,      // ignore adapter events caused by remote application
  applyingRemote: false,
  lastBroadcastAt: 0,
  lastHeartbeatAt: 0,
  waitingForPeer: false,
  unread: 0,
  activeTab: 'watch',
  dragging: false,
  users: [],
  myId: null,
  lastSeekFrom: null,
};

const SAMPLE_LINKS = [
  { label: 'Big Buck Bunny · mp4', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  { label: 'Sintel · mp4', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' },
  { label: 'Dailymotion', url: 'https://www.dailymotion.com/video/x8jfq2w' },
];

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const fmt = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

const initials = (name) =>
  String(name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || '?';

const deviceLabel = (device) =>
  ({ android: 'Android', mac: 'MacBook', web: 'Browser' })[device] || 'Device';

function toast(message, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  ui.toasts.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function setHash(room) {
  const params = new URLSearchParams(location.search);
  params.set('room', room);
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

function roomFromUrl() {
  const params = new URLSearchParams(location.search);
  return (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * lobby / connection
 * ------------------------------------------------------------------ */

async function checkServer() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const body = await res.json();
    ui.serverState.dataset.state = body.ok ? 'ok' : 'bad';
    ui.serverState.textContent = body.ok ? 'Server online' : 'Server unreachable';
    return body.ok;
  } catch {
    ui.serverState.dataset.state = 'bad';
    ui.serverState.textContent = 'Server unreachable';
    return false;
  }
}

function enterRoom(room, name) {
  if (!room || !name) return;
  state.room = room;
  state.name = name;
  localStorage.setItem('flicksync:name', name);
  localStorage.setItem('flicksync:room', room);
  setHash(room);

  ui.roomCode.textContent = room;
  ui.app.classList.remove('is-lobby');
  document.title = `${room} · FlickSync`;
  renderRecent();

  const client = new SyncClient({ url: wsUrl(), room, name, device: detectDevice() });
  state.client = client;

  client.addEventListener('status', (event) => {
    const { state: status, detail } = event.detail;
    if (status === 'online') {
      setSync(CONNECTED);
      ui.serverState.dataset.state = 'ok';
    } else {
      setSync('Connection lost — reconnecting…', 'waiting');
      if (detail) console.warn(detail);
    }
    renderPeers();
  });

  client.addEventListener('welcome', (event) => {
    state.myId = event.detail.id;
    state.users = event.detail.peers || [];
    renderPeers();
    if (state.users.length === 1) addSystemMessage('Room is ready. Share the code so they can join.');
    announceCurrentState();
  });

  client.addEventListener('peers', (event) => {
    state.users = event.detail || [];
    renderPeers();
  });

  client.addEventListener('peerJoin', (event) => {
    const name = event.detail.peer?.name || 'They';
    addSystemMessage(`${name} joined`);
    toast(`${name} joined the room`);
    // A late joiner has no media yet: push what we are watching.
    setTimeout(announceCurrentState, 250);
  });

  client.addEventListener('peerLeave', (event) => {
    addSystemMessage(`${event.detail.name || 'They'} left`);
  });

  client.addEventListener('message', (event) => applyRemote(event.detail));
  client.connect();
}

const CONNECTED = 'Connected';

function announceCurrentState() {
  if (!state.source || !state.adapter || !state.client?.connected) return;
  state.client.load(state.source, state.adapter.position, state.adapter.paused);
}

function renderPeers() {
  const me = { id: state.myId, name: state.name, device: detectDevice() };
  const everyone = [me, ...state.users.filter((p) => p.id !== state.myId)];

  ui.peersStrip.replaceChildren(
    ...everyone.slice(0, 4).map((peer) => {
      const el = document.createElement('span');
      el.className = 'face' + (peer.id === state.myId ? ' is-me' : '');
      el.textContent = initials(peer.name);
      el.title = `${peer.name} · ${deviceLabel(peer.device)}`;
      return el;
    }),
  );

  ui.peerCount.textContent = String(everyone.length);
  ui.peerList.replaceChildren(
    ...everyone.map((peer) => {
      const li = document.createElement('li');
      if (peer.id === state.myId) li.classList.add('is-me');
      li.innerHTML = `
        <span class="avatar">${initials(peer.name)}</span>
        <span class="who">
          <b>${escapeHtml(peer.name)}${peer.id === state.myId ? ' (you)' : ''}</b>
          <small>${deviceLabel(peer.device)}</small>
        </span>
        ${peer.id === state.myId ? '' : '<span class="badge">in sync</span>'}`;
      return li;
    }),
  );

  if (!state.client?.connected) {
    setSync('Reconnecting…', 'waiting');
  } else if (everyone.length < 2) {
    setSync('Waiting for them to join', 'solo');
  } else {
    setSync(CONNECTED, 'live');
  }
}

function setSync(label, stateName) {
  ui.syncLabel.textContent = label;
  ui.syncState.dataset.state = stateName || 'idle';
}

/* ------------------------------------------------------------------ *
 * media loading
 * ------------------------------------------------------------------ */

async function loadSource(source, { position = 0, paused = true, broadcast = false } = {}) {
  if (!source) return;
  teardownAdapter();

  state.source = source;
  state.remote = null;

  const kind = source.kind || 'file';
  const isEmbed = ['youtube', 'dailymotion', 'vimeo', 'twitch'].includes(kind);

  ui.screen.classList.toggle('has-embed', isEmbed);
  ui.screen.classList.toggle('has-video', !isEmbed);
  ui.embedHolder.hidden = !isEmbed;

  if (kind === 'page') {
    const candidate = source.candidates?.[0];
    if (candidate) {
      return loadSource({ ...source, kind: /m3u8|mpd/i.test(candidate.url) ? 'hls' : 'file', url: candidate.url }, { position, paused, broadcast });
    }
    toast('No video found on that page — open it in the FlickSync desktop app instead.');
    ui.screen.classList.remove('has-embed', 'has-video');
    ui.embedHolder.hidden = true;
    return;
  }

  let adapter;
  try {
    adapter = createAdapter({ kind, video: ui.video, container: ui.embedHolder, source });
  } catch (err) {
    toast('Could not start that player: ' + err.message);
    return;
  }
  state.adapter = adapter;

  adapter.on('ready', ({ duration }) => {
    if (duration) ui.timeTotal.textContent = fmt(duration);
  });

  adapter.on('time', ({ position: pos }) => {
    updateTimeline(pos);
  });

  adapter.on('play', () => {
    if (state.applyingRemote) return;
    ui.controls.classList.add('is-playing');
    broadcastState('play');
  });

  adapter.on('pause', () => {
    if (state.applyingRemote) return;
    ui.controls.classList.remove('is-playing');
    broadcastState('pause');
  });

  adapter.on('seeked', ({ position: pos }) => {
    if (state.applyingRemote) return;
    state.client?.seek(pos, state.adapter.paused);
  });

  adapter.on('rate', ({ rate }) => {
    if (state.applyingRemote) return;
    state.client?.rate(rate, state.adapter.position);
  });

  adapter.on('buffer', ({ buffering }) => {
    ui.bufferBadge.hidden = !buffering;
    if (buffering && state.source?.title) ui.bufferText.textContent = 'Buffering…';
    if (state.applyingRemote) return;
    state.client?.buffering(buffering);
  });

  adapter.on('blocked', () => onAutoplayBlocked());

  adapter.on('error', ({ message }) => {
    toast(message || 'Playback error', 4000);
    setStageNote(message || 'Playback error');
  });

  adapter.on('ended', () => {
    ui.controls.classList.remove('is-playing');
  });

  try {
    await adapter.load(source);
  } catch (err) {
    toast(err.message || 'Could not load that source');
    return;
  }

  if (position > 0) adapter.seek(position);
  if (!paused) await safePlay(adapter);
  else adapter.pause();

  ui.controls.classList.toggle('is-playing', !paused);
  ui.timeTotal.textContent = fmt(adapter.duration || source.duration || 0);
  updateTimeline(adapter.position);
  rememberRecent(source);
  setStageNote(source.title || source.pageUrl || source.url);

  if (broadcast) state.client?.load(source, position, paused);
}

async function safePlay(adapter) {
  try {
    await adapter.play();
    ui.unmuteBtn.hidden = true;
    return true;
  } catch {
    onAutoplayBlocked();
    return false;
  }
}

function onAutoplayBlocked() {
  // Browsers refuse sound before a user gesture. Start muted, then offer a tap.
  ui.video.muted = true;
  state.adapter?.setMuted?.(true);
  state.adapter?.play();
  ui.unmuteBtn.hidden = false;
}

function teardownAdapter() {
  if (state.adapter) {
    try { state.adapter.destroy(); } catch { /* noop */ }
    state.adapter = null;
  }
  ui.screen.classList.remove('has-video', 'has-embed');
  ui.embedHolder.hidden = true;
  ui.embedHolder.replaceChildren();
  ui.bufferBadge.hidden = true;
}

function setStageNote(text) {
  if (!text) {
    ui.stageNote.hidden = true;
    return;
  }
  ui.stageNote.hidden = false;
  ui.stageNote.textContent = /^https?:/.test(text) ? prettyUrl(text) : text;
}

function prettyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
  } catch { return url; }
}

/* ------------------------------------------------------------------ *
 * local controls → network
 * ------------------------------------------------------------------ */

function broadcastState(type, extra = {}) {
  if (!state.client || !state.adapter) return;
  const now = state.client.serverNow();
  if (now - state.lastBroadcastAt < 120) return; // debounce duplicate events
  state.lastBroadcastAt = now;

  const position = state.adapter.position;
  if (type === 'play') state.client.play(position);
  else if (type === 'pause') state.client.pause(position);
  else if (type === 'seek') state.client.seek(position, state.adapter.paused);

  // Keep the reference fresh so drift maths agrees with what we just said.
  state.remote = { position, paused: type !== 'play', issuedAt: now, ...extra };
}

function onPlayPause() {
  const adapter = state.adapter;
  if (!adapter) {
    ui.urlInput.focus();
    toast('Load a video first');
    return;
  }
  if (adapter.paused) {
    safePlay(adapter);
    broadcastState('play');
  } else {
    adapter.pause();
    broadcastState('pause');
  }
  if (ui.video.muted && !ui.unmuteBtn.hidden) ui.unmuteBtn.hidden = true;
}

/* ------------------------------------------------------------------ *
 * remote → local
 * ------------------------------------------------------------------ */

async function applyRemote(msg) {
  if (!msg || !msg.t) return;

  if (msg.t === 'chat') {
    addMessage({ name: msg.name || 'Them', text: msg.text, mine: false });
    if (state.activeTab !== 'chat') {
      state.unread += 1;
      ui.chatDot.hidden = false;
    }
    return;
  }

  if (msg.t === 'buffer') {
    if (!ui.optWait.checked || !msg.buffering) return;
    if (msg.buffering) {
      if (state.adapter && !state.adapter.paused) {
        state.waitingForPeer = true;
        state.applyingRemote = true;
        state.adapter.pause();
        state.applyingRemote = false;
        showWaiting(true, msg.name);
      }
    } else if (state.waitingForPeer) {
      state.waitingForPeer = false;
      showWaiting(false);
      if (state.remote && !state.remote.paused) {
        state.applyingRemote = true;
        await safePlay(state.adapter);
        state.applyingRemote = false;
      }
    }
    return;
  }

  if (!['media', 'play', 'pause', 'seek', 'rate', 'sync'].includes(msg.t)) return;
  if (isStale(msg, state.client.serverNow())) return;

  if (ui.optWait.checked) showWaiting(false);

  state.remote = {
    position: Number(msg.position) || 0,
    paused: msg.t === 'pause' ? true : msg.t === 'play' ? false : Boolean(msg.paused),
    issuedAt: Number(msg.issuedAt) || state.client.serverNow(),
    source: msg.source,
  };
  state.lastSeekFrom = msg.name || null;

  if (msg.t === 'media' && msg.source) {
    const same = state.source && sameSource(state.source, msg.source);
    if (!same) {
      toast(`${msg.name || 'They'} started “${msg.source.title || prettyUrl(msg.source.pageUrl || msg.source.url || '')}”`);
      await loadSource(msg.source, {
        position: state.remote.position,
        paused: state.remote.paused,
        broadcast: false,
      });
      return;
    }
    state.remote.source = state.source;
  }

  const adapter = state.adapter;
  if (!adapter) return;

  const target = expectedPosition({ ...msg, issuedAt: state.remote.issuedAt }, state.client.serverNow());
  const drift = Math.abs(adapter.position - target);

  if (msg.t === 'rate') {
    state.applyingRemote = true;
    adapter.setRate(clamp(Number(msg.rate) || 1, 0.25, 2.5));
    state.applyingRemote = false;
    return;
  }

  const wantsPause = state.remote.paused;

  if (drift > (wantsPause ? 0.25 : 1.2)) {
    state.applyingRemote = true;
    adapter.seek(target);
    state.applyingRemote = false;
  }

  if (wantsPause) {
    if (!adapter.paused) {
      state.applyingRemote = true;
      adapter.pause();
      state.applyingRemote = false;
    }
    ui.controls.classList.remove('is-playing');
  } else if (adapter.paused) {
    state.applyingRemote = true;
    await safePlay(adapter);
    state.applyingRemote = false;
    ui.controls.classList.add('is-playing');
  }
}

function showWaiting(waiting, name) {
  ui.bufferBadge.hidden = !waiting;
  if (waiting) ui.bufferText.textContent = `Waiting for ${name || 'them'}…`;
}

function sameSource(a, b) {
  if (!a || !b) return false;
  const key = (s) => [s.kind, s.id || s.url, s.pageUrl].filter(Boolean).join('|');
  return key(a) === key(b);
}

/* ------------------------------------------------------------------ *
 * drift correction loop
 * ------------------------------------------------------------------ */

setInterval(() => {
  const { adapter, client, remote } = state;
  if (!adapter || !client || !remote || !client.connected) return;
  if (state.waitingForPeer) return;
  if (state.remote.paused || adapter.paused) return;
  if (!ui.optDrift.checked) return;
  if (isStale({ issuedAt: remote.issuedAt }, client.serverNow())) return;
  if (state.dragging) return;

  const target = expectedPosition(remote, client.serverNow());
  const tolerance = state.source && state.source.kind === 'file' ? 0.9 : 1.6;
  if (Math.abs(adapter.position - target) > tolerance) {
    state.applyingRemote = true;
    adapter.seek(target);
    state.applyingRemote = false;
  }

  // Heartbeat: tell them where we are so a stalled stream can re-converge.
  const now = client.serverNow();
  if (now - state.lastHeartbeatAt > 4000) {
    state.lastHeartbeatAt = now;
    client.play(adapter.position);
  }
}, 600);

/* ------------------------------------------------------------------ *
 * timeline UI
 * ------------------------------------------------------------------ */

function updateTimeline(position) {
  const adapter = state.adapter;
  const duration = adapter?.duration || state.source?.duration || 0;
  if (!duration) return;

  const pct = clamp((position / duration) * 100, 0, 100);
  ui.seek.style.setProperty('--pct', pct.toFixed(2) + '%');
  if (!state.dragging) ui.seek.value = String(Math.round(pct * 10));

  const buffered = adapter?.buffered;
  if (buffered) {
    ui.seek.style.setProperty('--buf', clamp((buffered / duration) * 100, pct, 100).toFixed(2) + '%');
  }

  ui.timeNow.textContent = fmt(position);
  ui.timeTotal.textContent = fmt(duration);
  ui.controls.classList.toggle('is-playing', !adapter?.paused);
}

function seekTo(seconds) {
  if (!state.adapter) return;
  const duration = state.adapter.duration;
  const target = clamp(seconds, 0, duration > 0 ? duration - 0.15 : seconds);
  state.applyingRemote = true;
  state.adapter.seek(target);
  state.applyingRemote = false;

  const paused = state.adapter.paused;
  state.client?.seek(target, paused);
  state.remote = { position: target, paused, issuedAt: state.client.serverNow() };
  updateTimeline(target);
}

/* ------------------------------------------------------------------ *
 * chat
 * ------------------------------------------------------------------ */

function addMessage({ name, text, mine }) {
  const li = document.createElement('li');
  if (mine) li.classList.add('mine');
  li.innerHTML = `<span class="meta">${escapeHtml(name)}${mine ? ' · you' : ''}</span>${escapeHtml(text)}`;
  ui.messages.append(li);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function addSystemMessage(text) {
  const li = document.createElement('li');
  li.className = 'system';
  li.textContent = text;
  ui.messages.append(li);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/* ------------------------------------------------------------------ *
 * recently watched
 * ------------------------------------------------------------------ */

function rememberRecent(source) {
  if (!source || !source.title) return;
  try {
    const key = 'flicksync:recent';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    const filtered = list.filter((item) => item.key !== sourceKey(source));
    filtered.unshift({ key: sourceKey(source), title: source.title, source, at: Date.now() });
    localStorage.setItem(key, JSON.stringify(filtered.slice(0, 6)));
    renderRecent();
  } catch { /* storage full or blocked */ }
}

function sourceKey(source) {
  return [source.kind, source.id || source.url].join('|');
}

function renderRecent() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('flicksync:recent') || '[]'); } catch { /* noop */ }
  ui.recentSection.hidden = list.length === 0;
  ui.recentList.replaceChildren(
    ...list.map((item) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.title;
      button.addEventListener('click', () => loadSource(item.source, { broadcast: true }));
      li.append(button);
      return li;
    }),
  );
}

/* ------------------------------------------------------------------ *
 * source resolution
 * ------------------------------------------------------------------ */

async function loadFromUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return;

  ui.loadBtn.disabled = true;
  ui.loadBtn.textContent = '…';
  setStageNote('Looking for the video on that page…');

  try {
    const res = await fetch(`/api/extract?url=${encodeURIComponent(value)}`, { cache: 'no-store' });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'could not read that link');

    const source = body.source;
    if (source.kind === 'page' && !source.candidates?.length) {
      toast('That page hides its video. Try the direct .mp4 link, or our Mac app’s browser.');
      setStageNote('');
      return;
    }
    await loadSource(source, { broadcast: true });
    ui.urlInput.value = '';
  } catch (err) {
    toast(err.message || 'That link did not work');
    setStageNote('');
  } finally {
    ui.loadBtn.disabled = false;
    ui.loadBtn.textContent = 'Load';
  }
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

ui.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = ui.nameInput.value.trim();
  const code = (ui.codeInput.value.trim() || randomCode()).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!name) return;
  if (code.length < 4) {
    ui.lobbyHint.textContent = 'Room codes are at least 4 characters.';
    ui.lobbyHint.classList.add('is-error');
    return;
  }
  enterRoom(code, name);
});

ui.createBtn.addEventListener('click', () => {
  const name = ui.nameInput.value.trim() || state.name;
  if (!name) {
    ui.nameInput.focus();
    ui.lobbyHint.textContent = 'Add your name first.';
    ui.lobbyHint.classList.add('is-error');
    return;
  }
  const code = randomCode();
  ui.codeInput.value = code;
  ui.lobbyHint.textContent = `Room ${code} created — send that code to your other half.`;
  ui.lobbyHint.classList.remove('is-error');
  enterRoom(code, name);
});

ui.playProxy.addEventListener('click', onPlayPause);

ui.seek.addEventListener('pointerdown', () => { state.dragging = true; });
ui.seek.addEventListener('input', () => {
  const pct = Number(ui.seek.value) / 1000;
  const duration = state.adapter?.duration || 0;
  ui.seek.style.setProperty('--pct', (pct * 100).toFixed(2) + '%');
  if (duration) {
    state.dragging = true;
    ui.timeNow.textContent = fmt(pct * duration);
  }
});
ui.seek.addEventListener('change', () => {
  const pct = Number(ui.seek.value) / 1000;
  const duration = state.adapter?.duration || 0;
  state.dragging = false;
  if (duration) seekTo(pct * duration);
});

ui.volume.addEventListener('input', () => {
  const value = Number(ui.volume.value);
  state.adapter?.setVolume(value);
  ui.video.volume = value;
  ui.video.muted = value === 0;
  ui.unmuteBtn.hidden = true;
  updateMuteUi();
});

ui.muteBtn.addEventListener('click', () => {
  const muted = !ui.video.muted;
  ui.video.muted = muted;
  state.adapter?.setMuted?.(muted);
  updateMuteUi();
});

function updateMuteUi() {
  const muted = ui.video.muted || Number(ui.volume.value) === 0;
  ui.volWrap.classList.toggle('is-muted', muted);
}

ui.unmuteBtn.addEventListener('click', () => {
  ui.video.muted = false;
  state.adapter?.setMuted?.(false);
  state.adapter?.setVolume?.(Number(ui.volume.value));
  ui.unmuteBtn.hidden = true;
  updateMuteUi();
});

ui.fullBtn.addEventListener('click', () => {
  const target = ui.screen;
  if (!document.fullscreenElement) {
    (target.requestFullscreen?.({ navigationUI: 'hide' }) || target.webkitRequestFullscreen?.())?.catch?.(() => {});
  } else {
    document.exitFullscreen?.();
  }
});

ui.theaterBtn.addEventListener('click', () => {
  ui.app.classList.toggle('is-theater');
});

ui.resyncBtn.addEventListener('click', () => {
  if (!state.adapter) return;
  state.client?.send('seek', { position: state.adapter.position, paused: state.adapter.paused });
  state.client?.send(state.adapter.paused ? 'pause' : 'play', { position: state.adapter.position });
  toast('Sent your exact position');
});

ui.urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loadFromUrl(ui.urlInput.value);
});

ui.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui.chatInput.value.trim();
  if (!text) return;
  state.client?.chat(text);
  addMessage({ name: state.name, text, mine: true });
  ui.chatInput.value = '';
});

for (const emoji of ['❤️', '😂', '😱', '🥹', '🍿']) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = emoji;
  button.addEventListener('click', () => {
    state.client?.chat(emoji);
    addMessage({ name: state.name, text: emoji, mine: true });
  });
  ui.reactions.append(button);
}

ui.roomChip.addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${state.room}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    toast(link, 5000);
  }
});

ui.sideToggle.addEventListener('click', () => ui.app.classList.add('panel-open'));
ui.sideClose.addEventListener('click', () => ui.app.classList.remove('panel-open'));
ui.scrim.addEventListener('click', () => ui.app.classList.remove('panel-open'));

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $('tabWatch').hidden = state.activeTab !== 'watch';
    $('tabChat').hidden = state.activeTab !== 'chat';
    if (state.activeTab === 'chat') {
      state.unread = 0;
      ui.chatDot.hidden = true;
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (event.code === 'Space') { event.preventDefault(); onPlayPause(); }
  if (event.code === 'ArrowRight') seekTo((state.adapter?.position || 0) + 5);
  if (event.code === 'ArrowLeft') seekTo((state.adapter?.position || 0) - 5);
  if (event.key === 'f') ui.fullBtn.click();
  if (event.key === 't') ui.theaterBtn.click();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.client && !state.client.connected) {
    state.client.connect();
  }
});

window.addEventListener('beforeunload', () => state.client?.close());

/* quick site chips + idle samples */
for (const sample of SAMPLE_LINKS) {
  const idleButton = document.createElement('button');
  idleButton.type = 'button';
  idleButton.textContent = sample.label;
  idleButton.addEventListener('click', () => loadFromUrl(sample.url));
  ui.idleSamples.append(idleButton);
}

for (const site of [
  { label: 'YouTube', prefix: 'https://www.youtube.com/watch?v=' },
  { label: 'Dailymotion', prefix: 'https://www.dailymotion.com/video/' },
  { label: 'Vimeo', prefix: 'https://vimeo.com/' },
  { label: '.m3u8 stream', prefix: 'https://' },
]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = site.label;
  button.addEventListener('click', () => {
    ui.urlInput.value = site.prefix;
    ui.urlInput.focus();
    ui.urlInput.setSelectionRange(site.prefix.length, site.prefix.length);
    if (window.innerWidth <= 900) ui.app.classList.add('panel-open');
  });
  ui.quickSites.append(button);
}

/* boot */
(async function boot() {
  if (state.name) ui.nameInput.value = state.name;
  ui.nameInput.value = state.name || '';
  const room = roomFromUrl() || (localStorage.getItem('flicksync:room') || '');
  if (room) ui.codeInput.value = room;
  ui.codeInput.addEventListener('input', () => {
    ui.codeInput.value = ui.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  const ok = await checkServer();
  if (ok && room && state.name) {
    enterRoom(room, state.name);
  } else if (ok && state.name) {
    ui.lobbyHint.textContent = 'Welcome back — start a room or type their code.';
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
