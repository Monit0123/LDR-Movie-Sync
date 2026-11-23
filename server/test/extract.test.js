import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveUrl, scrapeMedia, scrapeFrames, assertPublicHost } from '../src/extract.js';

test('direct media links are recognised without any network call', async () => {
  const source = await resolveUrl('https://cdn.example.com/movies/Big.Buck.Bunny.mp4?token=1');
  assert.equal(source.kind, 'file');
  assert.equal(source.title, 'Big.Buck.Bunny.mp4');

  const hls = await resolveUrl('example.com/live/stream.m3u8');
  assert.equal(hls.kind, 'hls');
  assert.equal(hls.url, 'https://example.com/live/stream.m3u8');
});

test('platform links become embed sources with an id', async () => {
  const yt = await resolveUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10');
  assert.equal(yt.kind, 'youtube');
  assert.equal(yt.id, 'dQw4w9WgXcQ');

  const short = await resolveUrl('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(short.id, 'dQw4w9WgXcQ');

  const dm = await resolveUrl('https://www.dailymotion.com/video/x8jfq2w');
  assert.equal(dm.kind, 'dailymotion');
  assert.equal(dm.id, 'x8jfq2w');

  const vimeo = await resolveUrl('https://vimeo.com/76979871');
  assert.equal(vimeo.kind, 'vimeo');
  assert.equal(vimeo.id, '76979871');
});

test('private hosts are refused', () => {
  for (const host of ['localhost', '127.0.0.1', '192.168.1.4', '10.0.0.2', '172.20.1.1', '169.254.169.254', '[::1]', 'printer.local']) {
    assert.throws(() => assertPublicHost(host), /not reachable/, `${host} should be blocked`);
  }
  assert.doesNotThrow(() => assertPublicHost('dailymotion.com'));
});

test('scraping prefers og:video and normalises relative urls', () => {
  const html = `
    <html>
      <head>
        <meta property="og:title" content="A Film &amp; Friends" />
        <meta property="og:video:secure_url" content="/media/film.mp4?x=1" />
        <meta name="twitter:player:stream" content="https://cdn.example.com/low.mp4" />
      </head>
      <body>
        <video src="https://cdn.example.com/broken.webm"></video>
        <script>var player = {"file":"https://cdn.example.com/better.mp4"};</script>
        <a href="/download/other.m3u8">hls</a>
      </body>
    </html>`;

  const found = scrapeMedia(html, 'https://films.example.com/watch/1');
  assert.ok(found.length >= 3);
  assert.equal(found[0].url, 'https://films.example.com/media/film.mp4?x=1');
  assert.ok(found.some((c) => c.url.endsWith('better.mp4')));
  assert.ok(found.some((c) => c.url.endsWith('other.m3u8')));
});

test('nonsense input fails politely', async () => {
  await assert.rejects(() => resolveUrl('   '), /url required/);
  await assert.rejects(() => resolveUrl('ftp://example.com/a.mp4'), /only http/);
});

// --- frames -----------------------------------------------------------------

test('a watch page that frames its player is understood', () => {
  const html = `
    <html><head><title>Some Movie (2024)</title></head>
    <body>
      <div class="ad"><iframe src="https://doubleclick.net/adframe/9" width="300" height="50"></iframe></div>
      <div class="trailer"><iframe src="https://www.youtube.com/embed/trailer" width="640" height="360"></iframe></div>
      <div class="player">
        <iframe src="https://vidsrc.to/embed/movie/1611767" allowfullscreen width="960" height="540"></iframe>
      </div>
      <iframe data-src="https://2embed.cc/embed/1611767"></iframe>
    </body></html>`;

  const frames = scrapeFrames(html, 'https://7movies.ws/movie/1611767/watch');
  const urls = frames.map((f) => f.url);

  assert.ok(urls.includes('https://vidsrc.to/embed/movie/1611767'));
  assert.ok(urls.includes('https://2embed.cc/embed/1611767'), 'data-src frames count too');
  assert.ok(!urls.some((u) => u.includes('doubleclick')), 'ad frames are dropped');
  // The player-ish frame must outrank the plain trailer frame.
  assert.ok(urls.indexOf('https://vidsrc.to/embed/movie/1611767') < urls.indexOf('https://www.youtube.com/embed/trailer'));
});

test('frames are de-duplicated and resolved against the page', () => {
  const html = `
    <iframe src="/embed/1"></iframe>
    <iframe src="/embed/1"></iframe>
    <iframe src="/embed/2"></iframe>`;
  const frames = scrapeFrames(html, 'https://example.com/movie/9/watch');
  assert.equal(frames.length, 2);
  assert.ok(frames.every((f) => f.url.startsWith('https://example.com/embed/')));
});
