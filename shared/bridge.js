/*
 * FlickSync in-page bridge — one script, two hosts.
 *
 * Android loads it from assets and talks to `window.FlickSyncNative`.
 * macOS loads it from the app bundle and talks to `webkit.messageHandlers.flickSync`.
 *
 * It finds the page's real <video>, reports its state, and accepts commands.
 * Sites replace their <video> on quality changes, so everything re-scans.
 *
 * Most streaming sites do not put the player in the top document: the watch
 * page embeds a *different host* (vidsrc, 2embed, an embed.su-style player) in
 * an <iframe>, and the <video> lives in there. A page script can never reach
 * into a cross-origin frame, so when we find no <video> we report the frames we
 * can see. The native side then navigates *into* the best one — after that the
 * player is the top document and this script can drive it.
 */
(function () {
  if (window.__flicksync) {
    try { window.__flicksync.scan(); } catch (e) {}
    return;
  }

  var S = { video: null, lastEmit: 0, lastFrames: 0, frameSig: '' };

  // Frames we would rather open: player-ish URLs, decent size.
  var FRAME_HINT = /(embed|player|watch|video|movie|stream|play|media|vsrc|vidlink|2embed)/i;
  // Frames that are never the player: ad slots and trackers.
  var FRAME_NOISE =
    /(doubleclick|googlesyndication|adservice|adsystem|adnxs|taboola|outbrain|popunder|banner|promo|analytics|facebook\.com|google\.com\/recaptcha)/i;

  function post(obj) {
    var payload;
    try {
      payload = JSON.stringify(obj);
    } catch (e) {
      return;
    }
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.flickSync) {
        window.webkit.messageHandlers.flickSync.postMessage(payload);
        return;
      }
      if (window.FlickSyncNative && window.FlickSyncNative.onEvent) {
        window.FlickSyncNative.onEvent(payload);
      }
    } catch (e) {}
  }

  function send(type, extra) {
    try {
      var v = S.video;
      var payload = {
        type: type,
        position: v ? v.currentTime : 0,
        duration: v && isFinite(v.duration) ? v.duration : 0,
        paused: v ? v.paused : true,
        src: v ? v.currentSrc || v.src || '' : '',
        title: (document.title || location.hostname || '').slice(0, 160),
        url: location.href,
        rate: v && v.playbackRate ? v.playbackRate : 1
      };
      if (extra) {
        for (var k in extra) payload[k] = extra[k];
      }
      post(payload);
    } catch (e) {}
  }

  function attach(v) {
    if (!v || v.__flicksyncBound) return;
    v.__flicksyncBound = true;
    v.addEventListener('play', function () { send('play'); });
    v.addEventListener('playing', function () { send('play'); });
    v.addEventListener('pause', function () { if (!v.ended) send('pause'); });
    v.addEventListener('seeked', function () { send('seeked'); });
    v.addEventListener('ended', function () { send('ended'); });
    v.addEventListener('loadedmetadata', function () { send('ready'); });
    v.addEventListener('waiting', function () { send('buffer', { buffering: true }); });
    v.addEventListener('canplay', function () { send('buffer', { buffering: false }); });
    v.addEventListener('timeupdate', function () {
      var now = Date.now();
      if (now - S.lastEmit < 700) return;
      S.lastEmit = now;
      send('time');
    });
  }

  /**
   * Every <video> we are allowed to touch. Same-origin frames are fair game —
   * plenty of sites put the player in a frame served from their own host.
   */
  function collectVideos(root, out, depth) {
    if (!root || depth > 2) return out;
    var found = [];
    try { found = root.querySelectorAll ? root.querySelectorAll('video') : []; } catch (e) { found = []; }
    for (var i = 0; i < found.length; i++) out.push(found[i]);

    var frames = [];
    try { frames = root.querySelectorAll ? root.querySelectorAll('iframe') : []; } catch (e) { frames = []; }
    for (var j = 0; j < frames.length; j++) {
      var doc = null;
      try { doc = frames[j].contentDocument; } catch (e) { doc = null; } // cross-origin → null
      if (doc) collectVideos(doc, out, depth + 1);
    }
    return out;
  }

  function pick() {
    var list = collectVideos(document, [], 0);
    if (!list.length) return null;
    list.sort(function (a, b) {
      var ap = a.currentTime > 0 && !a.paused ? 1 : 0;
      var bp = b.currentTime > 0 && !b.paused ? 1 : 0;
      if (ap !== bp) return bp - ap;
      var av = (a.clientWidth || 0) * (a.clientHeight || 0);
      var bv = (b.clientWidth || 0) * (b.clientHeight || 0);
      return bv - av;
    });
    return list[0];
  }

  /** Cross-origin frames on this page, best candidate first. */
  function frameList() {
    var out = [];
    var seen = {};
    var frames = [];
    try { frames = document.querySelectorAll('iframe'); } catch (e) { return out; }

    for (var i = 0; i < frames.length; i++) {
      var el = frames[i];
      var raw =
        el.getAttribute('src') ||
        el.getAttribute('data-src') ||
        el.getAttribute('data-lazy-src') ||
        el.getAttribute('data-original') ||
        '';
      if (!raw || /^(about:blank|javascript:|data:|blob:)/i.test(raw)) continue;

      var url;
      try { url = new URL(raw, location.href).href; } catch (e) { continue; }
      if (!/^https?:/i.test(url) || seen[url]) continue;
      if (FRAME_NOISE.test(url)) continue;
      // A media file must never be treated as a page to navigate into.
      if (/\.(mp4|m4v|webm|mkv|mov|m3u8|mpd)(\?|#|$)/i.test(url)) continue;

      var w = el.clientWidth || 0;
      var h = el.clientHeight || 0;
      if (w > 0 && h > 0 && (w < 220 || h < 120)) continue;

      // How much of the window the frame covers. A real player fills it; a
      // 300×250 ad slot does not — and hopping into an ad is worse than doing
      // nothing at all.
      var viewport =
        (window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0) *
        (window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0);
      var ratio = viewport > 0 && w > 0 && h > 0 ? (w * h) / viewport : 0;

      var score = 0;
      if (FRAME_HINT.test(url)) score += 10;
      if (ratio >= 0.35) score += 6;
      if (el.allowFullscreen || el.hasAttribute('allowfullscreen') || /fullscreen/i.test(el.getAttribute('allow') || '')) {
        score += 3;
      }

      seen[url] = 1;
      out.push({ url: url, score: score, w: w, h: h, ratio: Math.round(ratio * 100) / 100 });
    }

    out.sort(function (a, b) {
      return b.score - a.score || b.ratio - a.ratio || b.w * b.h - a.w * a.h;
    });
    return out.slice(0, 8);
  }

  /** Tell the native side where the player probably lives. */
  function reportFrames() {
    var list = frameList();
    if (!list.length) return;

    var sig = '';
    for (var i = 0; i < list.length; i++) sig += list[i].url + '|';
    var now = Date.now();
    // Re-announce when the page changes its frames, and occasionally otherwise
    // (players are often injected a few seconds after the page renders).
    if (sig === S.frameSig && now - S.lastFrames < 5000) return;
    S.frameSig = sig;
    S.lastFrames = now;
    send('frames', { frames: list, count: list.length });
  }

  function scan() {
    var v = pick();
    if (v && v !== S.video) {
      S.video = v;
      attach(v);
      send('detected');
    } else if (v) {
      attach(v);
    }
    if (!v) reportFrames();
  }

  window.__flicksync = {
    scan: scan,
    state: function () { send('state'); },
    frames: frameList,
    apply: function (cmd) {
      scan();
      var v = S.video || pick();
      if (!v) return false;
      try {
        if (cmd.muted !== undefined && cmd.muted !== null) v.muted = !!cmd.muted;
        if (cmd.rate) v.playbackRate = Math.min(2, Math.max(0.25, cmd.rate));
        if (cmd.position !== undefined && isFinite(cmd.position)) {
          var drift = Math.abs(v.currentTime - cmd.position);
          var tolerance = cmd.tolerance || 0.35;
          if (drift > tolerance) {
            try { v.currentTime = cmd.position; } catch (e) {}
          }
        }
        if (cmd.cmd === 'play') {
          var p = v.play();
          if (p && p.catch) {
            p.catch(function () {
              // Autoplay policy: start muted, the native side offers an unmute button.
              try { v.muted = true; v.play(); send('blocked'); } catch (e) {}
            });
          }
        } else if (cmd.cmd === 'pause') {
          v.pause();
        }
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  setInterval(scan, 700);
  document.addEventListener('play', function (e) {
    if (e.target && e.target.tagName === 'VIDEO') {
      S.video = e.target;
      attach(e.target);
      send('play');
    }
  }, true);
  document.addEventListener('DOMContentLoaded', scan);
  window.addEventListener('load', function () {
    setTimeout(scan, 300);
    setTimeout(scan, 1200);
    setTimeout(scan, 3000);
  });
  scan();
})();
