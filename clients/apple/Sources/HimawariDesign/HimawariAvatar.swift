import Foundation
import SwiftUI

public struct HimawariAvatar: View {
    private let busy: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.stillFrames) private var stillFrames

    public init(busy: Bool) {
        self.busy = busy
    }

    private var moving: Bool { busy && !reduceMotion && !stillFrames }

    public var body: some View {
        VStack(spacing: DesignTokens.Chat.avatarGap) {
            ZStack {
                if moving {
                    TimelineView(.animation) { context in
                        glow(strength: Self.pulse(at: context.date))
                    }
                }
                Circle()
                    .fill(Color.hmSpeak)
                    .frame(width: DesignTokens.Chat.avatar, height: DesignTokens.Chat.avatar)
                SunflowerMark(growing: busy)
                    .frame(width: DesignTokens.Chat.avatarMark, height: DesignTokens.Chat.avatarMark)
            }
            .frame(width: DesignTokens.Chat.avatar, height: DesignTokens.Chat.avatar)
            Wordmark(height: DesignTokens.Chat.avatarLabelHeight)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
    }

    static func pulse(at date: Date) -> Double {
        let period = Double(DesignTokens.Chat.avatarPulseSeconds)
        let phase = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
        return 0.5 - 0.5 * cos(phase * 2 * .pi)
    }

    private func glow(strength: Double) -> some View {
        RadialGradient(
            colors: [Color.hmGlow, Color.hmGlow.opacity(0)],
            center: .center,
            startRadius: DesignTokens.Chat.avatar / 2,
            endRadius: DesignTokens.Chat.avatarGlow / 2
        )
        .frame(width: DesignTokens.Chat.avatarGlow, height: DesignTokens.Chat.avatarGlow)
        .opacity(0.35 + 0.65 * strength)
        .allowsHitTesting(false)
    }
}
