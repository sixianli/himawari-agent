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
        } else {
            closeHeader
        }
    }

    private var closeHeader: some View {
        HStack {
            GlassCircleButton(Text(M.close), size: SL.headerButton, action: action) {
                Icon(.x, size: DesignTokens.IconSize.glassButton)
            }
            Spacer()
            Text(title).hmType(DesignTokens.TypeScale.sheetTitle).foregroundStyle(Color.hmText)
            Spacer()
            Color.clear.frame(width: SL.headerButton, height: SL.headerButton)
        }
        .navigationTitle(title)
    }
}

struct SettingsGroup<Rows: View>: View {
    let label: String?
    @ViewBuilder let rows: Rows

    var body: some View {
        VStack(alignment: .leading, spacing: SL.groupGap) {
            if let label {
                Text(label)
                    .hmType(DesignTokens.TypeScale.groupLabel)
                    .foregroundStyle(Color.hmMuted)
                    .padding(.horizontal, SL.groupLabelPadding)
            }
            VStack(spacing: 0) { rows }
                .padding(.horizontal, SL.rowsPaddingHorizontal)
                .himawariCard(padding: EdgeInsets())
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
    var last = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var valueStacksUnderTitle: Bool {
        typeSize.isAccessibilitySize
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: switchState != nil && (detail != nil || note != nil || warning != nil) ? .top : .center, spacing: SL.rowGap) {
                if let icon {
                    Icon(icon, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmText)
                }
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    if let value, valueStacksUnderTitle {
                        valueText(value)
                    }
                    if let detail {
                        Text(detail).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                    if let note {
                        Text(note).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                    if let warning {
                        Text(warning).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmDanger)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let value, !valueStacksUnderTitle {
                    valueText(value)
                }
                if let switchState {
                    Toggle("", isOn: switchState).labelsHidden()
                }
                if chevron {
                    Icon(.chevronRight, size: DesignTokens.IconSize.chevron).foregroundStyle(Color.hmMuted)
                }
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
        .contentShape(Rectangle())
    }

    private func valueText(_ value: String) -> some View {
        Text(value)
            .hmType(SL.rowValue)
            .foregroundStyle(tone == .attention ? Color.hmDanger : tone == .good ? Color.hmSun : Color.hmMuted)
    }
}

struct SettingsPage<Content: View>: View {
    let gap: CGFloat
    var systemBar = true
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: gap) { content }
                .padding(.top, systemBar ? SL.groupGap : DesignTokens.Size.sheetPaddingTop)
                .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollIndicators(.hidden)
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
        .controlSize(.large)
    }
}
