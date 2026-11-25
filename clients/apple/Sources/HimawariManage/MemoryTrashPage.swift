import HimawariCore
import HimawariDesign
import SwiftUI

struct MemoryTrashPage: View {
    let store: MemoryStore
    let back: () -> Void
    @State private var failed = false

    var body: some View {
        SettingsPage(gap: DesignTokens.Allowance.pageGap) {
            SheetHeader(title: M.trashTitle, leading: .back, action: back)
            if !store.trashed.isEmpty {
                SettingsGroup(label: nil) {
                    ForEach(store.trashed) { item in
                        TrashRow(item: item, now: Date(), last: item == store.trashed.last) { recover(item) }
                    }
                }
            }
            Text(M.trashFoot)
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
                .padding(.horizontal, DesignTokens.Allowance.footInset)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func recover(_ item: MemoryItem) {
        Task {
            do {
                try await store.recover(item, reason: M.confirmRecover)
                if store.trashed.isEmpty { back() }
            } catch {
                failed = true
            }
        }
    }
}

struct TrashRow: View {
    let item: MemoryItem
    let now: Date
    let last: Bool
    let recover: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                VStack(alignment: .leading, spacing: DesignTokens.Her.rowSubtitleGap) {
                    Text(item.text).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    if let line = Self.line(item, now: now) {
                        Text(line).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: recover) {
                    Text(M.recover)
                        .hmType(DesignTokens.TypeScale.rowAction)
                        .foregroundStyle(Color.hmText)
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

    static func line(_ item: MemoryItem, now: Date) -> String? {
        guard let trashed = Timestamp.parse(item.updatedAt ?? item.recordedAt), let deadline = MemoryStore.trashDeadline(of: item) else { return nil }
        let left = max(1, Int((deadline.timeIntervalSince(now) / 86_400).rounded(.up)))
        return M.trashedLine(trashed, daysLeft: left)
    }
}
