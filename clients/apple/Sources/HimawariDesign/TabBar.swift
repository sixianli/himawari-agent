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
                        tab.icon.frame(width: 26, height: 26)
                        tab.title.font(.system(size: 11, weight: .semibold))
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
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .frame(minWidth: 18, minHeight: 18)
                                .background(Color.hmBadge, in: Capsule())
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
        .frame(height: 64)
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
            SunflowerMark(detail: .compact)
                .frame(width: 46, height: 46)
                .frame(width: 64, height: 64)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel(label)
    }
}
