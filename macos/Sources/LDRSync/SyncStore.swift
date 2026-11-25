import AVFoundation
import Combine
import Foundation
import MediaPlayer
import SwiftUI

/// The brain. One room, one socket, one player, one clock.
///
/// Every screen in the app is a projection of this object; the relay only ever
/// sees timestamps and URLs.
@MainActor
final class SyncStore: ObservableObject {

    // connection
    @Published var connection: ConnectionState = .offline
    @Published var peers: [Peer] = []
    @Published var myID = ""
    @Published var room = ""
    @Published var name = ""
    @Published var serverURL = ""

    // media
    @Published var source: Source?
    @Published var isPlaying = false
    @Published var position: Double = 0
    @Published var duration: Double = 0
    @Published var buffering = false
    @Published var partnerBuffering = false
    @Published var engine: EngineKind = .native
    @Published var webURL: URL?
    /// The site that framed the player we are inside — used as the Referer,
    /// because embed players refuse to run for anyone else.
    var webEmbedder: String?
    private var webHops = 0
    private var probedURL: String?
    private var webSeen: Set<String> = []
    @Published var webCommand: WebCommand?
    @Published var needsUnmute = false
    @Published var hasItem = false

    // ui
    @Published var messages: [ChatMessage] = []
    @Published var recent: [Source] = []
    @Published var toast: String?
    @Published var waitForPartner = true
    @Published var autoCorrect = true
    @Published var busy = false
    @Published var theater = false
    @Published var showChat = false
    @Published var unread = 0
    @Published var volume: Double = 1.0 {
        didSet { player.volume = Float(volume); player.isMuted = volume == 0 }
    }
    @Published var muted = false {
        didSet { player.isMuted = muted }
    }

    let player = AVPlayer()

    private var client: SyncClient?
    private var timeObserver: Any?
    private var driftTimer: Timer?
    private var lastRemote: WireMessage?
    private var ignoreUntil = Date.distantPast
    private var lastHeartbeat: Double = 0
    private var lastBroadcast: Double = 0
    private var webPaused = true
    private var webPosition: Double = 0
    private var waitingForPartner = false
    private var loadedKey: String?
    private var toastWork: DispatchWorkItem?

    var partner: Peer? { peers.first { $0.id != myID } }

