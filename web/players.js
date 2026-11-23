/**
 * One interface, five engines.
 *
 * Every adapter exposes the same tiny surface so the sync logic never needs to
 * care whether the movie is an .mp4, a YouTube embed or a Dailymotion page:
 *
 *   load(source) · play() · pause() · seek(seconds) · setVolume(v)
 *   position · duration · paused · buffered
 *   on('ready'|'play'|'pause'|'seeked'|'time'|'buffer'|'ended'|'error', fn)
 */

class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }
  emit(type, detail) {
    for (const fn of this._handlers.get(type) || []) {
      try { fn(detail); } catch (err) { console.error(err); }
    }
  }
}

export class BaseAdapter extends Emitter {
  constructor(source) {
    super();
    this.source = source;
  }
  get position() { return 0; }
  set position(_v) { /* noop */ }
  get duration() { return 0; }
  get paused() { return true; }
  get rate() { return 1; }
  get buffered() { return 0; }
}

/* ------------------------------------------------------------------ *
 * Direct media (<video>) — mp4 / webm / hls / dash
 * ------------------------------------------------------------------ */

export class DirectAdapter extends BaseAdapter {
  constructor(video, source) {
    super(source);
    this.video = video;
    this.hls = null;
    this._unsubs = [];
    this._wire();
  }

  _wire() {
    const v = this.video;
    const bind = (type, handler) => {
      v.addEventListener(type, handler);
      this._unsubs.push(() => v.removeEventListener(type, handler));
    };

    bind('loadedmetadata', () => {
      this.emit('ready', { duration: v.duration });
      this._emitState();
    });
    bind('play', () => this.emit('play', { position: v.currentTime }));
    bind('pause', () => {
      if (!v.ended) this.emit('pause', { position: v.currentTime });
    });
    bind('seeking', () => this.emit('seeking'));
    bind('seeked', () => this.emit('seeked', { position: v.currentTime }));
    bind('timeupdate', () => this.emit('time', { position: v.currentTime, duration: v.duration }));
    bind('waiting', () => this.emit('buffer', { buffering: true }));
    bind('playing', () => this.emit('buffer', { buffering: false }));
    bind('canplay', () => this.emit('buffer', { buffering: false }));
    bind('ratechange', () => this.emit('rate', { rate: v.playbackRate }));
    bind('ended', () => this.emit('ended'));
    bind('error', () => this.emit('error', { message: mediaErrorMessage(v.error) }));
  }

  _emitState() {
    this.emit('state', { paused: this.video.paused, position: this.video.currentTime });
  }

