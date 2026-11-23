/**
 * The referrer shim.
 *
 * YouTube refuses to start a player when the request carries no HTTP Referer —
 * the user sees "Video player configuration error, error 153". A WebView (or a
 * browser's address bar) that navigates straight to `/embed/<id>` sends no
 * referer at all, so the player refuses to run even though the video itself is
 * perfectly embeddable.
 *
 * `/embed?u=<player url>` answers that: it is a real page served from the relay
 * origin, and it navigates to the player from that document. The browser then
 * attaches `Referer: <relay>/embed?...`, which is exactly what a page that
 * embedded the video would have sent.
 *
 * The hop has to happen in JS: a 302/follow-up request does not reliably carry
 * the original page's referrer.
 */

/** Hosts whose players need a referrer before they will start. */
const SHIM_HOSTS = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'dailymotion.com',
  'vimeo.com',
  'twitch.tv',
];

export function isShimHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return SHIM_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function page(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="strict-origin-when-cross-origin" />
<title>FlickSync</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b10; color: #cfd3e1; }
  body { display: grid; place-items: center; padding: 24px; text-align: center;
         font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  a { color: #7aa2ff; }
</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Turn the requested player URL into the shim page.
 * @returns {{ status: number, html: string, target?: string }}
 */
export function renderShim(rawUrl) {
  let target;
  try {
    target = new URL(String(rawUrl || ''));
  } catch {
    return { status: 400, html: page('<p>That video link is missing or malformed.</p>') };
  }

  if (!/^https?:$/.test(target.protocol) || !isShimHost(target.hostname)) {
    return {
      status: 400,
      html: page('<p>FlickSync only opens players it knows how to sync.</p>'),
    };
  }

  const href = target.href;
  // Escape for a JS string literal: a stray </script> must not end the block.
  const literal = JSON.stringify(href).replace(/</g, '\\u003c');

  return {
    status: 200,
    target: href,
    html: page(
      `<div>
  <p>Opening the player…</p>
  <p><a href="${escapeHtml(href)}">Tap here if nothing happens</a></p>
</div>
<script>location.replace(${literal});</script>`,
    ),
  };
}
