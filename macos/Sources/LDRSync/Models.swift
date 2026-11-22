import Foundation

// MARK: - Peers

struct Peer: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let device: String

    var deviceLabel: String {
        switch device {
        case "android": return "Android"
        case "mac": return "MacBook"
        default: return "Browser"
        }
    }

    var initials: String {
        let parts = name.split(separator: " ").compactMap { $0.first }
        let text = String(parts.prefix(2)).uppercased()
        return text.isEmpty ? "?" : text
    }
}

// MARK: - Sources

struct Source: Codable, Equatable {
    var kind: String
    var url: String?
    var pageUrl: String?
    var id: String?
    var title: String?
    var duration: Double?

    var isEmbed: Bool { ["youtube", "dailymotion", "vimeo", "twitch"].contains(kind) }
    var isBrowserOnly: Bool { kind == "page" }
    var isDirect: Bool { !isEmbed && !isBrowserOnly }

    var playableURL: URL? {
        guard let raw = url ?? pageUrl else { return nil }
        return URL(string: raw)
    }

    /// The URL to open inside the built-in browser so that a platform player
    /// runs as the *top* document (an injected script can never reach a
    /// cross-origin iframe).
    var browserURL: URL? {
        switch kind {
        case "youtube":
            guard let id else { return nil }
            return URL(string: "https://www.youtube.com/embed/\(id)?playsinline=1&rel=0")
        case "dailymotion":
            guard let id else { return nil }
            return URL(string: "https://www.dailymotion.com/embed/video/\(id)")
        case "vimeo":
            guard let id else { return nil }
            return URL(string: "https://player.vimeo.com/video/\(id)")
        default:
            guard let raw = pageUrl ?? url else { return nil }
            return URL(string: raw)
        }
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let pageUrl { return Source.pretty(pageUrl) }
        return "Video"
    }

    var key: String { "\(kind)|\(id ?? url ?? pageUrl ?? "")" }

    static func pretty(_ raw: String) -> String {
        guard let url = URL(string: raw) else { return raw }
        var host = url.host ?? raw
        if host.hasPrefix("www.") { host.removeFirst(4) }
        return host + (url.path.count > 1 ? url.path : "")
    }

    /// Best-effort local guess, used when the relay's extractor is unreachable.
    static func guess(_ raw: String) -> Source {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.lowercased().hasPrefix("http") { text = "https://" + text }
        let lower = text.lowercased()

        func match(_ pattern: String) -> String? {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
            let range = NSRange(text.startIndex..., in: text)
            guard let found = regex.firstMatch(in: text, range: range),
                  found.numberOfRanges > 1,
                  let r = Range(found.range(at: 1), in: text) else { return nil }
            return String(text[r])
        }

        if let id = match("youtu\\.be/([\\w-]+)") ?? match("[?&]v=([\\w-]+)") ?? match("youtube\\.com/embed/([\\w-]+)") {
            return Source(kind: "youtube", pageUrl: text, id: id, title: nil)
        }
        if let id = match("dailymotion\\.com/(?:embed/)?video/([a-zA-Z0-9]+)") ?? match("dai\\.ly/([a-zA-Z0-9]+)") {
            return Source(kind: "dailymotion", pageUrl: text, id: id, title: nil)
        }
        if let id = match("vimeo\\.com/(\\d+)") {
            return Source(kind: "vimeo", pageUrl: text, id: id, title: nil)
        }
        if text.range(of: "\\.(mp4|m4v|webm|mkv|mov|m3u8|mpd)(\\?|#|$)", options: [.regularExpression, .caseInsensitive]) != nil {
            let name = text.split(separator: "/").last.map(String.init) ?? text
            return Source(
                kind: lower.contains(".m3u8") ? "hls" : "file",
                url: text,
                pageUrl: text,
                title: name.split(separator: "?").first.map(String.init)
            )
        }
        return Source(kind: "page", pageUrl: text)
    }
}

// MARK: - Wire

struct WireMessage: Decodable {
    var t: String
    var position: Double?
    var paused: Bool?
    var issuedAt: Double?
    var rate: Double?
    var buffering: Bool?
    var source: Source?
    var text: String?
    var name: String?
    var from: String?
    var id: String?
    var peers: [Peer]?
    var c: Double?
    var s: Double?

    /// Where the playhead should be right now, given the shared clock.
    func expectedPosition(serverNow: Double) -> Double {
        let base = position ?? 0
        guard let issued = issuedAt, issued > 0 else { return base }
        let elapsed = (serverNow - issued) / 1000
        if elapsed < 0 || elapsed > 3600 { return base }
        return (paused ?? true) ? base : base + elapsed
    }

    func isStale(serverNow: Double, tolerance: Double = 15_000) -> Bool {
        guard let issued = issuedAt, issued > 0 else { return false }
        return serverNow - issued > tolerance
    }
}

// MARK: - UI bits

struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let text: String
    let mine: Bool
    let at = Date()
}

enum ConnectionState: Equatable {
    case offline, connecting, online
}

enum EngineKind: Equatable {
    case native, web
}

struct WebCommand: Equatable {
    let id = UUID()
    let action: String      // "play" | "pause"
    let position: Double
    let tolerance: Double
}

func clock(_ seconds: Double) -> String {
    let total = max(0, Int(seconds.rounded(.down)))
    let h = total / 3600
    let m = (total % 3600) / 60
    let s = total % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

enum Defaults {
    private static let store = UserDefaults.standard

    static var name: String {
        get { store.string(forKey: "flicksync.name") ?? "" }
        set { store.set(newValue, forKey: "flicksync.name") }
    }

    static var server: String {
        get { store.string(forKey: "flicksync.server") ?? "" }
        set { store.set(newValue, forKey: "flicksync.server") }
    }

    static var room: String {
        get { store.string(forKey: "flicksync.room") ?? "" }
        set { store.set(newValue, forKey: "flicksync.room") }
    }

    static var recent: [Source] {
        get {
            guard let data = store.data(forKey: "flicksync.recent"),
                  let list = try? JSONDecoder().decode([Source].self, from: data) else { return [] }
            return list
        }
        set {
            if let data = try? JSONEncoder().encode(Array(newValue.prefix(6))) {
                store.set(data, forKey: "flicksync.recent")
            }
        }
    }
}
