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

    private var tappable: Bool { choose != nil && sending == nil && options.isOpen }

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
            .opacity(options.isOpen ? 1 : DesignTokens.Options.staleOpacity)
        }
        .buttonStyle(.plain)
        .disabled(!tappable)
        .accessibilityHint(item.action?.summary ?? item.reason ?? "")
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: DesignTokens.Options.radius, style: .continuous)
    }

    private func background(_ item: MessageOptions.Item) -> Color {
        item.action == nil ? Color.hmSurface : Color.hmTile
    }

    private func pick(_ item: MessageOptions.Item) {
        guard let choose, tappable else { return }
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
