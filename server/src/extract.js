/**
 * "Paste a page, get something playable."
 *
 * The phones/TVs do the real work with their own native players; this module only
 * answers the question *which media does this page point at?* so that both sides
 * end up loading the very same stream instead of one person's screen.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|m3u8|mpd)(\?|#|$)/i;

export async function resolveUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw badRequest('url required');
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1])) throw badRequest('only http(s) urls');
  if (!scheme) raw = 'https://' + raw;

  let parsed;
  try { parsed = new URL(raw); } catch { throw badRequest('that is not a URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw badRequest('only http(s) urls');
  assertPublicHost(parsed.hostname);

  const platform = detectPlatform(parsed);
  if (platform) return enrich(platform);

  if (MEDIA_EXT.test(parsed.pathname)) {
    return {
      kind: /\.m3u8$/i.test(parsed.pathname) ? 'hls' : 'file',
      url: parsed.toString(),
      pageUrl: parsed.toString(),
      title: decodeURIComponent(parsed.pathname.split('/').pop() || 'video'),
    };
  }

  const page = await fetchText(parsed.toString());
  const candidates = scrapeMedia(page.html, page.finalUrl);
  const title = pickMeta(page.html, ['og:title', 'twitter:title', 'title']) || parsed.hostname;

  if (candidates.length === 0) {
    return {
      kind: 'page',
      url: parsed.toString(),
      pageUrl: parsed.toString(),
      title,
      candidates: [],
      note: 'No direct media found. Native apps will open this page in the built-in browser and sync whatever <video> it finds.',
    };
  }

  const best = candidates[0];
  return {
    kind: /\.m3u8$/i.test(best.url) ? 'hls' : 'file',
    url: best.url,
    pageUrl: page.finalUrl,
    title: best.title || title,
    candidates: candidates.slice(0, 8),
  };
}

function detectPlatform(url) {
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');

  if (host === 'youtu.be') {
    return embed('youtube', url.pathname.slice(1).split('/')[0], url);
  }
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const v = url.searchParams.get('v');
    const shorts = url.pathname.match(/\/shorts\/([\w-]{6,})/);
    const live = url.pathname.match(/\/live\/([\w-]{6,})/);
    const emb = url.pathname.match(/\/embed\/([\w-]{6,})/);
    const id = v || shorts?.[1] || live?.[1] || emb?.[1];
    if (id) return embed('youtube', id, url);
  }

  const dm = url.pathname.match(/\/video\/([a-zA-Z0-9]+)/) || url.pathname.match(/^\/embed\/video\/([a-zA-Z0-9]+)/);
  if (dm) return embed('dailymotion', dm[1], url);
  if (host === 'dai.ly') {
    const id = url.pathname.slice(1).split('?')[0];
    if (id) return embed('dailymotion', id, url);
  }

  if (host.endsWith('vimeo.com')) {
    const id = url.pathname.match(/(\d{6,})/)?.[1];
    if (id) return embed('vimeo', id, url);
  }

  if (host.endsWith('twitch.tv')) {
    const v = url.pathname.match(/\/videos\/(\d+)/)?.[1];
    const c = url.pathname.slice(1).split('/')[0];
    if (v) return embed('twitch', `video:${v}`, url);
    if (c) return embed('twitch', c, url);
  }

  return null;
}

function embed(kind, id, url) {
  return { kind, id, url, pageUrl: url.toString(), title: `${kind} · ${id}` };
}

/**
 * Platform embeds carry no title; ask the site's public oEmbed endpoint.
 * Best effort only — a failure just keeps the fallback title.
 */
async function enrich(source) {
  const endpoints = {
    youtube: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(source.pageUrl)}`,
    dailymotion: `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent(source.pageUrl)}`,
    vimeo: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(source.pageUrl)}`,
  };
  const endpoint = endpoints[source.kind];
  if (!endpoint) return source;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(endpoint, { signal: controller.signal, headers: { 'user-agent': UA } });
    clearTimeout(timer);
    if (!res.ok) return source;
    const json = await res.json();
    if (json?.title) source.title = String(json.title).slice(0, 200);
    if (json?.duration && Number(json.duration) > 0) source.duration = Number(json.duration);
    if (json?.thumbnail_url) source.thumbnail = String(json.thumbnail_url);
  } catch { /* keep the fallback */ }
  return source;
}

/** Pull every plausible media URL out of an HTML page, best first. */
export function scrapeMedia(html, baseUrl) {
  const found = new Map();
  const add = (raw, title, score) => {
    if (!raw) return;
    let absolute;
    try { absolute = new URL(decodeEntities(raw.trim()), baseUrl).toString(); } catch { return; }
    if (!/^https?:/i.test(absolute)) return;
    if (!MEDIA_EXT.test(new URL(absolute).pathname)) return;
    const previous = found.get(absolute);
    if (previous && previous.score >= score) return;
    found.set(absolute, { url: absolute, title, score });
  };

  for (const [name, score] of [
    ['og:video:secure_url', 100],
    ['og:video:url', 95],
    ['og:video', 90],
    ['twitter:player:stream', 85],
  ]) {
    add(pickMeta(html, [name]), null, score);
  }

  for (const m of html.matchAll(/<video[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1], null, 80);
  for (const m of html.matchAll(/<source[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1], m[0].match(/\btitle=["']([^"']+)/i)?.[1], 70);
  for (const m of html.matchAll(/["']contentUrl["']\s*:\s*["']([^"']+)["']/gi)) add(m[1], null, 65);
  for (const m of html.matchAll(/["'](?:file|src|stream_url|hls|mp4)["']\s*:\s*["']([^"']+)["']/gi)) add(m[1], null, 50);
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8|webm|m4v|mpd)(?:\?[^\s"'<>\\]*)?/gi)) add(m[0], null, 40);
  // Relative download links are extremely common on "watch" pages.
  for (const m of html.matchAll(/(?:href|data-src|data-url)=["']([^"']+?\.(?:mp4|m3u8|webm|m4v|mpd)(?:\?[^"']*)?)["']/gi)) add(m[1], null, 30);

  return [...found.values()]
    .sort((a, b) => b.score - a.score || Number(/m3u8|mpd/i.test(a.url)) - Number(/m3u8|mpd/i.test(b.url)))
    .map(({ url, title }) => ({ url, title }));
}

function pickMeta(html, names) {
  for (const name of names) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return decodeEntities(m[1]);
    }
    if (name === 'title') {
      const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (m?.[1]) return decodeEntities(m[1].trim());
    }
  }
  return null;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) throw new Error(`site answered ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.startsWith('video/') || contentType.includes('mpegurl')) {
      return { html: '', finalUrl: res.url || url };
    }
    const text = await res.text();
    return { html: text.slice(0, 3_000_000), finalUrl: res.url || url };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('that site took too long to answer');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\\//g, '/');
}

/** Refuse to fetch loopback / private ranges (SSRF guard). */
export function assertPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host);
  if (blocked) throw badRequest('that host is not reachable from the server');
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
