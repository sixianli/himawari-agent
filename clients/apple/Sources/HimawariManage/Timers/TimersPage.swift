import HimawariCore
import HimawariDesign
import SwiftUI

struct TimersPage: View {
    let store: TimersStore
    let open: (String) -> Void
    let back: () -> Void
    var now: () -> Date = Date.init
    @State private var cancelling: OwnerTimer?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: M.timersTitle, leading: .back, action: back)
            List {
                Section {
                } header: {
                    TimersNote(text: M.timersLead)
                }
                if store.phase == .failed, store.timers.isEmpty {
                    Section {
                        Text(M.timersLoadFailed)
                            .hmType(DesignTokens.TypeScale.body)
                            .foregroundStyle(Color.hmMuted)
                            .frame(minHeight: SL.rowMinHeight)
                    }
                }
                ForEach(store.groups) { group in
                    Section {
                        ForEach(group.timers) { timer in
                            row(timer)
                        }
                    } header: {
                        TimersNote(text: M.timerKind(group.kind))
                    }
                }
                Section {
                } footer: {
                    TimersNote(text: M.timersFoot)
                }
            }
            .scrollContentBackground(.hidden)
            .timersListStyle()
            .refreshable { await store.load() }
        }
        .himawariScreenBackground()
        .task { await store.load() }
        .confirmationDialog(cancelling?.name ?? "", isPresented: Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }), titleVisibility: .visible) {
            Button(M.timerCancel, role: .destructive) {
                if let timer = cancelling { change(timer, .cancel) }
            }
        } message: {
            Text(M.timerCancelWarning)
        }
        .alert(M.timerChangeFailed, isPresented: Binding(get: { store.failedChange }, set: { store.failedChange = $0 })) {}
    }

    private func row(_ timer: OwnerTimer) -> some View {
        HStack(spacing: SL.rowGap) {
            Button { open(timer.timerId) } label: {
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    Text(timer.name)
                        .hmType(SL.rowValue)
                        .foregroundStyle(Color.hmText)
                        .lineLimit(1)
                    Text(TimerText.line(timer, now: now()))
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, minHeight: SL.rowMinHeight, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            if timer.status == .paused {
                Button(M.timerResume) { change(timer, .resume) }
                    .hmType(DesignTokens.TypeScale.rowAction)
                    .foregroundStyle(Color.hmLink)
                    .frame(minWidth: DesignTokens.Size.minTapTarget, minHeight: DesignTokens.Size.minTapTarget)
                    .buttonStyle(.pressable)
                    .disabled(store.working.contains(timer.timerId))
            }
        }
        .listRowBackground(Color.hmSurface)
        .listRowSeparatorTint(Color.hmSeparator)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { cancelling = timer } label: { Text(M.timerCancel) }
            if timer.canPause {
                Button(timer.status == .paused ? M.timerResume : M.timerPause) {
                    change(timer, timer.status == .paused ? .resume : .pause)
                }
                .tint(Color.hmMuted)
            }
        }
    }

    private func change(_ timer: OwnerTimer, _ action: OwnerTimer.Action) {
        Task { await store.change(timer, action, reason: M.timerReason(action, timer.name)) }
    }
}

struct TimersNote: View {
    let text: String

    var body: some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(Color.hmMuted)
            .textCase(nil)
    }
}

enum TimerText {
    static func when(_ date: Date, now: Date) -> String { M.timerWhen(TimerWhen(date, now: now)) }

    static func line(_ timer: OwnerTimer, now: Date) -> String {
        var parts: [String] = []
        if timer.status == .paused {
            parts.append(M.timerPaused)
        } else if let next = timer.nextAt {
            parts.append(when(next, now: now))
        }
        if timer.kind == .recurring { parts.append(timer.schedule) }
        parts.append(M.timerBy(timer.createdBy))
        if timer.runCount > 0 { parts.append(M.timerRan(timer.runCount, timer.spentMicros)) }
        return parts.joined(separator: " · ")
    }

    static func whenDetail(_ timer: OwnerTimer, now: Date) -> String {
        if timer.status == .paused { return timer.schedule + " · " + M.timerPaused }
        guard let next = timer.nextAt else { return timer.schedule }
        return timer.schedule + " · " + M.timerNext(when(next, now: now))
    }
}

extension View {
    @ViewBuilder
    func timersListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }
}