  async load(source) {
    const v = this.video;
    this._teardownEngine();
    v.removeAttribute('src');
    v.load();

    const url = source.url;
    const wantsHls = source.kind === 'hls' || /\.m3u8(\?|$)/i.test(url);

    if (wantsHls && !v.canPlayType('application/vnd.apple.mpegurl')) {
      const Hls = await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js', 'Hls')
        .catch(() => null);
      if (Hls?.isSupported()) {
        this.hls = new Hls({ maxBufferLength: 30, enableWorker: true });
        this.hls.loadSource(url);
        this.hls.attachMedia(v);
        this.hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) this.emit('error', { message: 'This stream would not load (it may be expired).' });
        });
        return;
      }
    }

    v.src = url;
    v.load();
  }

  _teardownEngine() {
    if (this.hls) {
      try { this.hls.destroy(); } catch { /* noop */ }
      this.hls = null;
    }
  }

  get position() { return this.video.currentTime || 0; }
  set position(t) { this.video.currentTime = t; }
  get duration() {
    const d = this.video.duration;
    return Number.isFinite(d) ? d : 0;
  }
  get paused() { return this.video.paused; }
  get rate() { return this.video.playbackRate; }
  get buffered() {
    try {
      const b = this.video.buffered;
      return b.length ? b.end(b.length - 1) : 0;
    } catch { return 0; }
  }

  async play() {
    try {
      await this.video.play();
    } catch (err) {
      if (err?.name === 'NotAllowedError') this.emit('blocked');
    }
  }
  pause() { this.video.pause(); }
  seek(seconds) {
    const target = clamp(seconds, 0, this.duration || seconds + 1);
    if (Math.abs(this.video.currentTime - target) < 0.05) return;
    this.video.currentTime = target;
  }
  setRate(rate) { this.video.playbackRate = clamp(rate, 0.25, 3); }
  setVolume(v) { this.video.volume = clamp(v, 0, 1); this.video.muted = v === 0; }
  setMuted(m) { this.video.muted = m; }

  destroy() {
    this._teardownEngine();
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
    this.video.removeAttribute('src');
    try { this.video.load(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ *
 * YouTube
 * ------------------------------------------------------------------ */

export class YouTubeAdapter extends BaseAdapter {
  constructor(container, source) {
    super(source);
    this.container = container;
    this.player = null;
    this._ready = false;
    this._tick = null;
    this._buffering = false;
  }

  async load(source) {
    this.source = source;
    await loadScript('https://www.youtube.com/iframe_api', 'YT', () => window.YT?.Player);
    const mount = document.createElement('div');
    mount.style.width = '100%';
    mount.style.height = '100%';
    this.container.replaceChildren(mount);

    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      setTimeout(done, 12_000);
      this.player = new window.YT.Player(mount, {
        videoId: source.id,
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            this._ready = true;
            this.emit('ready', { duration: this.duration });
            done();
          },
          onStateChange: (event) => this._onState(event.data),
          onError: () => this.emit('error', { message: 'YouTube refused to play this video here.' }),
        },
      });
    });

    clearInterval(this._tick);
    this._tick = setInterval(() => {
      if (this._ready) this.emit('time', { position: this.position, duration: this.duration });
    }, 500);
  }

  _onState(state) {
    const YT = window.YT?.PlayerState || {};
    if (state === YT.PLAYING) {
      this._buffering = false;
      this.emit('buffer', { buffering: false });
      this.emit('play', { position: this.position });
    } else if (state === YT.PAUSED) {
      this.emit('pause', { position: this.position });
    } else if (state === YT.BUFFERING) {
      this._buffering = true;
      this.emit('buffer', { buffering: true });
    } else if (state === YT.ENDED) {
      this.emit('ended');
    }
  }

  get position() { return this._ready ? this.player.getCurrentTime() || 0 : 0; }
  get duration() { return this._ready ? this.player.getDuration() || 0 : 0; }
  get paused() {
    return !this._ready || this.player.getPlayerState() !== window.YT.PlayerState.PLAYING;
  }
  get buffered() {
    try {
      const f = this.player.getVideoLoadedFraction();
      return f * (this.duration || 0);
    } catch { return 0; }
  }

  play() { if (this._ready) this.player.playVideo(); }
  pause() { if (this._ready) this.player.pauseVideo(); }
  seek(seconds) { if (this._ready) this.player.seekTo(seconds, true); }
  setRate(rate) { if (this._ready) this.player.setPlaybackRate(clamp(rate, 0.25, 2)); }
  setVolume(v) { if (this._ready) this.player.setVolume(clamp(v, 0, 1) * 100); }
  setMuted(m) { if (this._ready) (m ? this.player.mute() : this.player.unMute()); }
  destroy() {
    clearInterval(this._tick);
    try { this.player?.destroy(); } catch { /* noop */ }
    this.container.replaceChildren();
  }
}

/* ------------------------------------------------------------------ *
 * Dailymotion
 * ------------------------------------------------------------------ */

export class DailymotionAdapter extends BaseAdapter {
  constructor(container, source) {
    super(source);
    this.container = container;
    this.player = null;
    this._ready = false;
    this._tick = null;
  }

