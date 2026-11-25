import HimawariCore
import HimawariDesign
import SwiftUI

struct BubbleQuote: Equatable {
    let targetId: String?
    let fromAgent: Bool
    let line: String

    static func missing() -> BubbleQuote {
        BubbleQuote(targetId: nil, fromAgent: false, line: L.text("chat.reply.missing"))
    }

    var label: String? {
        guard targetId != nil else { return nil }
        return L.text(fromAgent ? "chat.reply.toAgent" : "chat.reply.toOwner")
    }
}

struct ReplyQuoteView: View {
    let quote: BubbleQuote
    let lines: Int

    var body: some View {
        HStack(alignment: .top, spacing: DesignTokens.Chat.replyQuoteGap) {
            Capsule()
                .fill(quote.targetId == nil ? Color.hmMuted : Color.hmReplyBar)
                .frame(width: DesignTokens.Chat.replyBarWidth)
            VStack(alignment: .leading, spacing: DesignTokens.Chat.listGap) {
                if let label = quote.label {
                    Text(label)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                }
                Text(quote.line)
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
                    .lineLimit(lines)
                    .truncationMode(.tail)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
}

struct ReplyComposerBar: View {
    let quote: BubbleQuote
    let cancel: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: DesignTokens.Chat.replyQuoteGap) {
            ReplyQuoteView(quote: quote, lines: 1)
            Spacer(minLength: 0)
            Button(action: cancel) {
                Icon(.x, size: DesignTokens.Chat.attachRowIcon)
                    .foregroundStyle(Color.hmMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(L.text("chat.reply.cancel")))
        }
        .padding(.vertical, DesignTokens.Chat.listMarkerGap)
        .padding(.horizontal, DesignTokens.Size.composerInsetX)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Chat.codeRadius, style: .continuous))
    }
}
