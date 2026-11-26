import HimawariDesign
import SwiftUI

struct NotificationsPage: View {
    let store: QuietHoursStore
    let back: () -> Void
    @State private var failed = false
    @State private var saving: Task<Void, Never>?
    @State private var edits = 0

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.notificationsTitle, leading: .back, action: back)
            if let hours = store.hours, let shown = store.shown {
                let start = shown.start
                let end = shown.end
                if hours.editable {
                    SettingsGroup(label: M.quietWhen) {
                        SettingsRow(
                            icon: nil,
                            title: M.quietAtNight,
                            switchState: Binding(get: { shown.enabled }, set: { value in change { $0.enabled = value } }),
                            last: !shown.enabled
                        )
                        if shown.enabled {
                            ClockRow(title: M.quietFrom, time: start) { value in change { $0.start = value } }
                            ClockRow(title: M.quietTo, time: end, last: true) { value in change { $0.end = value } }
                        }
                    }
                    if shown.enabled {
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

    private func change(_ edit: (inout QuietHoursStore.Choice) -> Void) {
        store.edit(edit)
        edits += 1
        let mine = edits
        let previous = saving
        saving = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard mine == edits else { return }
            await previous?.value
            guard mine == edits else { return }
            do {
                try await store.saveDraft { $0.enabled ? M.quietAtNight : M.quietOff }
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
            DatePicker(selection: Binding(get: { date(time) }, set: { change(clock($0)) }), displayedComponents: .hourAndMinute) {
                Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
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
