import HimawariDesign
import SwiftUI

struct ChatPuck: View {
    let busy: Bool
    let open: (() -> Void)?

    var body: some View {
        if let open {
            Button(action: open) { disc }
                .buttonStyle(.pressable)
                .contentShape(Circle())
                .accessibilityLabel(Text(L.text("chat.herPage")))
                .accessibilityAddTraits(.isHeader)
        } else {
            disc
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isHeader)
        }
    }

    private var disc: some View {
        SunflowerMark(motion: busy ? .breathing(low: Double(DesignTokens.Chat.puckBusyLow)) : .idling, seeds: Int(DesignTokens.Chat.puckSeeds))
            .frame(width: DesignTokens.Chat.puckMark, height: DesignTokens.Chat.puckMark)
            .frame(width: DesignTokens.Chat.puckSize, height: DesignTokens.Chat.puckSize)
            .hmRaised(Circle(), fill: .ultraThinMaterial, shadow: DesignTokens.Shadows.puck)
            .overlay(Circle().strokeBorder(Color.hmGlassLine, lineWidth: DesignTokens.Chat.puckLine))
    }
}

struct EmptyChatFlower: View {
    @State private var start = Date()

    var body: some View {
        VStack(spacing: DesignTokens.Chat.emptyWordmarkGap) {
            SunflowerMark(motion: .growingOnce(from: start))
                .frame(width: DesignTokens.Chat.emptyMark, height: DesignTokens.Chat.emptyMark)
            Wordmark(size: DesignTokens.Chat.emptyWordmarkSize, lineHeight: DesignTokens.Avatar.wordmarkLineHeight)
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}
