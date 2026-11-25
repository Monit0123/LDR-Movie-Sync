/**
 * Exercises the shared in-page bridge (shared/bridge.js) against a fake DOM.
 *
 * The bridge runs inside a WebView, so this is the only place its frame
 * heuristic can be tested without a device. The rule that matters: never hand
 * back an ad slot as "the player", because the apps navigate into whatever
 * comes first and an ad redirect would close the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../shared/bridge.js', import.meta.url)), 'utf8');

function frame(attrs, box) {
  return {
    getAttribute: (key) => (key in attrs ? attrs[key] : null),
    hasAttribute: (key) => key in attrs,
    clientWidth: box[0],
    clientHeight: box[1],
    get contentDocument() {
      return null; // cross-origin
    },
  };
}

function run(frames, viewport = [1280, 720], extra = {}) {
  const events = [];
  const nodes = extra.nodes || [];
  const window = {
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    addEventListener() {},
    FlickSyncNative: { onEvent: (payload) => events.push(JSON.parse(payload)) },
  };
  const document = {
    title: 'Some site',
    documentElement: { clientWidth: viewport[0], clientHeight: viewport[1] },
    querySelectorAll: (selector) => {
      if (selector === 'iframe') return frames;
      if (selector === '*') return nodes;
      return [];
    },
    addEventListener() {},
  };

  const context = vm.createContext({
    window,
    document,
    location: { href: 'https://site.test/movie/1/watch', hostname: 'site.test' },
    URL,
    Date,
    JSON,
    Math,
    isFinite,
    setInterval: () => 0,
    setTimeout: () => 0,
  });

  vm.runInContext(source, context);
  return { api: window.__flicksync, events };
}

test('the player frame outranks an ad slot, and ads are dropped entirely', () => {
  const { api } = run([
    frame({ src: 'https://ads.example/banner/300x250' }, [300, 250]),
    frame({ src: 'https://vidsrc.to/embed/movie/1611767', allowfullscreen: '' }, [1280, 700]),
    frame({ src: 'https://doubleclick.net/adframe' }, [970, 250]),
  ]);

  const frames = api.frames();
  assert.equal(frames.length, 1, 'only the player should survive');
  assert.equal(frames[0].url, 'https://vidsrc.to/embed/movie/1611767');
  assert.ok(frames[0].ratio >= 0.9, `expected near-full-screen, got ${frames[0].ratio}`);
});

test('a media file is never offered as a page to navigate into', () => {
  const { api } = run([
    frame({ src: 'https://cdn.example/movie/trailer.mp4' }, [1280, 700]),
    frame({ src: 'https://cdn.example/live/stream.m3u8?t=1' }, [1280, 700]),
  ]);
  // (the array is created in the sandbox realm, so compare lengths)
  assert.equal(api.frames().length, 0);
});

test('a small side frame is never dominant, even if it is player-shaped', () => {
  const { api } = run([frame({ src: 'https://player.example/embed/abc' }, [320, 180])]);
  const frames = api.frames();
  assert.equal(frames.length, 1);
  assert.ok(frames[0].ratio < 0.30, 'the native side must refuse to hop into this');
});

test('lazy frames are found, duplicates collapse, unknown sizes report zero', () => {
  const { api } = run([
    frame({ 'data-src': 'https://2embed.cc/embed/1611767' }, [0, 0]),
    frame({ src: 'https://2embed.cc/embed/1611767' }, [0, 0]),
    frame({ src: 'about:blank' }, [1280, 720]),
  ]);
  const frames = api.frames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].url, 'https://2embed.cc/embed/1611767');
  assert.equal(frames[0].w, 0);
  assert.equal(frames[0].ratio, 0);
});

test('a video inside a shadow root is found and reported', () => {
  const video = {
    tagName: 'VIDEO',
    currentTime: 12,
    paused: false,
    ended: false,
    duration: 600,
    currentSrc: 'blob:https://photos.google.com/abc',
    clientWidth: 640,
    clientHeight: 360,
    addEventListener() {},
  };
  const host = {
    tagName: 'DIV',
    shadowRoot: { querySelectorAll: (selector) => (selector === '*' || selector === 'video' ? [video] : []) },
  };

  const { events } = run([], [1280, 720], { nodes: [host] });
  const detected = events.filter((event) => event.type === 'detected');
  assert.equal(detected.length, 1, 'the shadow video should be detected');
  assert.equal(detected[0].src, 'blob:https://photos.google.com/abc');

  const probe = events.filter((event) => event.type === 'probe').pop();
  assert.equal(probe.videos, 1);
});

test('an empty page reports itself instead of staying silent', () => {
  const { events } = run([]);
  const probe = events.filter((event) => event.type === 'probe').pop();
  assert.equal(probe.videos, 0);
  assert.equal(probe.frames, 0);
  assert.equal(probe.host, 'site.test');
});
