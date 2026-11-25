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

    public static let height = DesignTokens.Avatar.size + DesignTokens.Avatar.wordmarkGap + Wordmark.lineBox(size: DesignTokens.Avatar.wordmarkSize, lineHeight: DesignTokens.Avatar.wordmarkLineHeight)

    public var body: some View {
        VStack(spacing: DesignTokens.Avatar.wordmarkGap) {
            ZStack {
                if moving {
                    TimelineView(.animation) { context in
                        glow(strength: Self.pulse(at: context.date))
                    }
                }
                Circle()
                    .fill(Color.hmSpeak)
                    .frame(width: DesignTokens.Avatar.size, height: DesignTokens.Avatar.size)
                SunflowerMark(growing: busy)
                    .frame(width: DesignTokens.Avatar.mark, height: DesignTokens.Avatar.mark)
            }
            .frame(width: DesignTokens.Avatar.size, height: DesignTokens.Avatar.size)
            Wordmark(size: DesignTokens.Avatar.wordmarkSize, lineHeight: DesignTokens.Avatar.wordmarkLineHeight)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
    }

    static func pulse(at date: Date) -> Double {
        let period = Double(DesignTokens.Avatar.busyGlowSeconds)
        let phase = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
        return 0.5 - 0.5 * cos(phase * 2 * .pi)
    }

    private func glow(strength: Double) -> some View {
        let diameter = DesignTokens.Avatar.size - 2 * DesignTokens.Avatar.busyGlowInset
        let opacity = DesignTokens.Avatar.busyGlowOpacityMin + (DesignTokens.Avatar.busyGlowOpacityMax - DesignTokens.Avatar.busyGlowOpacityMin) * strength
        let scale = DesignTokens.Avatar.busyGlowScaleMin + (DesignTokens.Avatar.busyGlowScaleMax - DesignTokens.Avatar.busyGlowScaleMin) * strength
        return RadialGradient(
            colors: [Color.hmGlow, Color.hmGlow.opacity(0)],
            center: .center,
            startRadius: 0,
            endRadius: diameter / 2
        )
        .frame(width: diameter, height: diameter)
        .scaleEffect(scale)
        .opacity(opacity)
        .allowsHitTesting(false)
    }
}