  async load(source) {
    this.source = source;
    await loadScript('https://api.dmcdn.net/all.js', 'DM');
    const mount = document.createElement('div');
    mount.id = 'dm-' + Math.random().toString(36).slice(2, 8);
    mount.style.width = '100%';
    mount.style.height = '100%';
    this.container.replaceChildren(mount);

    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      setTimeout(done, 12_000);
      this.player = window.DM.player(mount, {
        video: source.id,
        width: '100%',
        height: '100%',
        params: { autoplay: false, controls: true, quality: 'auto', 'ui-highlight': 'ff5c7a' },
        events: {
          apiready: () => { this._ready = true; done(); },
          video_start: () => this.emit('ready', { duration: this.duration }),
          play: () => this.emit('play', { position: this.position }),
          pause: () => this.emit('pause', { position: this.position }),
          seeking: () => this.emit('seeking'),
          seeked: () => this.emit('seeked', { position: this.position }),
          timeupdate: () => this.emit('time', { position: this.position, duration: this.duration }),
          video_end: () => this.emit('ended'),
          error: () => this.emit('error', { message: 'Dailymotion could not play this video here.' }),
        },
      });
    });

    clearInterval(this._tick);
    this._tick = setInterval(() => {
      if (this._ready) this.emit('time', { position: this.position, duration: this.duration });
    }, 500);
  }

  get position() { return this._ready ? Number(this.player.currentTime) || 0 : 0; }
  get duration() { return this._ready ? Number(this.player.duration) || 0 : 0; }
  get paused() { return !this._ready || Boolean(this.player.paused); }

  play() { if (this._ready) this.player.play(); }
  pause() { if (this._ready) this.player.pause(); }
  seek(seconds) { if (this._ready) this.player.seek(seconds); }
  setRate(rate) { if (this._ready) this.player.setPlaybackRate(clamp(rate, 0.25, 2)); }
  setVolume(v) { if (this._ready) this.player.setVolume(clamp(v, 0, 1)); }
  setMuted(m) { if (this._ready) this.player.setMuted(m); }
  destroy() {
    clearInterval(this._tick);
    try { this.player?.destroy(); } catch { /* noop */ }
    this.container.replaceChildren();
  }
}

/* ------------------------------------------------------------------ *
 * Vimeo (postMessage protocol, no SDK needed)
 * ------------------------------------------------------------------ */

export class VimeoAdapter extends BaseAdapter {
  constructor(container, source) {
    super(source);
    this.container = container;
    this.iframe = null;
    this._ready = false;
    this._paused = true;
    this._time = 0;
    this._duration = 0;
    this._listener = (event) => this._onMessage(event);
    this._tick = null;
  }

  async load(source) {
    this.source = source;
    const id = 'vimeo-' + Math.random().toString(36).slice(2, 8);
    const iframe = document.createElement('iframe');
    iframe.id = id;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.src = `https://player.vimeo.com/video/${source.id}?api=1&player_id=${id}&dnt=1&title=0&byline=0&portrait=0`;
    this.container.replaceChildren(iframe);
    this.iframe = iframe;

    window.addEventListener('message', this._listener);
    iframe.addEventListener('load', () => {
      this._post({ method: 'addEventListener', value: 'play' });
      this._post({ method: 'addEventListener', value: 'pause' });
      this._post({ method: 'addEventListener', value: 'seeked' });
      this._post({ method: 'addEventListener', value: 'timeupdate' });
      this._post({ method: 'addEventListener', value: 'playProgress' });
      this._post({ method: 'addEventListener', value: 'finish' });
      this._post({ method: 'getDuration' });
    });

    clearInterval(this._tick);
    this._tick = setInterval(() => this._post({ method: 'getCurrentTime' }), 600);
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  _post(payload) {
    this.iframe?.contentWindow?.postMessage(JSON.stringify(payload), 'https://player.vimeo.com');
  }

  _onMessage(event) {
    if (!/^https:\/\/player\.vimeo\.com$/.test(event.origin)) return;
    let data;
    try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
    if (!data) return;

    if (data.event === 'ready') {
      this._ready = true;
      this.emit('ready', { duration: this._duration });
      return;
    }
    if (data.event === 'play') { this._paused = false; this.emit('play', { position: this._time }); return; }
    if (data.event === 'pause') { this._paused = true; this.emit('pause', { position: this._time }); return; }
    if (data.event === 'seeked' || data.event === 'timeupdate' || data.event === 'playProgress') {
      const seconds = data.data?.seconds ?? data.data?.time;
      if (typeof seconds === 'number') this._time = seconds;
      if (typeof data.data?.duration === 'number' && data.data.duration > 0) this._duration = data.data.duration;
      this.emit('time', { position: this._time, duration: this._duration });
      return;
    }
    if (data.event === 'finish') { this.emit('ended'); return; }
    if (data.method === 'getCurrentTime' && typeof data.value === 'number') this._time = data.value;
    if (data.method === 'getDuration' && typeof data.value === 'number') {
      this._duration = data.value;
      this.emit('ready', { duration: this._duration });
    }
  }

  get position() { return this._time; }
  get duration() { return this._duration; }
  get paused() { return this._paused; }

  play() { this._post({ method: 'play' }); this._paused = false; }
  pause() { this._post({ method: 'pause' }); this._paused = true; }
  seek(seconds) { this._post({ method: 'setCurrentTime', value: seconds }); this._time = seconds; }
  setVolume(v) { this._post({ method: 'setVolume', value: clamp(v, 0, 1) }); }
  setMuted(m) { this._post({ method: 'setVolume', value: m ? 0 : 1 }); }
  destroy() {
    clearInterval(this._tick);
    window.removeEventListener('message', this._listener);
    this.container.replaceChildren();
  }
}

/* ------------------------------------------------------------------ *
 * Twitch
 * ------------------------------------------------------------------ */

export class TwitchAdapter extends BaseAdapter {
  constructor(container, source) {
    super(source);
    this.container = container;
    this.player = null;
    this._ready = false;
    this._tick = null;
  }

