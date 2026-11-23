import SwiftUI

struct SidebarView: View {
    @EnvironmentObject private var store: SyncStore
    @State private var tab = 0
    @State private var draft = ""
    @FocusState private var chatFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            picker
            Divider().overlay(Theme.line)
            if tab == 0 {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        quickLoad
                        peersSection
                        playbackSection
                        recentSection
                        fineprint
                    }
                    .padding(16)
                }
            } else {
                chat
            }
        }
        .background(Theme.bgSoft)
        .overlay(Rectangle().fill(Theme.line).frame(width: 1), alignment: .leading)
    }

    private var picker: some View {
        HStack(spacing: 4) {
            tabButton("Watch", index: 0)
            tabButton("Chat", index: 1)
            Spacer()
        }
        .padding(8)
        .background(Theme.bgSoft)
    }

    private func tabButton(_ title: String, index: Int) -> some View {
        Button {
            tab = index
            if index == 1 { store.unread = 0; chatFocused = true }
        } label: {
            HStack(spacing: 5) {
                Text(title)
                if index == 1, store.unread > 0 {
                    Circle().fill(Theme.accent).frame(width: 5, height: 5)
                }
            }
            .font(.system(size: 12.5, weight: tab == index ? .semibold : .regular))
            .foregroundColor(tab == index ? Theme.text : Theme.faint)
            .padding(.horizontal, 14)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(tab == index ? Color.white.opacity(0.07) : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - watch tab

    private var quickLoad: some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "Add something")
            HStack(spacing: 7) {
                ForEach(["YouTube", "Dailymotion", "Vimeo"], id: \.self) { site in
                    Button(site) {
                        store.flash("Paste the \(site) link in the bar below")
                    }
                    .buttonStyle(PillButtonStyle())
                }
            }
            Text("Paste any link in the bar under the video — the other screen loads the same stream.")
                .font(.system(size: 11))
                .foregroundColor(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var peersSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                SectionLabel(text: "Who's here")
                Spacer()
                Text("\(store.peers.count + (store.myID.isEmpty ? 0 : 1))")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Theme.faint)
            }

            peerRow(name: store.name + " (you)", subtitle: "MacBook", initials: initials(store.name), mine: true)

            if let partner = store.partner {
                peerRow(name: partner.name, subtitle: partner.deviceLabel, initials: partner.initials, mine: false, live: true)
            } else {
                HStack(spacing: 10) {
                    ZStack {
                        Circle().strokeBorder(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .frame(width: 28, height: 28)
                        Image(systemName: "person")
                            .font(.system(size: 11))
                            .foregroundColor(Theme.faint)
                    }
                    Text("Waiting for them to join")
                        .font(.system(size: 12.5))
                        .foregroundColor(Theme.faint)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.white.opacity(0.02))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [4, 4])))
                )
            }
        }
    }

    private func peerRow(name: String, subtitle: String, initials: String, mine: Bool, live: Bool = false) -> some View {
        HStack(spacing: 10) {
            Avatar(text: initials, mine: mine)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(Theme.text)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 10.5))
                    .foregroundColor(Theme.faint)
            }
            Spacer()
            if live {
                Text("IN SYNC")
                    .font(.system(size: 8.5, weight: .bold))
                    .kerning(0.8)
                    .foregroundColor(Theme.ok)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Theme.ok.opacity(0.12)))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.white.opacity(0.03))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, lineWidth: 1))
        )
    }

    private var playbackSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Playback")
            ToggleRow(title: "Wait for each other",
                      subtitle: "Pause while their side buffers",
                      isOn: $store.waitForPartner)
            Divider().overlay(Theme.line)
            ToggleRow(title: "Auto-correct drift",
                      subtitle: "Catch up if a stream falls behind",
                      isOn: $store.autoCorrect)
        }
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !store.recent.isEmpty {
                SectionLabel(text: "Recently watched")
                ForEach(Array(store.recent.prefix(5)), id: \.key) { item in
                    Button {
                        store.load(item, paused: false, broadcast: true)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "play.circle")
                                .foregroundColor(Theme.faint)
                            Text(item.displayTitle)
                                .font(.system(size: 12))
                                .foregroundColor(Theme.dim)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .fill(Color.white.opacity(0.02))
                                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Theme.line, lineWidth: 1))
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var fineprint: some View {
        Text("Playback stays native on each device. The server only ever sees a timestamp and a link.")
            .font(.system(size: 10.5))
            .foregroundColor(Theme.faint)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - chat tab

    private var chat: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if store.messages.isEmpty {
                            Text("Nothing said yet. Send her a 🍿")
                                .font(.system(size: 12))
                                .foregroundColor(Theme.faint)
                                .padding(.top, 20)
                        }
                        ForEach(store.messages) { message in
                            chatBubble(message)
                                .id(message.id)
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: store.messages.count) { _ in
                    if let last = store.messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            HStack(spacing: 6) {
                ForEach(["❤️", "😂", "😱", "🍿"], id: \.self) { emoji in
                    Button(emoji) { store.sendChat(emoji) }
                        .buttonStyle(.plain)
                        .font(.system(size: 15))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.white.opacity(0.04)))
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 8)

            HStack(spacing: 8) {
                TextField("Say something…", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundColor(Theme.text)
                    .focused($chatFocused)
                    .onSubmit(send)
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.white.opacity(0.04))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, lineWidth: 1))
                    )

                Button(action: send) {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 13))
                        .foregroundColor(.white)
                        .frame(width: 36, height: 36)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.accent))
                }
                .buttonStyle(.plain)
            }
            .padding(12)
            .background(Theme.bgSoft)
        }
    }

    private func chatBubble(_ message: ChatMessage) -> some View {
        VStack(alignment: message.mine ? .trailing : .leading, spacing: 2) {
            if !message.mine {
                Text(message.name)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundColor(Theme.faint)
            }
            Text(message.text)
                .font(.system(size: 12.5))
                .foregroundColor(message.mine ? .white : Theme.text)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(message.mine
                              ? AnyShapeStyle(LinearGradient(colors: [Theme.accent, Theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
                              : AnyShapeStyle(Color.white.opacity(0.05)))
                )
        }
        .frame(maxWidth: .infinity, alignment: message.mine ? .trailing : .leading)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.sendChat(text)
        draft = ""
    }

    private func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").compactMap { $0.first }
        let value = String(letters.prefix(2)).uppercased()
        return value.isEmpty ? "?" : value
    }
}
