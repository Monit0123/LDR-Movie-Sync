import SwiftUI

enum Theme {
    static let bg = Color(red: 0.031, green: 0.031, blue: 0.047)
    static let bgSoft = Color(red: 0.055, green: 0.055, blue: 0.082)
    static let panel = Color(red: 0.078, green: 0.078, blue: 0.114)
    static let panelSoft = Color(red: 0.11, green: 0.11, blue: 0.16)
    static let line = Color.white.opacity(0.09)
    static let lineStrong = Color.white.opacity(0.16)
    static let text = Color(red: 0.95, green: 0.945, blue: 0.968)
    static let dim = Color(red: 0.635, green: 0.63, blue: 0.71)
    static let faint = Color(red: 0.43, green: 0.42, blue: 0.51)
    static let accent = Color(red: 1.0, green: 0.36, blue: 0.48)
    static let accentDeep = Color(red: 0.79, green: 0.19, blue: 0.36)
    static let ok = Color(red: 0.31, green: 0.88, blue: 0.63)
    static let warn = Color(red: 1.0, green: 0.80, blue: 0.36)
}

struct CardBackground: ViewModifier {
    var radius: CGFloat = 16
    var stroke: Color = Theme.line
    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(Theme.panel)
                    .overlay(
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .stroke(stroke, lineWidth: 1)
                    )
            )
    }
}

extension View {
    func card(radius: CGFloat = 16, stroke: Color = Theme.line) -> some View {
        modifier(CardBackground(radius: radius, stroke: stroke))
    }

    func fieldStyle() -> some View {
        self
            .textFieldStyle(.plain)
            .font(.system(size: 13))
            .foregroundColor(Theme.text)
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(0.04))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Theme.line, lineWidth: 1)
                    )
            )
    }
}

struct PillButtonStyle: ButtonStyle {
    var filled = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .foregroundColor(filled ? .white : Theme.dim)
            .padding(.horizontal, 13)
            .frame(height: 34)
            .background(
                Capsule()
                    .fill(filled
                          ? AnyShapeStyle(LinearGradient(colors: [Theme.accent, Theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
                          : AnyShapeStyle(Color.white.opacity(configuration.isPressed ? 0.09 : 0.03)))
                    .overlay(Capsule().stroke(filled ? Color.clear : Theme.line, lineWidth: 1))
            )
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 42)
            .background(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(LinearGradient(colors: [Theme.accent, Theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
            )
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(Theme.text)
            .frame(maxWidth: .infinity)
            .frame(height: 42)
            .background(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.08 : 0.04))
                    .overlay(
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .stroke(Theme.lineStrong, lineWidth: 1)
                    )
            )
    }
}

struct BrandMark: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(Theme.faint, lineWidth: 1.6)
                .frame(width: 21, height: 17)
                .offset(x: -4, y: 3)
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Theme.accent)
                .frame(width: 20, height: 16)
                .offset(x: 5, y: -4)
            Image(systemName: "play.fill")
                .font(.system(size: 7, weight: .black))
                .foregroundColor(Theme.bg)
                .offset(x: 5, y: -4)
        }
        .frame(width: 30, height: 26)
    }
}

struct Avatar: View {
    let text: String
    var mine = false
    var size: CGFloat = 28

    var body: some View {
        ZStack {
            Circle()
                .fill(mine
                      ? AnyShapeStyle(LinearGradient(colors: [Theme.accent, Theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
                      : AnyShapeStyle(LinearGradient(colors: [Theme.panelSoft, Theme.panel], startPoint: .topLeading, endPoint: .bottomTrailing)))
            Text(text)
                .font(.system(size: size * 0.38, weight: .semibold))
                .foregroundColor(mine ? .white : Theme.dim)
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(Theme.bg, lineWidth: 2))
    }
}

struct StatusDot: View {
    enum Level { case live, idle, waiting }
    let level: Level

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .shadow(color: color.opacity(0.6), radius: 4)
    }

    private var color: Color {
        switch level {
        case .live: return Theme.ok
        case .idle: return Theme.faint
        case .waiting: return Theme.warn
        }
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(1.4)
            .foregroundColor(Theme.faint)
    }
}

struct ToggleRow: View {
    let title: String
    let subtitle: String
    @Binding var isOn: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 12.5))
                    .foregroundColor(Theme.text)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundColor(Theme.faint)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: $isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(Theme.accent)
                .scaleEffect(0.8)
        }
        .padding(.vertical, 5)
    }
}
