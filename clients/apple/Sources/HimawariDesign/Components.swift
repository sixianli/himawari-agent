import SwiftUI

public struct CardBackground: ViewModifier {
    private let padding: EdgeInsets

    public init(padding: EdgeInsets) {
        self.padding = padding
    }

    public func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
            .hmShadow(DesignTokens.Shadows.lift)
    }
}

extension View {
    public func himawariCard(padding: EdgeInsets = EdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18)) -> some View {
        modifier(CardBackground(padding: padding))
    }

    public func himawariScreenBackground() -> some View {
        background(Color.hmBackground.ignoresSafeArea())
    }
}

public enum CapsuleKind: Sendable {
    case primary
    case secondary
}

public struct CapsuleButtonStyle: ButtonStyle {
    private let kind: CapsuleKind
    private let height: CGFloat
    private let fontSize: CGFloat

    public init(_ kind: CapsuleKind, height: CGFloat = 46, fontSize: CGFloat = 16) {
        self.kind = kind
        self.height = height
        self.fontSize = fontSize
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: fontSize, weight: kind == .primary ? .semibold : .regular))
            .foregroundStyle(kind == .primary ? Color.hmOnText : Color.hmText)
            .frame(maxWidth: .infinity, minHeight: height)
            .padding(.horizontal, 16)
            .background(kind == .primary ? Color.hmText : Color.hmFill, in: Capsule())
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Capsule())
    }
}

public struct RowPillButtonStyle: ButtonStyle {
    private let filled: Bool

    public init(filled: Bool) {
        self.filled = filled
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .hmType(filled ? DesignTokens.TypeScale.rowAction : DesignTokens.TypeScale.secondary)
            .foregroundStyle(filled ? Color.hmText : Color.hmMuted)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 14)
            .frame(minHeight: DesignTokens.Size.pillSmall)
            .background(filled ? Color.hmFillStrong : Color.clear, in: Capsule())
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Capsule())
    }
}

public struct DecisionRow: View {
    private let title: String
    private let detail: String?
    private let status: String
    private let decline: String?
    private let confirm: String
    private let openLabel: String
    private let busy: Bool
    private let icon: IconName
    private let statusTint: Color
    private let open: () -> Void
    private let respond: (Bool) -> Void

    public init(
        title: String,
        detail: String?,
        status: String,
        decline: String?,
        confirm: String,
        openLabel: String,
        busy: Bool,
        icon: IconName = .handStop,
        statusTint: Color = .hmSun,
        open: @escaping () -> Void,
        respond: @escaping (Bool) -> Void
    ) {
        self.title = title
        self.detail = detail
        self.status = status
        self.decline = decline
        self.confirm = confirm
        self.openLabel = openLabel
        self.busy = busy
        self.icon = icon
        self.statusTint = statusTint
        self.open = open
        self.respond = respond
    }

    private var statusText: some View {
        Text(status)
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(statusTint)
            .multilineTextAlignment(.leading)
    }

    @ViewBuilder
    private var pills: some View {
        if let decline {
            Button(decline) { respond(false) }
                .buttonStyle(RowPillButtonStyle(filled: false))
        }
        Button(confirm) { respond(true) }
            .buttonStyle(RowPillButtonStyle(filled: true))
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Icon(icon, size: DesignTokens.IconSize.todayRow)
                .foregroundStyle(statusTint)
                .frame(height: DesignTokens.TypeScale.body.lineHeight)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .hmType(DesignTokens.TypeScale.navTitle)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.leading)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .hmType(DesignTokens.TypeScale.caption)
                            .foregroundStyle(Color.hmMuted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        statusText.fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 0)
                        pills
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        statusText.fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 6) {
                            Spacer(minLength: 0)
                            pills
                        }
                    }
                }
                .disabled(busy)
                .opacity(busy ? 0.5 : 1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .accessibilityAction(named: Text(openLabel), open)
    }
}

