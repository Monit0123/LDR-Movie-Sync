import SwiftUI

@main
struct FlickSyncApp: App {
    @StateObject private var store = SyncStore()

    var body: some Scene {
        WindowGroup("FlickSync") {
            RootView()
                .environmentObject(store)
                .frame(minWidth: 940, minHeight: 620)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Playback") {
                Button("Play / Pause") { store.toggle() }
                    .keyboardShortcut(.space, modifiers: [])
                Button("Back 10s") { store.nudge(by: -10) }
                    .keyboardShortcut(.leftArrow, modifiers: [])
                Button("Forward 10s") { store.nudge(by: 10) }
                    .keyboardShortcut(.rightArrow, modifiers: [])
                Divider()
                Button("Resync with them") { store.resync() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                Button("Theater mode") { store.theater.toggle() }
                    .keyboardShortcut("t", modifiers: [.command, .shift])
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: SyncStore

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if store.room.isEmpty {
                LobbyView()
            } else {
                RoomView()
            }
            if let toast = store.toast {
                VStack {
                    Spacer()
                    Text(toast)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(Theme.text)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .background(
                            Capsule().fill(Theme.panel)
                                .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                        )
                        .padding(.bottom, 26)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                .animation(.easeOut(duration: 0.2), value: store.toast)
                .allowsHitTesting(false)
            }
        }
        .preferredColorScheme(.dark)
    }
}
