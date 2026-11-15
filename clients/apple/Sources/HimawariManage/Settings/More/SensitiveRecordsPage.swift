import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct SensitiveRecordsPage: View {
    let store: MoreSettingsStore
    let back: () -> Void
    @State private var filter: SensitiveFilter = .all
    @State private var failed = false
    @State private var asking = false
    @State private var notice: String?
    @State private var busy = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.sensitiveTitle, leading: .back, action: back)
            if let counts = store.sensitiveCounts {
                if counts.total == 0 {
                    EmptyStateView(Text(M.sensitiveNone)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    MoreNote(M.sensitiveHint)
                    filters(counts)
                    ForEach(days, id: \.day) { day in
                        SettingsGroup(label: dayLabel(day.day)) {
                            ForEach(Array(day.items.enumerated()), id: \.element.id) { index, item in
                                SettingsRow(
                                    icon: nil,
                                    title: M.sensitiveCategory(item.category),
                                    detail: [item.threadId == nil ? M.sensitiveBackground : M.sensitiveThread, M.sensitivePart(item.part)]
                                        .joined(separator: " · "),
                                    note: M.sensitiveWhat(item, time: clock(item.firstSeenAt)),
                                    last: index == day.items.count - 1
                                )
                            }
                        }
                    }
                    if store.sensitiveNext != nil {
                        Button { Task { await store.loadSensitive(more: true) } } label: { Text(M.sensitiveMore) }
                            .buttonStyle(CapsuleButtonStyle(.secondary, height: PL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                    }
                    MoreNote(M.sensitiveFooter)
                    Button { asking = true } label: {
                        Text(M.sensitiveClear).hmType(SL.rowValue).foregroundStyle(Color.hmDanger)
                            .frame(minHeight: DesignTokens.Size.minTapTarget)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, SL.groupLabelPadding)
                    .disabled(busy)
                }
                if let notice { MoreNote(notice) }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.loadSensitive() }
        .refreshable { await store.loadSensitive() }
        .confirmationDialog(M.sensitiveClearAsk, isPresented: $asking, titleVisibility: .visible) {
            Button(M.clear, role: .destructive) { clear() }
            Button(M.cancel, role: .cancel) {}
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private var days: [SensitiveDay] {
        SensitiveRecords.grouped(store.sensitiveItems, filter: filter, calendar: .current)
    }

    private func filters(_ counts: SensitiveCounts) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: PL.buttonGap) {
                ForEach(SensitiveFilter.shown(for: counts), id: \.self) { option in
                    Button { filter = option } label: {
                        Text(M.sensitiveFilter(option, count: option.count(in: counts)))
                    }
                    .buttonStyle(RowPillButtonStyle(filled: filter == option))
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func dayLabel(_ day: Date) -> String {
        if Calendar.current.isDateInToday(day) { return M.today }
        if Calendar.current.isDateInYesterday(day) { return M.yesterday }
        return M.shortDate(day)
    }

    private func clock(_ iso: String) -> String {
        guard let date = DeviceActionTime.parse(iso) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    private func clear() {
        busy = true
        notice = nil
        runMoreAction(failed: $failed) {
            defer { busy = false }
            try await store.clearSensitive(reason: M.confirmSensitiveClear)
            await store.loadSensitive()
            filter = .all
            notice = M.sensitiveCleared
        }
    }
}
