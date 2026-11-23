# FlickSync

**Two screens. One movie.** Watch the same video with someone far away — without screen sharing.

One of you presses play; the other device loads *the same video* and buffers it locally, at full
quality, on its own player. Only the timing travels over the network: `play`, `pause`, `seek`,
and a position every few seconds so drift self-corrects.

```
   Android (her)                    relay (tiny)                   MacBook (him)
 ┌───────────────┐                ┌────────────┐                ┌───────────────┐
 │ ExoPlayer     │  play/pause    │            │   play/pause   │ AVPlayer      │
 │ or WebView    │ ─────────────► │  1 process │ ─────────────► │ or WKWebView  │
 │ native buffer │ ◄───────────── │  no storage│ ◄───────────── │ native buffer │
 └───────────────┘   timestamps   └────────────┘   timestamps   └───────────────┘
        │                                                                 │
        └────────── the video itself is fetched separately ──────────────┘
                    (nothing is ever relayed, re-encoded or mirrored)
```

No accounts. No database. The relay keeps a room in memory and forgets it when you both leave.

---

## What you get

| Piece | What it is | Where |
|---|---|---|
| **Relay + web app** | Node server, service-worker PWA, zero config | `server/`, `web/` |
| **Android app** | Kotlin, ExoPlayer + contained browser, foreground service | `android/` → `.apk` |
| **macOS app** | SwiftUI, AVPlayer + WKWebView, media keys | `macos/` → `.dmg` |
| **Protocol** | The 8 message types both apps speak | `docs/PROTOCOL.md` |

The **web app is the fastest way to try it** — it works on macOS, Windows, Android Chrome and
iPhone today, no install. The native apps add background playback, a proper contained browser,
and keep the socket alive when the phone is locked.

---

## 1. Put the relay online (once, ~3 minutes)

You both need to talk to the same relay. Free tiers are more than enough: it only moves a few
bytes per second.

**Render (no CLI):** push this repo to GitHub → Render dashboard → *New → Blueprint* → pick the
repo (it reads `render.yaml`) → deploy. You get `https://flicksync-xxxx.onrender.com`.

**Docker / any VPS:**

```bash
docker build -t flicksync .
docker run -p 8080:8080 flicksync
```

**Locally, for testing:**

```bash
cd server
npm install
npm start            # http://localhost:8080
```

Open the URL — that's the whole app. The same origin serves the web client, the WebSocket
(`/ws`), and the link resolver (`/api/extract`).

> `.example.com` in the app's server field is a placeholder. Replace it with your deployment.

---

## 2. Install the apps

