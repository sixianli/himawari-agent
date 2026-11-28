import HimawariCore
import HimawariDesign
import SwiftUI

struct RecalledConversationsCard: View {
    let conversations: [RecalledConversation]

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Chat.answerBlockGap / 2) {
            Text(L.text("chat.why.conversations"))
                .font(.footnote)
                .foregroundStyle(Color.hmMuted)
                .accessibilityAddTraits(.isHeader)
            ForEach(conversations) { conversation in
                VStack(alignment: .leading, spacing: DesignTokens.Chat.answerBlockGap / 4) {
                    Text(Self.day(conversation.day))
                        .font(.footnote)
                        .foregroundStyle(Color.hmMuted)
                    Text(conversation.preview)
                        .font(.subheadline)
                        .foregroundStyle(Color.hmText)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(DesignTokens.Options.paddingHorizontal)
        .frame(maxWidth: DesignTokens.Size.bubbleMaxWidth, alignment: .leading)
        .background(Color.hmFillStrong, in: RoundedRectangle(cornerRadius: DesignTokens.Chat.whyCardRadius, style: .continuous))
    }

    static func day(_ day: String) -> String {
        guard let date = try? Date(day, strategy: Date.ISO8601FormatStyle().year().month().day()) else { return day }
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
        style.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return date.formatted(style)
    }
}
