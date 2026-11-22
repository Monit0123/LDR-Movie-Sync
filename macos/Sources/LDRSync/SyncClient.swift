import Foundation

/// WebSocket transport for the FlickSync relay.
///
/// Owns the clock estimate that makes `issuedAt` comparable between a Mac and a
/// phone, keeps the socket warm with pings, and reconnects with backoff.
/// All callbacks are delivered on the main queue.
final class SyncClient {

    var onStatus: ((Bool) -> Void)?
    var onEvent: ((WireMessage) -> Void)?
    var onPeers: (([Peer]) -> Void)?
    var onWelcome: ((String, [Peer]) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var pingTimer: Timer?
    private var reconnectTimer: Timer?
    private var attempt = 0
    private var samples: [(offset: Double, rtt: Double)] = []

    private var base = ""
    private var room = ""
    private var name = ""
    private var userClosed = false

    private(set) var connected = false
    private(set) var offset: Double = 0
    private(set) var peerID = ""

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    // MARK: - lifecycle

    func connect(base: String, room: String, name: String) {
        self.base = base.trimmingCharacters(in: .whitespacesAndNewlines)
        self.room = room.uppercased().filter { $0.isLetter || $0.isNumber }
        self.name = name
        userClosed = false
        attempt = 0
        open()
    }

    private func open() {
        guard var components = URLComponents(string: socketBase) else { return }
        components.path = "/ws"
        components.queryItems = [
            URLQueryItem(name: "room", value: room),
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "device", value: "mac"),
        ]
        guard let url = components.url else { return }

        let request = URLRequest(url: url)
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        connected = true
        attempt = 0
        DispatchQueue.main.async { [weak self] in
            self?.onStatus?(true)
            self?.startPing()
        }
        receive()
    }

    private var socketBase: String {
        var value = base
        if value.isEmpty { return "wss://localhost" }
        if value.hasPrefix("https://") { value = "wss://" + value.dropFirst(8) }
        else if value.hasPrefix("http://") { value = "ws://" + value.dropFirst(7) }
        else if !value.hasPrefix("ws") { value = "wss://" + value }
        return value
    }

    private func startPing() {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.send(["t": "ping", "c": Date().timeIntervalSince1970 * 1000])
        }
        send(["t": "ping", "c": Date().timeIntervalSince1970 * 1000])
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.handleDisconnect(error.localizedDescription)
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handle(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) { self.handle(text) }
                @unknown default:
                    break
                }
                self.receive()
            }
        }
    }

    private func handleDisconnect(_ detail: String?) {
        connected = false
        pingTimer?.invalidate()
        DispatchQueue.main.async { [weak self] in
            self?.onStatus?(false)
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !userClosed else { return }
        reconnectTimer?.invalidate()
        let delay = min(8.0, 0.6 * pow(1.7, Double(attempt)))
        attempt += 1
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self, !self.userClosed else { return }
            self.open()
        }
    }

    // MARK: - inbound

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONDecoder().decode(WireMessage.self, from: data) else { return }

        switch message.t {
        case "hello":
            peerID = message.id ?? ""
            let peers = message.peers ?? []
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.onWelcome?(self.peerID, peers)
                self.onPeers?(peers)
            }
        case "join", "leave":
            let peers = message.peers ?? []
            DispatchQueue.main.async { [weak self] in
                self?.onPeers?(peers)
            }
        case "pong":
            guard let sent = message.c, let server = message.s else { return }
            let now = Date().timeIntervalSince1970 * 1000
            let rtt = now - sent
            if rtt >= 0, rtt < 4000 {
                samples.append((offset: server - (sent + rtt / 2), rtt: rtt))
                if samples.count > 12 { samples.removeFirst() }
                let best = samples.sorted { $0.rtt < $1.rtt }.prefix(5).map { $0.offset }.sorted()
                if !best.isEmpty { offset = best[best.count / 2] }
            }
        default:
            DispatchQueue.main.async { [weak self] in
                self?.onEvent?(message)
            }
        }
    }

    // MARK: - outbound

    func serverNow() -> Double {
        Date().timeIntervalSince1970 * 1000 + offset
    }

    private func send(_ payload: [String: Any]) {
        guard let task, task.state == .running,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func state(_ type: String, _ fields: [String: Any] = [:]) {
        var payload = fields
        payload["t"] = type
        payload["issuedAt"] = serverNow()
        send(payload)
    }

    func load(_ source: Source, position: Double, paused: Bool) {
        guard let encoded = try? JSONEncoder().encode(source),
              let json = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any] else { return }
        state("media", ["source": json, "position": position, "paused": paused])
    }

    func play(_ position: Double) { state("play", ["position": position]) }
    func pause(_ position: Double) { state("pause", ["position": position]) }
    func seek(_ position: Double, paused: Bool) { state("seek", ["position": position, "paused": paused]) }
    func rate(_ value: Double, position: Double) { state("rate", ["rate": value, "position": position]) }
    func buffering(_ value: Bool) { state("buffer", ["buffering": value]) }
    func chat(_ text: String) { state("chat", ["text": text]) }

    func poke() {
        send(["t": "ping", "c": Date().timeIntervalSince1970 * 1000])
    }

    func close() {
        userClosed = true
        pingTimer?.invalidate()
        reconnectTimer?.invalidate()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        connected = false
    }
}