Ready-built binaries are committed in [`downloads/`](downloads/) **and** attached to the
[**v1.0.2 release**](https://github.com/Monit0123/LDR-Movie-Sync/releases/latest):

| File | Install |
|---|---|
| [`downloads/FlickSync-Android.apk`](downloads/FlickSync-Android.apk) | Android: open it, allow "install unknown apps". Debug-signed, so it installs directly. |
| [`downloads/FlickSync-Mac.dmg`](downloads/FlickSync-Mac.dmg) | macOS: open, drag **FlickSync** into Applications. Universal (Apple Silicon + Intel). |

`downloads/SHA256SUMS.txt` has the checksums, and
[`downloads/VERIFICATION.txt`](downloads/VERIFICATION.txt) is a mount-and-launch report
produced on a real Mac (universal binary, ad-hoc signature verified, app starts cleanly).

Both are built by CI on every push; tag `v1.0.3` (or any `v*`) to publish a fresh pair.
To ship a *signed* store-ready APK, add `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`
and `KEY_PASSWORD` as repository secrets — the workflow switches to `assembleRelease` on its own.

Building locally:

```bash
# Android (needs JDK 17 + Android SDK)
cd android
gradle wrapper --gradle-version 8.7     # once, generates ./gradlew
./gradlew :app:assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease          # needs RELEASE_STORE_FILE etc. in ~/.gradle/gradle.properties

# macOS (needs Xcode command line tools)
cd macos
./build.sh                              # → dist/FlickSync.app + dist/FlickSync.dmg
```

Point the builds at your relay either in the app (**Lobby → Server**) or at build time:

```bash
./gradlew :app:assembleDebug -Pflicksync.server.url=https://flicksync-xxxx.onrender.com
```

First launch on macOS: right-click → **Open** (or `xattr -dr com.apple.quarantine /Applications/FlickSync.app`).
The app is ad-hoc signed, not notarised.

---

## 3. Watch something

1. Her phone: open FlickSync → name + **Start a new room** → send him the 6-character code.
2. His Mac: same code → **Join room**.
3. Either side pastes a link → **Load**. It appears on the other screen within a second.
4. Either of you can pause, seek, or skip ahead. Both screens follow.

Details that make it feel effortless:

* **Drift correction.** While both are playing, each side broadcasts its position every 4 s. If
  you're more than ~0.9 s off, you're nudged back — so a hiccup in her mobile stream never
  leaves you half a scene apart.
* **Wait for each other.** If her phone starts buffering, his Mac pauses and shows
  *"Waiting for Ana…"*, then resumes together. Toggle in the side panel.
* **Background.** Android runs a foreground service, so the socket and decoder stay alive when
  the screen locks. macOS keeps playing with the window behind others; media keys work.
* **A ping every 5 s** keeps the clock offset estimate honest even on a flaky connection.

---

## What plays where

| Link type | Example | How it plays |
|---|---|---|
| Direct media (`.mp4`, `.m3u8`, `.mpd`) | a CDN file, an HLS stream | **Native player on both devices** (ExoPlayer / AVPlayer). Best quality, fully local buffering. |
| YouTube / Dailymotion / Vimeo | `dailymotion.com/video/x8…` | The **contained browser** opens the platform's own player as the top document on each device, and the injected bridge syncs its `<video>`. Both sides stream it themselves. |
| Any other page with a video | a blog, an embed, a sketchy streaming site | Contained browser detects the `<video>` and mirrors the page + playhead. If the page exposes a direct stream URL, the other side plays it natively instead. |
| A page the relay can scrape | most "watch" pages | `/api/extract` pulls the real media URL out, so both devices use the native player. |

### Honest limitations

* **DRM services** (Netflix, Prime Video, Disney+, Spotify) will not work. Their players refuse
  to run outside their own apps and the streams are encrypted end-to-end. Nothing can fix that
  short of screen sharing.
* **Local files** on her phone can't be streamed to the Mac (that would be screen sharing).
  Put the file somewhere both can reach — a direct link, or any static host.
* **Autoplay with sound** is blocked by browsers until one user gesture. The apps start muted and
  show a *Tap for sound* pill; after one tap it's unlocked for the session.
* **Twitch** is best-effort (the embed requires a matching parent domain); direct `.m3u8` is
  better when available.
* **"Video player configuration error, error 153"** is YouTube refusing to start a player whose
  request carried no `Referer`. The apps bounce the navigation through the relay
  (`/embed?u=…`, a real page on your own origin) so the player always gets one. If you still see
  153, that app is older than v1.0.3.

---

## Repository map

```
server/                 relay + link resolver + static web host
  src/relay.js          rooms, fan-out, heartbeats, whitelist of relayed messages
  src/extract.js        "which media does this page point at?" + SSRF guard
  src/index.js          http + /ws + static
  test/                 node:test suite (npm test)
web/                    the app everyone can open right now
  sync.js               protocol client: clock offset, reconnect, typed sends
  players.js            five engines behind one interface (video, YouTube, DM, Vimeo, Twitch)
  app.js                sync engine + UI glue (drift loop lives here)
android/                Kotlin app: ExoPlayer, contained browser, foreground service
macos/                  SwiftUI app: AVPlayer, WKWebView, menu commands
shared/bridge.js        the in-page detector used by BOTH native apps
docs/PROTOCOL.md        message formats and the clock maths
```

## The sync maths, in three lines

```js
offset    = median(serverTime - (sendTime + rtt/2))   // shared clock
expected  = position + (serverNow - issuedAt)/1000    // where the playhead should be
if (|local - expected| > 0.9s) seek(expected)         // correct only real drift
```

Stale commands (>15 s) are ignored, so a phone that wakes from sleep doesn't yank the movie
backwards.

## Testing

```bash
cd server && npm test      # 10 tests: rooms, relay whitelist, clock, scraping, SSRF
```

## Privacy

The relay sees: room code, two display names, and messages like
`{"t":"seek","position":412.5}`. It never sees the video, and it stores nothing on disk.
Room state is destroyed when the last device disconnects.