    init() {
        name = Defaults.name
        serverURL = Defaults.server
        room = Defaults.room
        recent = Defaults.recent
        player.volume = 1

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.4, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }
            Task { @MainActor in self.tickUI(time: time) }
        }

        driftTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.correctDrift() }
        }
        RunLoop.main.add(driftTimer!, forMode: .common)

        NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.isPlaying = false }
        }
    }

    // MARK: - room

    func join(code: String, name: String, server: String) {
        let cleaned = code.uppercased().filter { $0.isLetter || $0.isNumber }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count >= 4 else { flash("Room codes are at least 4 characters"); return }
        guard !trimmedName.isEmpty else { flash("Add your name first"); return }

        room = cleaned
        self.name = trimmedName
        serverURL = server.trimmingCharacters(in: .whitespacesAndNewlines)
        Defaults.name = trimmedName
        Defaults.server = serverURL
        Defaults.room = cleaned

        client?.close()
        let client = SyncClient()

        client.onStatus = { [weak self] ok in
            Task { @MainActor in
                guard let self else { return }
                self.connection = ok ? .online : .offline
                if !ok { self.peers = [] }
            }
        }
        client.onPeers = { [weak self] peers in
            Task { @MainActor in self?.peers = peers }
        }
        client.onWelcome = { [weak self] id, peers in
            Task { @MainActor in
                guard let self else { return }
                self.myID = id
                self.peers = peers
                self.connection = .online
                self.announceState()
            }
        }
        client.onEvent = { [weak self] message in
            Task { @MainActor in self?.handle(message) }
        }

        self.client = client
        connection = .connecting
        client.connect(base: self.serverURL, room: cleaned, name: trimmedName)
    }

    func leave() {
        client?.close()
        client = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        room = ""
        source = nil
        peers = []
        messages = []
        connection = .offline
        engine = .native
        webURL = nil
        hasItem = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// A late joiner has no state; push what we are watching so they can catch up.
    func announceState() {
        guard let client, let source else { return }
        client.load(source, position: currentPosition, paused: !isPlaying)
    }

    // MARK: - loading

    func load(_ incoming: Source, position startAt: Double = 0, paused: Bool = false, broadcast: Bool) {
        if incoming.isBrowserOnly, incoming.pageUrl == nil { return }

        source = incoming
        loadedKey = incoming.key
        rememberRecent(incoming)
        needsUnmute = false
        duration = incoming.duration ?? 0
        self.position = startAt

        webHops = 0
        webSeen.removeAll()
        webEmbedder = nil

        if incoming.isDirect, let url = incoming.playableURL {
            engine = .native
            webURL = nil
            player.pause()
            let item = AVPlayerItem(url: url)
            player.replaceCurrentItem(with: item)
            hasItem = true
            if startAt > 0 {
                player.seek(
                    to: CMTime(seconds: startAt, preferredTimescale: 600),
                    toleranceBefore: .zero,
                    toleranceAfter: .zero
                )
            }
            if paused {
                player.pause()
                isPlaying = false
            } else {
                playNative()
            }
            if let title = incoming.title {
                setNowPlaying(title: title)
            }
        } else {
            engine = .web
            player.pause()
            player.replaceCurrentItem(with: nil)
            hasItem = false
            webPaused = paused
            webPosition = startAt
            // The other side may hand us a framed player plus the site that
            // framed it, so we end up on the very same player.
            if let site = incoming.pageUrl, site != incoming.url {
                webEmbedder = site
            }
            webURL = EmbedShim.wrap(incoming.browserURL, relay: Defaults.server)
            isPlaying = !paused
            if !paused {
                webCommand = WebCommand(action: "play", position: startAt, tolerance: 1.2)
            }
        }

        if broadcast {
            client?.load(incoming, position: startAt, paused: paused)
        }
    }

    private func playNative() {
        player.play()
        isPlaying = true
    }

    // MARK: - local controls

    var currentPosition: Double {
        if engine == .web { return webPosition }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? seconds : position
    }

    func toggle() {
        guard source != nil else {
            flash("Load a link first")
            return
        }
        if engine == .native {
            if player.rate > 0 {
                player.pause()
                isPlaying = false
                client?.pause(currentPosition)
            } else {
                playNative()
                client?.play(currentPosition)
            }
        } else {
            if isPlaying {
                isPlaying = false
                webPaused = true
                webCommand = WebCommand(action: "pause", position: webPosition, tolerance: 0.35)
                client?.pause(webPosition)
            } else {
                isPlaying = true
                webPaused = false
                webCommand = WebCommand(action: "play", position: webPosition, tolerance: 1.2)
                client?.play(webPosition)
            }
        }
    }

    func seek(to seconds: Double) {
        let limit = duration > 0 ? max(0, duration - 0.15) : seconds
        let target = min(max(0, seconds), limit)
        position = target

        if engine == .native {
            ignoreUntil = Date().addingTimeInterval(0.5)
            player.seek(
                to: CMTime(seconds: target, preferredTimescale: 600),
                toleranceBefore: .zero,
                toleranceAfter: .zero
            )
        } else {
            webPosition = target
            webCommand = WebCommand(action: webPaused ? "pause" : "play", position: target, tolerance: 0.2)
        }
        client?.seek(target, paused: !isPlaying)
    }

    func nudge(by delta: Double) {
        seek(to: currentPosition + delta)
    }

    func resync() {
        guard let client else { return }
        client.seek(currentPosition, paused: !isPlaying)
        if isPlaying { client.play(currentPosition) } else { client.pause(currentPosition) }
        flash("Sent your exact position")
    }

    func setRate(_ value: Double) {
        let clamped = min(2, max(0.25, value))
        if engine == .native, player.rate > 0 {
            ignoreUntil = Date().addingTimeInterval(0.4)
            player.rate = Float(clamped)
        }
        client?.rate(clamped, position: currentPosition)
    }

    // MARK: - inbound

    private func handle(_ message: WireMessage) {
        switch message.t {
        case "chat":
            let chat = ChatMessage(name: message.name ?? "Them", text: message.text ?? "", mine: false)
            messages.append(chat)
            if !showChat { unread += 1 }

        case "buffer":
            let isBuffering = message.buffering ?? false
            partnerBuffering = isBuffering
            guard waitForPartner else { return }
            if isBuffering, isPlaying, engine == .native {
                waitingForPartner = true
                player.pause()
                flash("Waiting for \(message.name ?? "them")…", seconds: 1.2)
            } else if !isBuffering, waitingForPartner {
                waitingForPartner = false
                if let remote = lastRemote, remote.paused == false { playNative() }
            }

        case "media":
            guard let incoming = message.source else { return }
            lastRemote = message
            waitingForPartner = false
            if let current = source, current.key == incoming.key {
                apply(message)
                return
            }
            if let title = incoming.title, !title.isEmpty {
                flash("\(message.name ?? "They") started “\(title)”")
            }
            load(
                incoming,
                position: message.expectedPosition(serverNow: client?.serverNow() ?? 0),
                paused: message.paused ?? true,
                broadcast: false
            )

        case "play", "pause", "seek", "rate":
            lastRemote = message
            waitingForPartner = false
            apply(message)

        default:
            break
        }
    }

    private func apply(_ message: WireMessage) {
        let now = client?.serverNow() ?? Date().timeIntervalSince1970 * 1000
        if message.isStale(serverNow: now) { return }

        let target = message.expectedPosition(serverNow: now)
        let wantsPause: Bool
        switch message.t {
        case "pause": wantsPause = true
        case "play": wantsPause = false
        default: wantsPause = message.paused ?? true
        }

        if engine == .native {
            let drift = abs(currentPosition - target)
            ignoreUntil = Date().addingTimeInterval(0.7)
            if drift > (wantsPause ? 0.3 : 1.1) {
                player.seek(
                    to: CMTime(seconds: max(0, target), preferredTimescale: 600),
                    toleranceBefore: .zero,
                    toleranceAfter: .zero
                )
            }
            if let rate = message.rate, rate > 0, message.t == "rate", !wantsPause {
                player.rate = Float(min(2, max(0.25, rate)))
            } else if wantsPause {
                player.pause()
            } else if player.rate == 0 {
                player.play()
            }
            position = target
        } else {
            ignoreUntil = Date().addingTimeInterval(2.5)
            webPaused = wantsPause
            webPosition = target
            webCommand = WebCommand(
                action: wantsPause ? "pause" : "play",
                position: target,
                tolerance: wantsPause ? 0.3 : 1.1
            )
        }
        isPlaying = !wantsPause
    }

    // MARK: - web engine events

    func ingestWebEvent(_ payload: [String: Any]) {
        let type = payload["type"] as? String ?? ""

        // A page that frames its player has no <video> of its own to report —
        // step into the frame without disturbing the current drift state.
        if type == "frames" {
            followEmbeddedPlayer(payload)
            return
        }
        if type == "probe" {
            handleProbe(payload)
            return
        }
        let pos = payload["position"] as? Double ?? 0
        let paused = payload["paused"] as? Bool ?? true
        let seconds = payload["duration"] as? Double ?? 0

        webPosition = pos
        webPaused = paused
        position = pos
        if seconds > 0 { duration = seconds }
        if type == "play" || type == "pause" || type == "time" { isPlaying = !paused }

        let now = client?.serverNow() ?? 0

        switch type {
        case "detected", "ready":
            shareFromWeb(payload)
        case "play", "pause", "seeked":
            guard Date() > ignoreUntil else { return }
            switch type {
            case "play": client?.play(pos)
            case "pause": client?.pause(pos)
            default: client?.seek(pos, paused: paused)
            }
            shareFromWeb(payload)
        case "time":
            if !paused, now - lastHeartbeat > 4000, Date() > ignoreUntil {
                lastHeartbeat = now
                client?.play(pos)
            }
        case "blocked":
            needsUnmute = true
        default:
            break
        }
    }

    /// Streaming sites almost never hold the <video> in the page you open: the
    /// watch page frames a player on another host, and page script can never
    /// reach into a cross-origin frame. Navigate the web view *into* the frame
    /// so the player becomes the top document, where the bridge can drive it.
    private func followEmbeddedPlayer(_ payload: [String: Any]) {
        guard webHops < 3 else {
            flash("No video found here — try another player on the page")
            return
        }
        guard let frames = payload["frames"] as? [[String: Any]],
              let current = webURL?.absoluteString else { return }

        for frame in frames {
            guard let raw = frame["url"] as? String, !raw.isEmpty,
                  let next = URL(string: raw),
                  webSeen.insert(raw).inserted else { continue }
            // Only ever step into a frame that fills the window: hopping into a
            // 300×250 ad slot hijacks the page.
            guard isDominantFramePrinciple(frame, total: frames.count) else { continue }
            webHops += 1
            webEmbedder = current
            flash("Following the embedded player…")
            webURL = next
            return
        }
    }

    /// Say once per page what we can see, so an empty screen is never silent.
    private func handleProbe(_ payload: [String: Any]) {
        let videos = payload["videos"] as? Int ?? 0
        guard videos == 0 else { return }
        let frames = payload["frames"] as? Int ?? 0
        let url = webURL?.absoluteString ?? ""
        guard probedURL != url else { return }
        probedURL = url
        if frames > 0 {
            flash(frames == 1 ? "No video in the page — 1 embedded player"
                              : "No video in the page — \(frames) embedded players")
        } else {
            flash("No video yet — press play in the page")
        }
    }


    /// size is unknown but it is the only frame on the page.
    private func isDominantFramePrinciple(_ frame: [String: Any], total: Int) -> Bool {
        let ratio = frame["ratio"] as? Double ?? 0
        let w = frame["w"] as? Int ?? 0
        let h = frame["h"] as? Int ?? 0
        if w <= 0 || h <= 0 { return total == 1 }
        return ratio >= 0.30
    }

    /// Announce the page/video currently playing in the built-in browser.
    private func shareFromWeb(_ payload: [String: Any]) {
        guard client != nil else { return }
        guard Date() > ignoreUntil else { return }

        let pageURL = payload["url"] as? String
        let rawSrc = payload["src"] as? String ?? ""
        let title = payload["title"] as? String
        let usable = !rawSrc.isEmpty
            && !rawSrc.hasPrefix("blob:")
            && !rawSrc.hasPrefix("mediasource:")
            && !rawSrc.hasPrefix("data:")

        let candidate: Source
        if usable {
            candidate = Source(
                kind: rawSrc.lowercased().contains(".m3u8") ? "hls" : "file",
                url: rawSrc,
                pageUrl: pageURL,
                title: title,
                duration: nil
            )
        } else if let embedder = webEmbedder, embedder != pageURL {
            // We stepped into a framed player: send the player *and* the site
            // that framed it, so the other side opens the very same player.
            candidate = Source(kind: "page", url: pageURL, pageUrl: embedder, title: title)
        } else {
            candidate = Source(kind: "page", pageUrl: pageURL, title: title)
        }

        guard candidate.key != loadedKey else { return }
        loadedKey = candidate.key
        source = candidate
        rememberRecent(candidate)

        let pos = payload["position"] as? Double ?? 0
        let paused = payload["paused"] as? Bool ?? true
        client?.load(candidate, position: pos, paused: paused)
        flash("Sharing “\(candidate.displayTitle)”")
    }

    // MARK: - drift

    private func tickUI(time: CMTime) {
        guard engine == .native, player.currentItem != nil else { return }
        let seconds = time.seconds
        if seconds.isFinite { position = seconds }
        let itemDuration = player.currentItem?.duration.seconds ?? 0
        if itemDuration.isFinite, itemDuration > 0 { duration = itemDuration }
        isPlaying = player.rate > 0
    }

    private func correctDrift() {
        guard engine == .native else { return }
        guard let client, let remote = lastRemote else { return }
        guard !waitingForPartner, autoCorrect else { return }
        let now = client.serverNow()
        if remote.isStale(serverNow: now) { return }
        guard remote.paused == false, player.rate > 0 else { return }

        let target = remote.expectedPosition(serverNow: now)
        if abs(currentPosition - target) > 0.9 {
            ignoreUntil = Date().addingTimeInterval(0.5)
            player.seek(
                to: CMTime(seconds: max(0, target), preferredTimescale: 600),
                toleranceBefore: .zero,
                toleranceAfter: .zero
            )
        }

        if now - lastHeartbeat > 4000 {
            lastHeartbeat = now
            client.play(currentPosition)
        }
    }

    // MARK: - resolving links

    func loadFromURL(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        busy = true

        if Defaults.server.isEmpty && serverURL.isEmpty {
            busy = false
            load(Source.guess(trimmed), paused: false, broadcast: true)
            return
        }

        Task {
            let resolved = await Extractor.resolve(trimmed, server: effectiveServer)
            busy = false
            let source = resolved ?? Source.guess(trimmed)
            load(source, paused: false, broadcast: true)
        }
    }

    var effectiveServer: String {
        serverURL.isEmpty ? Defaults.server : serverURL
    }

    // MARK: - chat

    func sendChat(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        client?.chat(trimmed)
        messages.append(ChatMessage(name: name, text: trimmed, mine: true))
    }

    // MARK: - storage & chrome

    func rememberRecent(_ source: Source) {
        var list = recent.filter { $0.key != source.key }
        list.insert(source, at: 0)
        recent = Array(list.prefix(6))
        Defaults.recent = recent
    }

    func flash(_ text: String, seconds: Double = 2.2) {
        toastWork?.cancel()
        toast = text
        let work = DispatchWorkItem { [weak self] in
            self?.toast = nil
        }
        toastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func setNowPlaying(title: String) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
        ]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentPosition
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

// MARK: - Extractor

/// Talks to the relay's /api/extract so both apps agree on what to load.
enum Extractor {
    static func resolve(_ raw: String, server: String) async -> Source? {
        var text = raw
        if !text.lowercased().hasPrefix("http") {
            text = text.contains(" ")
                ? "https://duckduckgo.com/?q=" + (text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")
                : "https://" + text
        }
        guard !server.isEmpty,
              var components = URLComponents(string: server.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }
        components.path = "/api/extract"
        components.queryItems = [URLQueryItem(name: "url", value: text)]
        guard let url = components.url else { return nil }

        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 20
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["ok"] as? Bool == true,
                  let payload = object["source"] else { return nil }
            let sourceData = try JSONSerialization.data(withJSONObject: payload)
            return try JSONDecoder().decode(Source.self, from: sourceData)
        } catch {
            return nil
        }
    }
}
