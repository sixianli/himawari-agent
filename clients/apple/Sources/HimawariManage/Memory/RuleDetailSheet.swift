import HimawariDesign
import SwiftUI

struct RuleDetailSheet: View {
    typealias R = ManageLayout.RuleSheet

    let rule: RuleSummary
    let close: () -> Void
    let respond: (String) -> Void
    let talk: () -> Void
    let openMemory: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: R.gap) {
            SheetHeader(title: M.rule, leading: .close, action: close)
            Text(rule.summary)
                .hmType(ManageLayout.DetailSheet.title)
                .foregroundStyle(Color.hmText)
                .padding(.horizontal, R.summaryPadding)
            let rows = RuleFacts.rows(rule)
            if !rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        if index > 0 { RowSeparator() }
                        Group {
                            if let memoryId = row.opensMemory {
                                Button { openMemory(memoryId) } label: {
                                    SettingsRow(icon: nil, title: row.title, detail: row.detail, note: row.note, chevron: true)
                                }
                                .buttonStyle(.pressable)
                            } else {
                                SettingsRow(icon: nil, title: row.title, detail: row.detail, note: row.note)
                            }
                        }
                        .padding(.vertical, SL.rowPaddingVertical)
                    }
                }
                .padding(.horizontal, SL.rowsPaddingHorizontal)
                .himawariCard(padding: EdgeInsets())
            }
            Spacer(minLength: 0)
            HStack(spacing: R.actionGap) {
                Button { respond("undo") } label: {
                    Text(M.pauseRule)
                        .hmType(ManageLayout.DetailSheet.action)
                        .foregroundStyle(Color.hmDanger)
                        .padding(.horizontal, R.destructivePadding)
                        .frame(minHeight: R.actionHeight)
                }
                .buttonStyle(.pressable)
                Spacer()
                if rule.status == "needs_review" && rule.enforced {
                    pill(M.reconfirmRule) { respond("reconfirm") }
                }
                pill(M.edit, action: talk)
            }
        }
        .padding(.top, DesignTokens.Size.sheetPaddingTop)
        .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
        .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        .background(Color.hmBackground)
    }

    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .hmType(ManageLayout.DetailSheet.action)
                .foregroundStyle(Color.hmText)
                .padding(.horizontal, R.actionPadding)
                .frame(minHeight: R.actionHeight)
                .background(Color.hmFill, in: Capsule())
        }
        .buttonStyle(.pressable)
    }
}
