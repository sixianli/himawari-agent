import HimawariCore
import HimawariDesign
import SwiftUI

struct HerAllowancesPage: View {
    let memory: MemoryStore
    let back: () -> Void
    @State private var failed = false
    @State private var choosingDays = false

    var body: some View {
        SettingsPage(gap: DesignTokens.Allowance.pageGap) {
            SheetHeader(title: M.allowancesTitle, leading: .back, action: back)
            if memory.allowances.isEmpty {
                Text(M.allowancesEmpty)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, DesignTokens.Allowance.footInset)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                SettingsGroup(label: nil) {
                    ForEach(memory.allowances) { allowance in
                        AllowanceRow(allowance: allowance, last: allowance == memory.allowances.last) { revoke(allowance) }
                    }
                }
            }
            if let days = memory.allowanceDays {
                SettingsGroup(label: nil) {
                    Button { choosingDays = true } label: {
                        SettingsRow(icon: nil, title: M.allowanceDaysTitle, value: M.allowanceDaysValue(days), chevron: true, last: true)
                    }
                    .buttonStyle(.pressable)
                }
            }
            Text(M.allowancesFoot)
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, DesignTokens.Allowance.footInset)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .alert(M.revokeFailed, isPresented: $failed) {}
        .sheet(isPresented: $choosingDays) {
            AllowanceDaysSheet(days: memory.allowanceDays ?? ClientCapabilities.allowanceDays.lowerBound) { days in
                try await memory.setAllowanceDays(days, reason: M.allowanceDaysTitle)
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(ManageLayout.DetailSheetShape.cornerRadius)
            .presentationBackground(Color.hmBackground)
        }
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
                .buttonStyle(.pressable)
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
    }
}

struct AllowanceDaysSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var days: Int
    @State private var saving = false
    @State private var failed = false
    let save: (Int) async throws -> Void

    init(days: Int, save: @escaping (Int) async throws -> Void) {
        _days = State(initialValue: days)
        self.save = save
    }

    var body: some View {
        VStack(spacing: DesignTokens.Allowance.pageGap) {
            Text(M.allowanceDaysTitle)
                .hmType(DesignTokens.TypeScale.sheetTitle)
                .foregroundStyle(Color.hmText)
            Picker(M.allowanceDaysTitle, selection: $days) {
                ForEach(Array(ClientCapabilities.allowanceDays), id: \.self) { value in
                    Text(M.allowanceDaysValue(value)).tag(value)
                }
            }
            #if os(iOS)
            .pickerStyle(.wheel)
            #endif
            .labelsHidden()
            .frame(maxHeight: .infinity)
            Button(M.allowanceDaysDone) { commit() }
                .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig))
                .disabled(saving)
        }
        .padding(.top, DesignTokens.Size.sheetPaddingTop)
        .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
        .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        .alert(M.allowanceDaysFailed, isPresented: $failed) {}
    }

    private func commit() {
        saving = true
        Task {
            defer { saving = false }
            do {
                try await save(days)
                dismiss()
            } catch {
                failed = true
            }
        }
    }
}
