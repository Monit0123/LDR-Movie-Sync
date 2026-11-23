# LDR Sync Protocol (v1)

All clients (web, Android, macOS) speak the same tiny JSON protocol over a single
WebSocket connection. The server is a dumb relay: it keeps a list of peers per
room and fans out every message to the other peers in that room. It never stores
video data, and it never proxies media — each device loads the media itself and
buffers it natively. Only *state* travels over the wire.

Endpoint: `wss://<host>/ws?room=<CODE>&name=<NAME>&device=<android|mac|web>`

## Clock synchronisation

Every client keeps `offset = serverTime - localTime`.

```
client → { "t": "ping", "c": <clientSendMs> }        (sent every 5 s)
server → { "t": "pong", "c": <clientSendMs>, "s": <serverMs> }

rtt    = now - c
offset = s - (c + rtt / 2)
```

`serverNow() = Date.now() + offset`.

## Messages

| type      | direction | fields                                             |
|-----------|-----------|----------------------------------------------------|
| `hello`   | both      | `room`, `name`, `device`                           |
| `peers`   | server→c  | `peers: [{id, name, device}]`                      |
| `media`   | both      | `source`, `position`, `paused`, `issuedAt`         |
| `play`    | both      | `position`, `issuedAt`                             |
| `pause`   | both      | `position`, `issuedAt`                             |
| `seek`    | both      | `position`, `issuedAt`                             |
| `rate`    | both      | `rate`, `position`, `issuedAt`                     |
| `buffer`  | both      | `buffering: bool`                                  |
| `chat`    | both      | `text`                                             |
| `ping`    | c→s       | `c`                                                |
| `pong`    | s→c       | `c`, `s`                                           |
| `bye`     | both      | —                                                  |

`issuedAt` is the **sender's `serverNow()`** — i.e. the shared clock, not the
local wall clock. Receivers compute:

```
expected = position + (paused ? 0 : (serverNow() - issuedAt) / 1000)
```

and ignore the command when `serverNow() - issuedAt > 15000` (stale).

### Drift correction

While both sides are playing, every client sends `play` with its current
position every 4 s. A receiver only re-seeks if `|local - expected| > 0.9 s`, so
normal decoder jitter does not cause stutter. Anyone may drive; there is no
"host" privilege — whoever touches the controls wins. (A `driver` hint is
carried in `rate`/`seek` messages so UIs can show "Ana is controlling".)

## Source object

```json
{
  "kind": "file" | "youtube" | "dailymotion" | "vimeo" | "hls" | "page",
  "url":  "https://...",      // direct media URL for file/hls
  "pageUrl": "https://...",   // original page (shown in the UI)
  "id": "x7tgad0",            // platform video id for youtube/dailymotion/vimeo
  "title": "Big Buck Bunny",
  "duration": 596.0
}
```

`kind: "page"` means "open this page in the in-app browser and let the JS
bridge find the `<video>` tag" — used as the last-resort fallback on native
clients that embed a real browser engine.
