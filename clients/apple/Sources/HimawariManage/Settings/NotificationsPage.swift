import HimawariDesign
import SwiftUI

struct NotificationsPage: View {
    let store: QuietHoursStore
    let back: () -> Void
    @State private var failed = false
    @State private var saving: Task<Void, Never>?

    static let suggestedStart = ClockTime(hour: 23, minute: 0)
    static let suggestedEnd = ClockTime(hour: 7, minute: 0)

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.notificationsTitle, leading: .back, action: back)
            if let hours = store.hours {
                let start = ClockTime(hours.start) ?? Self.suggestedStart
                let end = ClockTime(hours.end) ?? Self.suggestedEnd
                if hours.editable {
                    SettingsGroup(label: M.quietWhen) {
                        SettingsRow(
                            icon: nil,
                            title: M.quietAtNight,
                            switchState: Binding(get: { hours.enabled }, set: { save(enabled: $0, start: start, end: end) }),
                            last: !hours.enabled
                        )
                        if hours.enabled {
                            ClockRow(title: M.quietFrom, time: start) { save(enabled: true, start: $0, end: end) }
                            ClockRow(title: M.quietTo, time: end, last: true) { save(enabled: true, start: start, end: $0) }
                        }
                    }
                    if hours.enabled {
                        note(M.quietNote(end: end.shortText))
                    }
                } else {
                    SettingsGroup(label: M.quietWhen) {
                        ForEach(Array(hours.rules.enumerated()), id: \.element.ruleId) { index, rule in
                            SettingsRow(icon: nil, title: rule.summary, last: index == hours.rules.count - 1)
                        }
                    }
                    note(M.quietReadOnly)
                }
                note(M.quietSayIt)
            } else if store.phase == .loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .refreshable { await store.load() }
        .task { await store.load() }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(Color.hmMuted)
            .padding(.horizontal, SL.groupLabelPadding)
    }

    private func save(enabled: Bool, start: ClockTime, end: ClockTime) {
        saving?.cancel()
        saving = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            do {
                try await store.set(enabled: enabled, start: start, end: end, reason: enabled ? M.quietAtNight : M.quietOff)
            } catch {
                failed = true
            }
        }
    }
}

struct ClockRow: View {
    let title: String
    let time: ClockTime
    var last = false
    let change: (ClockTime) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DatePicker("", selection: Binding(get: { date(time) }, set: { change(clock($0)) }), displayedComponents: .hourAndMinute)
                    .labelsHidden()
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
    }

    private func date(_ time: ClockTime) -> Date {
        Calendar.current.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: Date()) ?? Date()
    }

    private func clock(_ date: Date) -> ClockTime {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return ClockTime(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    }
}
