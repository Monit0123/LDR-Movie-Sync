/*
 * FlickSync in-page bridge — one script, two hosts.
 *
 * Android loads it from assets and talks to `window.FlickSyncNative`.
 * macOS loads it from the app bundle and talks to `webkit.messageHandlers.flickSync`.
 *
 * It finds the page's real <video>, reports its state, and accepts commands.
 * Sites replace their <video> on quality changes, so everything re-scans.
 */
(function () {
  if (window.__flicksync) {
    try { window.__flicksync.scan(); } catch (e) {}
    return;
  }

  var S = { video: null, lastEmit: 0 };

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

  function pick() {
    var list = Array.prototype.slice.call(document.querySelectorAll('video'));
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

  function scan() {
    var v = pick();
    if (v && v !== S.video) {
      S.video = v;
      attach(v);
      send('detected');
    } else if (v) {
      attach(v);
    }
  }

  window.__flicksync = {
    scan: scan,
    state: function () { send('state'); },
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