public struct GlassCircleButton<Leading: View>: View {
    private let label: Text
    private let size: CGFloat
    private let action: () -> Void
    private let icon: Leading

    public init(_ label: Text, size: CGFloat = 48, action: @escaping () -> Void, @ViewBuilder icon: () -> Leading) {
        self.label = label
        self.size = size
        self.action = action
        self.icon = icon()
    }

    public var body: some View {
        Button(action: action) {
            icon
                .foregroundStyle(Color.hmText)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel(label)
    }
}

public struct GroupedRow<Leading: View, Trailing: View>: View {
    private let title: Text
    private let showsChevron: Bool
    private let icon: Leading
    private let trailing: Trailing

    public init(
        _ title: Text,
        showsChevron: Bool = true,
        @ViewBuilder icon: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.showsChevron = showsChevron
        self.icon = icon()
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 14) {
            icon
                .foregroundStyle(Color.hmText)
                .frame(width: DesignTokens.IconSize.listRow, height: DesignTokens.IconSize.listRow)
            title
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .frame(maxWidth: .infinity, alignment: .leading)
            trailing
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmMuted)
            if showsChevron {
                Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .contentShape(Rectangle())
    }
}

public struct ToggleRow<Leading: View>: View {
    private let title: Text
    private let detail: Text?
    @Binding private var isOn: Bool
    private let icon: Leading

    public init(_ title: Text, detail: Text? = nil, isOn: Binding<Bool>, @ViewBuilder icon: () -> Leading) {
        self.title = title
        self.detail = detail
        _isOn = isOn
        self.icon = icon()
    }

    public var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 14) {
                icon
                    .foregroundStyle(Color.hmText)
                    .frame(width: DesignTokens.IconSize.listRow, height: DesignTokens.IconSize.listRow)
                VStack(alignment: .leading, spacing: 2) {
                    title
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                    if let detail {
                        detail
                            .hmType(DesignTokens.TypeScale.caption)
                            .foregroundStyle(Color.hmMuted)
                    }
                }
            }
        }
        .tint(Color.hmSuccess)
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
    }
}

public struct GroupedSection<Content: View>: View {
    private let header: Text?
    private let content: Content

    public init(_ header: Text? = nil, @ViewBuilder content: () -> Content) {
        self.header = header
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let header {
                header
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
                    .padding(.horizontal, 4)
            }
            VStack(spacing: 0) {
                content
            }
            .himawariCard(padding: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
        }
    }
}

public struct RowSeparator: View {
    public init() {}

    public var body: some View {
        Rectangle()
            .fill(Color.hmSeparator)
            .frame(height: 1)
    }
}

public struct EmptyStateView: View {
    private let message: Text

    public init(_ message: Text) {
        self.message = message
    }

    public var body: some View {
        message
            .hmType(DesignTokens.TypeScale.body)
            .foregroundStyle(Color.hmMuted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

public struct ScreenTitle: View {
    private let title: Text

    public init(_ title: Text) {
        self.title = title
    }

    public var body: some View {
        title
            .hmType(DesignTokens.TypeScale.title1, design: .rounded)
            .foregroundStyle(Color.hmText)
            .frame(minHeight: DesignTokens.TypeScale.title1.lineHeight, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

public struct EdgeFade: View {
    public enum Edge: Sendable {
        case top
        case bottom
    }

    private let edge: Edge
    private let height: CGFloat
    private let solid: CGFloat

    public init(_ edge: Edge, height: CGFloat, solid: CGFloat) {
        self.edge = edge
        self.height = height
        self.solid = solid
    }

    public var body: some View {
        LinearGradient(
            stops: [
                .init(color: Color.hmBackground, location: 0),
                .init(color: Color.hmBackground, location: solid),
                .init(color: Color.hmBackground.opacity(0), location: 1),
            ],
            startPoint: edge == .top ? .top : .bottom,
            endPoint: edge == .top ? .bottom : .top
        )
        .frame(height: height)
        .allowsHitTesting(false)
    }
}
