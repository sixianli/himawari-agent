import HimawariCore
import HimawariDesign
import SwiftUI

struct ChatTalkBar: View {
    let talk: any ChatTalk
    let end: () -> Void

    private var phase: TalkPhase { talk.phase }
    private var muted: Bool { talk.muted }
    private var levels: [Double] { talk.levels }

    private func toggleMute() {
        talk.setMuted(!muted)
    }

    private static let inset = (DesignTokens.Size.composerHeight - DesignTokens.Size.composerButton) / 2

    var body: some View {
        HStack(spacing: DesignTokens.Size.composerGap) {
            circle(
                muted ? .microphone : .microphoneOff,
                label: L.text(muted ? "chat.talk.unmute" : "chat.talk.mute"),
                fill: Color.hmFill,
                foreground: Color.hmText,
                action: toggleMute
            )
            HStack(spacing: DesignTokens.Chat.talkLabelGap) {
                if !muted {
                    TalkLevels(levels: levels)
                }
                Text(L.text(label))
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            circle(.x, label: L.text("chat.talk.end"), fill: Color.hmSpeak, foreground: Color.hmOnText, action: end)
        }
        .padding(.horizontal, Self.inset)
        .frame(height: DesignTokens.Size.composerHeight)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.composer, style: .continuous))
    }

    private var label: String {
        switch phase {
        case .starting: "chat.talk.starting"
        case .listening: "chat.talk.listening"
        case .herTurn: "chat.talk.herTurn"
        case .muted: "chat.talk.muted"
        }
    }

    private func circle(_ icon: IconName, label: String, fill: Color, foreground: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(icon, size: DesignTokens.IconSize.glassButton)
                .foregroundStyle(foreground)
                .frame(width: DesignTokens.Size.composerButton, height: DesignTokens.Size.composerButton)
                .background(fill, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

struct TalkLevels: View {
    let levels: [Double]

    var body: some View {
        let count = Int(DesignTokens.Chat.talkBars)
        let recent = Array(levels.suffix(count))
        let padded = Array(repeating: 0, count: max(0, count - recent.count)) + recent
        HStack(spacing: DesignTokens.Chat.talkBarGap) {
            ForEach(Array(padded.enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(Color.hmText)
                    .frame(
                        width: DesignTokens.Chat.talkBarWidth,
                        height: DesignTokens.Chat.talkBarMinHeight + (DesignTokens.Chat.talkBarMaxHeight - DesignTokens.Chat.talkBarMinHeight) * min(1, max(0, level))
                    )
            }
        }
        .frame(height: DesignTokens.Chat.talkBarMaxHeight)
        .accessibilityHidden(true)
        .animation(.easeOut(duration: 0.1), value: levels)
    }
}

#if DEBUG
import Observation

@MainActor
@Observable
public final class DemoTalk: ChatTalk {
    public let phase: TalkPhase
    public let muted = false
    public let heard: String
    public let levels: [Double]

    public init(phase: TalkPhase, heard: String = "") {
        self.phase = phase
        self.heard = heard
        levels = phase == .listening ? [0.2, 0.4, 0.6, 0.85, 0.5, 0.3, 0.65, 0.95, 0.75, 0.4, 0.25, 0.55, 0.8] : Array(repeating: 0.1, count: 13)
    }

    public func begin(onSaid: @escaping @MainActor (String) -> Void) async throws {}
    public func herReply(_ markdown: String, finished: Bool) {}
    public func setMuted(_ muted: Bool) {}
    public func end() async {}
}
#endif