  async load(source) {
    this.source = source;
    await loadScript('https://player.twitch.tv/js/embed/v1.js', 'Twitch');
    const mount = document.createElement('div');
    mount.style.width = '100%';
    mount.style.height = '100%';
    this.container.replaceChildren(mount);

    const isVideo = source.id.startsWith('video:');
    const options = {
      width: '100%',
      height: '100%',
      parent: [location.hostname],
      autoplay: false,
    };
    if (isVideo) options.video = source.id.slice(6);
    else options.channel = source.id;

    this.player = new window.Twitch.Player(mount, options);
    this.player.addEventListener(window.Twitch.Player.READY, () => {
      this._ready = true;
      this.emit('ready', { duration: this.duration });
    });
    this.player.addEventListener(window.Twitch.Player.PLAY, () => this.emit('play', { position: this.position }));
    this.player.addEventListener(window.Twitch.Player.PAUSE, () => this.emit('pause', { position: this.position }));

    clearInterval(this._tick);
    this._tick = setInterval(() => {
      if (this._ready) this.emit('time', { position: this.position, duration: this.duration });
    }, 1000);
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  get position() {
    try { return this._ready ? this.player.getCurrentTime() || 0 : 0; } catch { return 0; }
  }
  get duration() {
    try { return this._ready ? this.player.getDuration() || 0 : 0; } catch { return 0; }
  }
  get paused() {
    try { return !this._ready || this.player.isPaused(); } catch { return true; }
  }

  play() { if (this._ready) this.player.play(); }
  pause() { if (this._ready) this.player.pause(); }
  seek(seconds) { if (this._ready) this.player.seek(seconds); }
  setVolume(v) { if (this._ready) this.player.setVolume(clamp(v, 0, 1)); }
  setMuted(m) { if (this._ready) this.player.setMuted(m); }
  destroy() {
    clearInterval(this._tick);
    this.container.replaceChildren();
  }
}

/* ------------------------------------------------------------------ */

export function createAdapter({ kind, video, container, source }) {
  switch (kind) {
    case 'youtube': return new YouTubeAdapter(container, source);
    case 'dailymotion': return new DailymotionAdapter(container, source);
    case 'vimeo': return new VimeoAdapter(container, source);
    case 'twitch': return new TwitchAdapter(container, source);
    case 'file':
    case 'hls':
    default: return new DirectAdapter(video, source);
  }
}

const scriptCache = new Map();

export function loadScript(src, globalName = null, isReady = null) {
  const alreadyLoaded = () => {
    if (typeof isReady === 'function') return Boolean(isReady());
    if (globalName) return Boolean(window[globalName]);
    return false;
  };
  if (alreadyLoaded()) return Promise.resolve();
  const existing = scriptCache.get(src);
  if (existing) return existing;

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    const timer = setTimeout(() => reject(new Error('script timeout: ' + src)), 12_000);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('script failed: ' + src)); };
    document.head.append(script);

    // YouTube's API calls a global callback instead of firing load in some builds.
    if (src.includes('youtube.com/iframe_api')) {
      const wait = setInterval(() => {
        if (window.YT?.Player) { clearInterval(wait); clearTimeout(timer); resolve(); }
      }, 120);
      setTimeout(() => clearInterval(wait), 15_000);
    }
  }).catch((err) => {
    scriptCache.delete(src);
    throw err;
  });

  scriptCache.set(src, promise);
  return promise;
}

function mediaErrorMessage(error) {
  if (!error) return 'The video could not be loaded.';
  switch (error.code) {
    case 1: return 'Loading was aborted.';
    case 2: return 'Network problem while buffering.';
    case 3: return 'This file is damaged or not supported here.';
    case 4: return 'This format is not supported by this browser (try Chrome or Safari).';
    default: return 'The video could not be loaded.';
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
