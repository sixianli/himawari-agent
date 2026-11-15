import HimawariCore
import HimawariDesign
import SwiftUI

public struct SensesView<Handover: View>: View {
    private let model: SensesModel
    private let close: (() -> Void)?
    private let handover: Handover
    @State private var path: [SenseItem]
    @Environment(\.dismiss) private var dismiss

    public init(model: SensesModel, opening: SenseItem? = nil, close: (() -> Void)? = nil, @ViewBuilder handover: () -> Handover) {
        self.model = model
        self.close = close
        self.handover = handover()
        _path = State(initialValue: opening.map { [$0] } ?? [])
    }

    public var body: some View {
        NavigationStack(path: $path) {
            overview
                .navigationDestination(for: SenseItem.self) { item in
                    SenseItemScreen(model: model, item: item) {
                        if !path.isEmpty { path.removeLast() }
                    }
                }
        }
        .task { await model.refresh() }
        .alert(model.notice ?? "", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button(L.text("detail.ok")) { model.notice = nil }
        }
    }

    private var overview: some View {
        SenseSheet(title: L.text("senses.title"), back: { if let close { close() } else { dismiss() } }) {
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.Senses.listGap) {
                    GroupedSection(Text(L.text("senses.thisDevice"))) {
                        ForEach(Array(model.items.enumerated()), id: \.element) { index, item in
                            if index > 0 { RowSeparator() }
                            row(item)
                        }
                    }
                    GroupedSection(Text(L.text("senses.handedOver"))) {
                        handover
                    }
                    Text(L.text("senses.footnote"))
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, DesignTokens.Senses.footnotePaddingX)
                }
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
            .scrollIndicators(.hidden)
        }
    }

    @ViewBuilder
    private func row(_ item: SenseItem) -> some View {
        let state = model.state(item)
        let content = SenseRow(icon: item.icon, title: item.name, detail: item.text("detail"), status: state.label, statusColor: state.color, showsChevron: state != .serverUnsupported)
        if state == .serverUnsupported {
            content
        } else {
            NavigationLink(value: item) { content }
                .buttonStyle(.plain)
        }
    }
}

public struct SenseRow: View {
    let icon: IconName
    let title: String
    let detail: String
    let status: String
    let statusColor: Color
    let showsChevron: Bool

    public init(icon: IconName, title: String, detail: String, status: String, statusColor: Color, showsChevron: Bool = true) {
        self.icon = icon
        self.title = title
        self.detail = detail
        self.status = status
        self.statusColor = statusColor
        self.showsChevron = showsChevron
    }

    public var body: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            Icon(icon, size: DesignTokens.IconSize.listRow)
                .foregroundStyle(Color.hmText)
            VStack(alignment: .leading, spacing: DesignTokens.Senses.factLabelGap) {
                Text(title)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                Text(detail)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(status)
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(statusColor)
            if showsChevron {
                Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct SenseSheet<Content: View>: View {
    let title: String
    let back: () -> Void
    let content: Content

    init(title: String, back: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.title = title
        self.back = back
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(title)
                    .hmType(DesignTokens.TypeScale.navTitle)
                    .foregroundStyle(Color.hmText)
                    .lineLimit(1)
                    .padding(.horizontal, DesignTokens.Size.glassButton)
                    .accessibilityAddTraits(.isHeader)
                HStack {
                    GlassCircleButton(Text(L.text("senses.back")), action: back) {
                        Icon(.chevronLeft, size: DesignTokens.IconSize.glassButton)
                    }
                    Spacer()
                }
            }
            .padding(.bottom, DesignTokens.Senses.listGap)
            content
        }
        .padding(.top, DesignTokens.Size.sheetPaddingTop)
        .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .himawariScreenBackground()
        .senseHidesNavigationBar()
    }
}

extension View {
    @ViewBuilder
    func senseHidesNavigationBar() -> some View {
        #if os(iOS)
        toolbar(.hidden, for: .navigationBar)
        #else
        self
        #endif
    }
}

extension SenseItem {
    var icon: IconName {
        switch self {
        case .location: .mapPin
        case .calendar: .calendar
        case .health: .heartbeat
        case .contacts: .addressBook
        case .photos: .photo
        case .clipboard: .clipboard
        }
    }

    var largeIcon: IconName {
        switch self {
        case .location: .mapPinLarge
        case .calendar: .calendarLarge
        case .health: .heartbeatLarge
        case .contacts: .addressBookLarge
        case .photos: .photoLarge
        case .clipboard: .clipboardLarge
        }
    }
}

extension SenseState {
    var label: String {
        switch self {
        case .on: L.text("state.on")
        case .off: L.text("state.off")
        case .systemDenied: L.text("state.systemDenied")
        case .serverPaused: L.text("state.paused")
        case .serverUnsupported: L.text("state.unsupported")
        }
    }

    var color: Color {
        switch self {
        case .on: Color.hmSuccess
        case .systemDenied: Color.hmSun
        case .off, .serverPaused, .serverUnsupported: Color.hmMuted
        }
    }
}
