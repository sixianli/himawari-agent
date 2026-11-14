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

    var body: some View {
        HStack {
            Button(action: action) {
                Icon(leading == .close ? .x : .chevronLeft, size: leading == .close ? SL.headerIcon : SL.backIcon)
                    .foregroundStyle(Color.hmText)
                    .frame(width: SL.headerButton, height: SL.headerButton)
                    .background(Color.hmFill, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(leading == .close ? M.close : M.back))
            Spacer()
            Text(title).hmType(DesignTokens.TypeScale.sheetTitle).foregroundStyle(Color.hmText)
            Spacer()
            Color.clear.frame(width: SL.headerButton, height: SL.headerButton)
        }
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
    var value: String? = nil
    var tone: Tone = .muted
    var chevron = false
    var switchState: Binding<Bool>? = nil
    var last = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                if let icon {
                    Icon(icon, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmText)
                }
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    if let detail {
                        Text(detail).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                    if let note {
                        Text(note).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let value {
                    Text(value)
                        .hmType(SL.rowValue)
                        .foregroundStyle(tone == .attention ? Color.hmDanger : tone == .good ? Color.hmSuccess : Color.hmMuted)
                }
                if let switchState {
                    Toggle("", isOn: switchState).labelsHidden().tint(Color.hmSun)
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
}
