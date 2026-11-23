import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderShim, isShimHost } from '../src/shim.js';

test('platform players are accepted and keep their query string', () => {
  for (const url of [
    'https://www.youtube.com/embed/dQw4w9WgXcQ?playsinline=1&rel=0',
    'https://player.vimeo.com/video/76979871',
    'https://www.dailymotion.com/embed/video/x8jfq2w',
    'https://player.twitch.tv/?video=123',
    'https://youtu.be/dQw4w9WgXcQ',
  ]) {
    const shim = renderShim(url);
    assert.equal(shim.status, 200, url);
    assert.equal(shim.target, new URL(url).href);
  }
});

test('the shim navigates in JS so the referrer survives', () => {
  const shim = renderShim('https://www.youtube.com/embed/abc123');
  assert.match(shim.html, /location\.replace\("https:\/\/www\.youtube\.com\/embed\/abc123"\)/);
  // A meta/header referrer policy of `no-referrer` would defeat the whole point.
  assert.match(shim.html, /name="referrer" content="strict-origin-when-cross-origin"/);
  assert.doesNotMatch(shim.html, /no-referrer/);
});

test('anything else is refused, so the shim is not an open redirect', () => {
  const refused = [
    'https://example.com/',
    'https://evil.test/?x=https://youtube.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://127.0.0.1:8080/',
    '',
    'not a url',
    null,
  ];
  for (const url of refused) {
    assert.equal(renderShim(url).status, 400, `should refuse ${url}`);
  }
});

test('host matching ignores look-alike domains', () => {
  assert.ok(isShimHost('www.youtube.com'));
  assert.ok(isShimHost('youtube.com'));
  assert.ok(isShimHost('player.vimeo.com'));
  assert.equal(isShimHost('evilyoutube.com'), false);
  assert.equal(isShimHost('youtube.com.evil.test'), false);
  assert.equal(isShimHost('notyoutube.com'), false);
});

test('a script-closing payload cannot break out of the page', () => {
  const shim = renderShim('https://www.youtube.com/embed/x</script><script>alert(1)</script>');
  assert.equal(shim.status, 200);
  // Exactly one </script> — our own; anything the caller sent is neutralised
  // (the URL parser percent-encodes it, and the literal escapes '<' as \u003c).
  assert.equal(shim.html.split('</script>').length - 1, 1);
  assert.doesNotMatch(shim.html, /<script>alert/);
});
