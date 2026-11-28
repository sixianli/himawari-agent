#if os(macOS)
import HimawariCore
import HimawariDesign
import SwiftUI

enum MacButtonRole {
    case primary
    case secondary
}

struct MacButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    let role: MacButtonRole
    var height: CGFloat = DesignTokens.Mac.buttonHeight
    var small = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .hmType(small
                ? (role == .primary ? DesignTokens.TypeScale.macButtonSmallStrong : DesignTokens.TypeScale.macButtonSmall)
                : (role == .primary ? DesignTokens.TypeScale.macButtonStrong : DesignTokens.TypeScale.macButton))
            .foregroundStyle(role == .primary ? Color.hmOnText : Color.hmText)
            .padding(.horizontal, DesignTokens.Mac.buttonPaddingX)
            .frame(height: height)
            .background(Capsule().fill(role == .primary ? Color.hmText : Color.hmFill))
            .opacity(configuration.isPressed || !isEnabled ? DesignTokens.Opacity.emptyMark : 1)
            .contentShape(Capsule())
    }
}

struct GlassPanel<Content: View>: View {
    let radius: CGFloat
    let content: Content

    init(radius: CGFloat, @ViewBuilder content: () -> Content) {
        self.radius = radius
        self.content = content()
    }

    var body: some View {
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .hmRaised(RoundedRectangle(cornerRadius: radius, style: .continuous), fill: Color.hmGlass, shadow: DesignTokens.Shadows.liftBig)
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.hmGlassLine))
    }
}

struct ContextChipView: View {
    let piece: ContextPiece
    let remove: () -> Void

    var body: some View {
        HStack(spacing: DesignTokens.Mac.statusBadgeGap) {
            if let icon = Self.icon(for: piece) {
                Icon(icon, size: DesignTokens.Mac.chipIcon).foregroundStyle(Color.hmMuted)
            }
            Text(piece.name)
                .hmType(DesignTokens.TypeScale.macChip)
                .foregroundStyle(Color.hmText)
                .lineLimit(1)
                .truncationMode(.middle)
            Button(action: remove) {
                Icon(.x, size: DesignTokens.Mac.chipClose).foregroundStyle(Color.hmMuted)
            }
            .buttonStyle(.pressable)
            .accessibilityLabel(Text(L.format("input.remove", piece.name)))
        }
        .padding(.leading, DesignTokens.Mac.chipPaddingLeading)
        .padding(.trailing, DesignTokens.Mac.chipPaddingTrailing)
        .frame(height: DesignTokens.Mac.chipHeight)
        .background(Capsule().fill(Color.hmFill))
    }

    static func icon(for piece: ContextPiece) -> IconName? {
        switch piece.source {
        case .frontApp: .appWindow
        case .selection: nil
        case .document, .droppedFile: .fileText
        }
    }
}

struct SunflowerBadge: View {
    let size: CGFloat

    var body: some View {
        SunflowerMark()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
#endif
