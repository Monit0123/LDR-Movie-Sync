import SwiftUI

struct LobbyView: View {
    @EnvironmentObject private var store: SyncStore

    @State private var name = ""
    @State private var code = ""
    @State private var server = ""
    @State private var hint: String?
    @State private var showServer = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Theme.accent.opacity(0.10), Color.clear, Color(red: 0.36, green: 0.24, blue: 0.9).opacity(0.10)],
                startPoint: .topTrailing,
                endPoint: .bottomLeading
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                card
            }
            .frame(maxWidth: 430)
            .padding(24)
        }
        .onAppear {
            name = store.name
            server = store.serverURL.isEmpty ? Defaults.server : store.serverURL
            code = Defaults.room
            showServer = server.isEmpty || !server.contains("example.com")
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                BrandMark()
                Text("Flick").foregroundColor(Theme.text) + Text("Sync").foregroundColor(Theme.accent)
            }
            .font(.system(size: 15, weight: .medium))
            .frame(maxWidth: .infinity, alignment: .center)

            VStack(spacing: 2) {
                Text("Two screens.")
                    .foregroundColor(Theme.text)
                Text("One movie.")
                    .foregroundColor(Theme.accent)
            }
            .font(.system(size: 30, weight: .semibold))
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 22)

            Text("No screen sharing. Each side buffers the same video at full quality — only the timing is shared.")
                .font(.system(size: 12.5))
                .foregroundColor(Theme.faint)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 12)
                .padding(.bottom, 22)

            field("Your name", text: $name, placeholder: "Ana")
            field("Room code", text: $code, placeholder: "AB12CD", mono: true)
                .padding(.top, 12)

            Button("Join room") { join() }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.top, 16)

            Button {
                let generated = Self.randomCode()
                code = generated
                join(forceCode: generated)
            } label: {
                Text("Start a new room")
            }
            .buttonStyle(QuietButtonStyle())
            .padding(.top, 9)

            if let hint {
                Text(hint)
                    .font(.system(size: 11))
                    .foregroundColor(Theme.warn)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 12)
            }

            Divider().overlay(Theme.line).padding(.vertical, 18)

            Button {
                withAnimation(.easeInOut(duration: 0.15)) { showServer.toggle() }
            } label: {
                HStack(spacing: 6) {
                    SectionLabel(text: "Server")
                    Image(systemName: showServer ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(Theme.faint)
                }
            }
            .buttonStyle(.plain)

            if showServer {
                TextField("https://your-flicksync-server.example.com", text: $server)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(Theme.text)
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(Color.white.opacity(0.04))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Theme.line, lineWidth: 1))
                    )
                    .padding(.top, 8)
                Text("The tiny relay you deploy once (see README). Both devices must use the same one.")
                    .font(.system(size: 10.5))
                    .foregroundColor(Theme.faint)
                    .padding(.top, 6)
            }
        }
        .padding(28)
        .card(radius: 22)
        .shadow(color: Color.black.opacity(0.55), radius: 40, y: 20)
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: label)
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(.system(size: mono ? 13 : 13.5, weight: .regular, design: mono ? .monospaced : .default))
                .foregroundColor(Theme.text)
                .tracking(mono ? 1.6 : 0)
                .padding(.horizontal, 12)
                .frame(height: 40)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.white.opacity(0.04))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, lineWidth: 1))
                )
                .onChange(of: text.wrappedValue) { value in
                    if mono {
                        text.wrappedValue = value.uppercased().filter { $0.isLetter || $0.isNumber || $0 == " " }.trimmingCharacters(in: .whitespaces)
                    }
                }
        }
    }

    private func join(forceCode: String? = nil) {
        let room = forceCode ?? code.uppercased().filter { $0.isLetter || $0.isNumber }
        guard room.count >= 4 else {
            hint = "Room codes are at least 4 characters — or start a new room."
            return
        }
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            hint = "Add your name first."
            return
        }
        guard !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !server.contains("example.com") else {
            hint = "Add your relay URL under Server (any small free host works)."
            showServer = true
            return
        }
        hint = nil
        store.join(code: room, name: name, server: server)
    }

    static func randomCode() -> String {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        return String((0..<6).map { _ in alphabet.randomElement()! })
    }
}
