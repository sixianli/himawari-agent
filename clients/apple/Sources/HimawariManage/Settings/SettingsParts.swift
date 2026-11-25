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
            GlassCircleButton(Text(leading == .close ? M.close : M.back), size: SL.headerButton, action: action) {
                Icon(leading == .close ? .x : .chevronLeft, size: DesignTokens.IconSize.glassButton)
            }
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
    var warning: String? = nil
    var value: String? = nil
    var tone: Tone = .muted
    var chevron = false
    var switchState: Binding<Bool>? = nil
    var last = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: switchState != nil && (detail != nil || note != nil || warning != nil) ? .top : .center, spacing: SL.rowGap) {
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
                    if let warning {
                        Text(warning).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmDanger)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let value {
                    Text(value)
                        .hmType(SL.rowValue)
                        .foregroundStyle(tone == .attention ? Color.hmDanger : tone == .good ? Color.hmSuccess : Color.hmMuted)
                }
                if let switchState {
                    Toggle("", isOn: switchState).labelsHidden().tint(Color.hmSuccess)
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

struct SettingsPage<Content: View>: View {
    let gap: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: gap) { content }
                .padding(.top, DesignTokens.Size.sheetPaddingTop)
                .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
                .containerRelativeFrame(.vertical, alignment: .top)
        }
        .scrollIndicators(.hidden)
        .himawariScreenBackground()
        #if os(iOS)
        .toolbar(.hidden, for: .navigationBar)
        #endif
    }
}

struct SegmentPicker<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(Value, String)]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.0) { value, title in
                option(value, title)
            }
        }
        .padding(ManageLayout.Segment.inset)
        .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.segment, style: .continuous))
    }

    private func option(_ value: Value, _ title: String) -> some View {
        Button {
            selection = value
        } label: {
            Text(title)
                .hmType(selection == value ? DesignTokens.TypeScale.navTitle : DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.minTapTarget)
                .background {
                    if selection == value {
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.segment - ManageLayout.Segment.inset, style: .continuous)
                            .fill(Color.hmSurface)
                            .hmShadow(DesignTokens.Shadows.lift)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == value ? .isSelected : [])
    }
}
