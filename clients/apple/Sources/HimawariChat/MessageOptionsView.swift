import HimawariCore
import HimawariDesign
import SwiftUI

struct MessageOptionsView: View {
    let options: MessageOptions
    let choose: (@MainActor (MessageOptions.Item) async throws -> Void)?
    @State private var sending: String?

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Options.gap) {
            ForEach(options.items) { item in
                button(item)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tappable(_ item: MessageOptions.Item) -> Bool { choose != nil && sending == nil && item.isOpen }

    private func button(_ item: MessageOptions.Item) -> some View {
        Button {
            pick(item)
        } label: {
            HStack(spacing: DesignTokens.Options.iconGap) {
                if item.action != nil {
                    Icon(.send, size: DesignTokens.Options.icon)
                }
                Text(item.label)
                    .hmType(DesignTokens.TypeScale.option)
                    .multilineTextAlignment(.leading)
            }
            .foregroundStyle(item.isDismiss ? Color.hmMuted : Color.hmText)
            .padding(.vertical, DesignTokens.Options.paddingVertical)
            .padding(.horizontal, DesignTokens.Options.paddingHorizontal)
            .frame(minHeight: DesignTokens.Options.height)
            .background(background(item), in: shape)
            .overlay {
                if item.action == nil { shape.strokeBorder(Color.hmSeparator) }
            }
            .frame(maxWidth: DesignTokens.Options.maxWidth, alignment: .leading)
            .opacity(item.isOpen ? 1 : DesignTokens.Options.staleOpacity)
        }
        .buttonStyle(.pressable)
        .disabled(!tappable(item))
        .accessibilityHint(item.action?.summary ?? item.reason ?? "")
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: DesignTokens.Options.radius, style: .continuous)
    }

    private func background(_ item: MessageOptions.Item) -> Color {
        item.action == nil ? Color.hmSurface : Color.hmTile
    }

    private func pick(_ item: MessageOptions.Item) {
        guard let choose, tappable(item) else { return }
        sending = item.optionId
        Haptics.shared.report(.messageSent)
        Task {
            do {
                try await choose(item)
            } catch {
                Haptics.shared.report(.taskFailed)
                sending = nil
            }
        }
    }
}

struct ChosenOptionBubble: View {
    let text: String
    var maxWidth: CGFloat = DesignTokens.Size.bubbleMaxWidth

    var body: some View {
        VStack(alignment: .trailing, spacing: DesignTokens.Options.chosenCaptionGap) {
            Text(L.text("chat.option.chosen"))
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
                .padding(.trailing, DesignTokens.Options.chosenCaptionInset)
            OwnerBubble(text: text, maxWidth: maxWidth)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
