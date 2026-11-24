import SwiftUI

public struct FloatingTab<ID: Hashable>: Identifiable {
    public let id: ID
    public let title: Text
    public let badge: Int?
    public let icon: AnyView

    public init<Glyph: View>(id: ID, title: Text, badge: Int? = nil, @ViewBuilder icon: () -> Glyph) {
        self.id = id
        self.title = title
        self.badge = badge
        self.icon = AnyView(icon())
    }
}

public struct FloatingTabBar<ID: Hashable>: View {
    @Binding private var selection: ID
    private let tabs: [FloatingTab<ID>]
    @Namespace private var highlight

    public init(selection: Binding<ID>, tabs: [FloatingTab<ID>]) {
        _selection = selection
        self.tabs = tabs
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(tabs) { tab in
                Button {
                    selection = tab.id
                } label: {
                    VStack(spacing: 1) {
                        tab.icon.frame(width: DesignTokens.IconSize.tab, height: DesignTokens.IconSize.tab)
                        tab.title.hmType(DesignTokens.TypeScale.tabLabel)
                    }
                    .foregroundStyle(tab.id == selection ? Color.hmSun : Color.hmText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background {
                        if tab.id == selection {
                            Capsule().fill(Color.hmFill).matchedGeometryEffect(id: "tab", in: highlight)
                        }
                    }
                    .overlay(alignment: .top) {
                        if let badge = tab.badge, badge > 0 {
                            Text(badge, format: .number)
                                .hmType(DesignTokens.TypeScale.badge, design: .rounded)
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .frame(minWidth: DesignTokens.Size.badge, minHeight: DesignTokens.Size.badge)
                                .background(DesignTokens.Colors.badge.color, in: Capsule())
                                .offset(x: 16, y: 4)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(tab.id == selection ? .isSelected : [])
            }
        }
        .padding(4)
        .frame(height: DesignTokens.Size.tabBarHeight)
        .glassEffect(.regular, in: Capsule())
        .animation(.snappy(duration: 0.25), value: selection)
    }
}

public struct SunflowerButton: View {
    private let label: Text
    private let action: () -> Void

    public init(_ label: Text, action: @escaping () -> Void) {
        self.label = label
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            SunflowerMark()
                .frame(width: DesignTokens.Size.composerButton, height: DesignTokens.Size.composerButton)
                .frame(width: DesignTokens.Size.speakButton, height: DesignTokens.Size.speakButton)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel(label)
    }
}
