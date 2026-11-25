import HimawariCore
import HimawariDesign
import SwiftUI

struct HerAllowancesPage: View {
    let memory: MemoryStore
    let back: () -> Void
    @State private var failed = false

    var body: some View {
        SettingsPage(gap: DesignTokens.Allowance.pageGap) {
            SheetHeader(title: M.allowancesTitle, leading: .back, action: back)
            if !memory.allowances.isEmpty {
                SettingsGroup(label: nil) {
                    ForEach(memory.allowances) { allowance in
                        AllowanceRow(allowance: allowance, last: allowance == memory.allowances.last) { revoke(allowance) }
                    }
                }
            }
            Text(M.allowancesFoot)
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
                .padding(.horizontal, DesignTokens.Allowance.footInset)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .alert(M.revokeFailed, isPresented: $failed) {}
    }

    private func revoke(_ allowance: OwnerAllowance) {
        Task {
            do {
                try await memory.revoke(allowance, reason: allowance.title)
            } catch {
                failed = true
            }
        }
    }
}

struct AllowanceRow: View {
    let allowance: OwnerAllowance
    let last: Bool
    let revoke: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                VStack(alignment: .leading, spacing: DesignTokens.Her.rowSubtitleGap) {
                    Text(allowance.title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    Text(M.allowanceScope(allowance)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: revoke) {
                    Text(M.revoke)
                        .hmType(DesignTokens.TypeScale.rowAction)
                        .foregroundStyle(Color.hmDanger)
                        .frame(minHeight: DesignTokens.Size.minTapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
    }
}
