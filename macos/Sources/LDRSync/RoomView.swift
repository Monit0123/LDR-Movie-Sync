import SwiftUI

struct RoomView: View {
    @EnvironmentObject private var store: SyncStore
    @State private var urlText = ""
    @State private var dragging = false
    @State private var scrub = 0.0

    var body: some View {
        HStack(spacing: 0) {
            playerPane
            if !store.theater {
                SidebarView()
                    .frame(width: 336)
                    .transition(.move(edge: .trailing))
            }
        }
        .background(Theme.bg)
        .animation(.easeInOut(duration: 0.22), value: store.theater)
    }

    // MARK: - left column

    private var playerPane: some View {
        VStack(spacing: 10) {
            header
            screen
            controls
            sourceBar
        }
        .padding(.horizontal, store.theater ? 0 : 16)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var header: some View {
        HStack(spacing: 10) {
            BrandMark()
            Text("Flick").foregroundColor(Theme.text) + Text("Sync").foregroundColor(Theme.accent)
            Spacer()
            peerStrip
            Button {
                if let partner = store.partner {
                    store.flash("Room \(store.room) · \(partner.name) is here")
                } else {
                    store.flash("Room \(store.room) · waiting for them")
                }
            } label: {
                HStack(spacing: 7) {
                    Text("ROOM").font(.system(size: 9, weight: .semibold)).tracking(1.2)
                        .foregroundColor(Theme.faint)
                    Text(store.room).font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundColor(Theme.text).tracking(1.6)
                }
            }
            .buttonStyle(PillButtonStyle())
            Button {
                store.theater.toggle()
            } label: {
                Image(systemName: store.theater ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                    .foregroundColor(Theme.dim)
            }
            .buttonStyle(PillButtonStyle())
            Button {
                store.leave()
            } label: {
                Text("Leave")
            }
            .buttonStyle(PillButtonStyle())
        }
        .font(.system(size: 15, weight: .medium))
    }

    private var peerStrip: some View {
        HStack(spacing: -6) {
            Avatar(text: initials(store.name), mine: true, size: 26)
            if let partner = store.partner {
                Avatar(text: partner.initials, size: 26)
            }
        }
    }

    private func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").compactMap { $0.first }
        let value = String(letters.prefix(2)).uppercased()
        return value.isEmpty ? "?" : value
    }

    private var screen: some View {
        ZStack {
            RoundedRectangle(cornerRadius: store.theater ? 0 : 16, style: .continuous)
                .fill(Color.black)

            if store.engine == .web {
                WebPlayerView(store: store)
                    .clipShape(RoundedRectangle(cornerRadius: store.theater ? 0 : 16, style: .continuous))
            } else {
                NativePlayerView(player: store.player)
                    .clipShape(RoundedRectangle(cornerRadius: store.theater ? 0 : 16, style: .continuous))
            }

            if store.source == nil {
                idle
            }

            if store.engine == .web, store.source != nil, store.needsUnmute {
                VStack {
                    Spacer()
                    HStack(spacing: 8) {
                        Image(systemName: "speaker.wave.2.fill")
                        Text("Click the video once to allow sound")
                    }
                    .font(.system(size: 12))
                    .foregroundColor(Theme.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.black.opacity(0.7)))
                    .padding(.bottom, 18)
                }
            }

            if store.partnerBuffering {
                VStack {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Waiting for \(store.partner?.name ?? "them")…")
                            .font(.system(size: 12))
                            .foregroundColor(Theme.dim)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.black.opacity(0.72)))
                    .padding(14)
                    Spacer()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if store.buffering {
                VStack {
                    Spacer()
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Buffering…").font(.system(size: 12)).foregroundColor(Theme.dim)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.black.opacity(0.72)))
                    .padding(14)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !store.theater {
                VStack {
                    HStack {
                        Spacer()
                        HStack(spacing: 8) {
                            Button {
                                store.resync()
                            } label: {
                                Label("Resync", systemImage: "arrow.triangle.2.circlepath")
                            }
                            .buttonStyle(PillButtonStyle())
                        }
                    }
                    Spacer()
                }
                .padding(12)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: store.theater ? 0 : 16, style: .continuous)
                .stroke(store.theater ? Color.clear : Theme.line, lineWidth: 1)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var idle: some View {
        VStack(spacing: 12) {
            Image(systemName: "play.rectangle.on.rectangle")
                .font(.system(size: 34, weight: .light))
                .foregroundColor(Theme.faint)
            Text("Nothing playing yet")
                .font(.system(size: 17, weight: .medium))
                .foregroundColor(Theme.text)
            Text("Paste a link below, or let her open something.\nWhatever one of you loads shows up on the other screen.")
                .font(.system(size: 12.5))
                .multilineTextAlignment(.center)
                .foregroundColor(Theme.faint)
                .lineSpacing(3)
            HStack(spacing: 8) {
                ForEach(Array(store.recent.prefix(2)), id: \.key) { item in
                    Button(item.displayTitle) {
                        store.load(item, paused: false, broadcast: true)
                    }
                    .buttonStyle(PillButtonStyle())
                }
            }
            .padding(.top, 6)
        }
        .padding(30)
    }

    private var controls: some View {
        HStack(spacing: 14) {
            Button {
                store.toggle()
            } label: {
                ZStack {
                    Circle().fill(Theme.text).frame(width: 42, height: 42)
                    Image(systemName: store.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(Theme.bg)
                        .offset(x: store.isPlaying ? 0 : 1)
                }
            }
            .buttonStyle(.plain)

            Text(clock(store.position))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Theme.faint)
                .frame(width: 46, alignment: .leading)

            Slider(
                value: Binding(
                    get: { dragging ? scrub : min(store.position, max(store.duration, 1)) },
                    set: { scrub = $0 }
                ),
                in: 0...max(store.duration, 1),
                onEditingChanged: { editing in
                    if editing {
                        scrub = store.position
                        dragging = true
                    } else {
                        dragging = false
                        store.seek(to: scrub)
                    }
                }
            )
            .tint(Theme.accent)

            Text(clock(store.duration))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Theme.faint)
                .frame(width: 46, alignment: .trailing)

            HStack(spacing: 6) {
                Button {
                    store.muted.toggle()
                } label: {
                    Image(systemName: store.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                        .foregroundColor(Theme.dim)
                        .frame(width: 22)
                }
                .buttonStyle(.plain)
                Slider(value: $store.volume, in: 0...1)
                    .frame(width: 70)
                    .tint(Theme.dim)
            }

            statusChip
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .card(radius: 13)
    }

    private var statusChip: some View {
        HStack(spacing: 7) {
            StatusDot(level: statusLevel)
            Text(statusText)
                .font(.system(size: 11))
                .foregroundColor(Theme.faint)
                .lineLimit(1)
        }
        .frame(minWidth: 120, alignment: .trailing)
    }

    private var statusLevel: StatusDot.Level {
        guard store.connection == .online else { return .waiting }
        return store.partner == nil ? .idle : .live
    }

    private var statusText: String {
        guard store.connection == .online else { return "Reconnecting…" }
        guard let partner = store.partner else { return "Waiting for them to join" }
        return "In sync with \(partner.name)"
    }

    private var sourceBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "link")
                .foregroundColor(Theme.faint)
                .padding(.leading, 12)
            TextField("Paste a video, a Dailymotion link, or any page…", text: $urlText)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundColor(Theme.text)
                .onSubmit { submit() }
            if store.busy {
                ProgressView().controlSize(.small).padding(.trailing, 6)
            }
            Button("Load") { submit() }
                .buttonStyle(PillButtonStyle(filled: true))
            Button {
                let raw = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
                let source = raw.isEmpty
                    ? Source(kind: "page", pageUrl: "https://www.dailymotion.com")
                    : Source.guess(raw)
                store.load(source, paused: false, broadcast: true)
                urlText = ""
            } label: {
                Label("Browse", systemImage: "globe")
            }
            .buttonStyle(PillButtonStyle())
        }
        .frame(height: 46)
        .card(radius: 12)
    }

    private func submit() {
        let raw = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        store.loadFromURL(raw)
        urlText = ""
    }
}
