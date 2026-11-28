import HimawariDesign
import SwiftUI

typealias SL = ManageLayout.SettingsSheet

struct SheetHeader: View {
    enum Leading {
        case close
        case back
    }

    let title: String
    let leading: Leading
    let action: () -> Void
    @Environment(\.herInSidebar) private var inSidebar

    var body: some View {
        if leading == .back || inSidebar {
            SystemNavigationTitle(Text(title))
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
        } else {
            closeHeader
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
        }
    }

    private var closeHeader: some View {
        HStack {
            Button(M.close, action: action)
            Spacer()
            Text(title).font(.headline).foregroundStyle(Color.hmText)
            Spacer()
            Button(M.close, action: action).hidden()
        }
        .navigationTitle(title)
    }
}

struct SettingsGroup<Rows: View>: View {
    let label: String?
    @ViewBuilder let rows: Rows

    var body: some View {
        Section {
            rows
        } header: {
            if let label {
                Text(label)
            }
        }
    }
}

struct SettingsRow: View {
    enum Tone {
        case muted
        case attention
        case good
    }

    let icon: IconName?
    let title: String
    var detail: String? = nil
    var note: String? = nil
    var warning: String? = nil
    var value: String? = nil
    var tone: Tone = .muted
    var chevron = false
    var switchState: Binding<Bool>? = nil

    var body: some View {
        if let switchState {
            Toggle(isOn: switchState) { label }
        } else {
            HStack(spacing: SL.rowGap) {
                LabeledContent {
                    if let value {
                        Text(value).foregroundStyle(valueColor)
                    }
                } label: {
                    label
                }
                if chevron {
                    Icon(.chevronRight, size: DesignTokens.IconSize.chevron).foregroundStyle(Color.hmMuted)
                }
            }
            .frame(minHeight: SL.rowMinHeight)
            .contentShape(Rectangle())
        }
    }

    private var label: some View {
        Label {
            VStack(alignment: .leading, spacing: SL.rowTextGap) {
                Text(title).foregroundStyle(Color.hmText)
                if let detail {
                    Text(detail).font(.footnote).foregroundStyle(Color.hmMuted)
                }
                if let note {
                    Text(note).font(.footnote).foregroundStyle(Color.hmMuted)
                }
                if let warning {
                    Text(warning).font(.footnote).foregroundStyle(Color.hmDanger)
                }
            }
        } icon: {
            if let icon {
                Icon(icon, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmGlyph)
            }
        }
        .labelStyle(SettingsRowLabelStyle(hasIcon: icon != nil))
    }

    private var valueColor: Color {
        switch tone {
        case .attention: Color.hmDanger
        case .good: Color.hmSun
        case .muted: Color.hmMuted
        }
    }
}

private struct SettingsRowLabelStyle: LabelStyle {
    let hasIcon: Bool

    func makeBody(configuration: Configuration) -> some View {
        if hasIcon {
            Label(configuration)
        } else {
            configuration.title
        }
    }
}

extension View {
    func outsideRowCard() -> some View {
        listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: SL.rowTextGap, leading: 0, bottom: SL.rowTextGap, trailing: 0))
            .listRowSeparator(.hidden)
    }
}

struct DestructiveRow: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Section {
            Button(role: .destructive, action: action) {
                Text(title).frame(maxWidth: .infinity)
            }
        }
    }
}

struct SettingsPage<Content: View>: View {
    var systemBar = true
    @ViewBuilder let content: Content

    var body: some View {
        List { content }
            .scrollContentBackground(.hidden)
            .timersListStyle()
            .tint(Color.hmSun)
            .environment(\.defaultMinListRowHeight, 0)
            .himawariScreenBackground()
            #if os(iOS)
            .toolbar(systemBar ? .visible : .hidden, for: .navigationBar)
            #endif
    }
}

struct SegmentPicker<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(Value, String)]

    var body: some View {
        Picker(selection: $selection) {
            ForEach(options, id: \.0) { value, title in
                Text(title).tag(value)
            }
        } label: {
            EmptyView()
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}
