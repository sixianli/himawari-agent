import HimawariCore
import HimawariDesign
import SwiftUI

struct TimerDetailPage: View {
    static let shownWords = 3
    static let shownResultLines = 3

    let store: TimersStore
    let timerId: String
    let back: () -> Void
    var now: () -> Date = Date.init
    @State private var cancelling = false
    @State private var allWords = false
    @State private var fullResult = false

    var body: some View {
        SettingsPage {
            if let timer = store.timer(timerId), timer.isShown {
                SheetHeader(title: timer.name, leading: .back, action: back)
                TimersNote(text: M.timerDetailLead(canPause: timer.canPause))
                    .padding(.horizontal, SL.groupLabelPadding)
                    .outsideRowCard()
                facts(timer)
                buttons(timer)
            } else {
                SheetHeader(title: M.timersTitle, leading: .back, action: back)
            }
        }
        .confirmationDialog(store.timer(timerId)?.name ?? "", isPresented: $cancelling, titleVisibility: .visible) {
            Button(M.timerCancel, role: .destructive) {
                if let timer = store.timer(timerId) { change(timer, .cancel) }
            }
        } message: {
            Text(M.timerCancelWarning)
        }
        .alert(M.timerChangeFailed, isPresented: Binding(get: { store.failedChange }, set: { store.failedChange = $0 })) {}
    }

    private func facts(_ timer: OwnerTimer) -> some View {
        let budget = timer.runBudgetMicros
        let last = lastLine(timer)
        return SettingsGroup(label: nil) {
            TimerFact(label: M.timerWhenLabel) { factText(TimerText.whenDetail(timer, now: now())) }
            TimerFact(label: M.timerTaskLabel) { factText(timer.task) }
            TimerFact(label: M.timerByLabel) { byFact(timer) }
            TimerFact(label: M.timerRanLabel) {
                factText(M.timerRanDetail(timer.runCount, timer.spentMicros))
            }
            if let budget {
                TimerFact(label: M.timerBudgetLabel) { factText(M.money(budget)) }
            }
            if let last {
                TimerFact(label: M.timerLastLabel) {
                    Button { fullResult.toggle() } label: {
                        factText(last).lineLimit(fullResult ? nil : Self.shownResultLines)
                    }
                    .buttonStyle(.pressable)
                }
            }
        }
    }

    private func byFact(_ timer: OwnerTimer) -> some View {
        let words = timer.ownerWordLines
        let shown = allWords ? words : Array(words.prefix(Self.shownWords))
        return VStack(alignment: .leading, spacing: SL.rowTextGap) {
            factText(M.timerByOn(timer.createdBy, timer.createdAt))
            ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                Text(M.quoted(line))
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !allWords, words.count > Self.shownWords {
                Button { allWords = true } label: {
                    Text(M.timerMoreWords(words.count - Self.shownWords))
                        .hmType(DesignTokens.TypeScale.secondary)
                        .foregroundStyle(Color.hmLink)
                }
                .buttonStyle(.pressable)
            }
        }
    }

    private func lastLine(_ timer: OwnerTimer) -> String? {
        if let result = timer.lastResult { return TimerText.when(result.at, now: now()) + " · " + result.text }
        if let lastAt = timer.lastAt { return TimerText.when(lastAt, now: now()) }
        return nil
    }

    private func factText(_ text: String) -> some View {
        Text(text).hmType(SL.rowValue).foregroundStyle(Color.hmText)
    }

    @ViewBuilder
    private func buttons(_ timer: OwnerTimer) -> some View {
        let busy = store.working.contains(timer.timerId)
        if timer.canPause {
            Section {
                Button(timer.status == .paused ? M.timerResume : M.timerPause) {
                    change(timer, timer.status == .paused ? .resume : .pause)
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(busy)
        }
        DestructiveRow(title: M.timerCancel) { cancelling = true }
            .disabled(busy)
    }

    private func change(_ timer: OwnerTimer, _ action: OwnerTimer.Action) {
        Task {
            await store.change(timer, action, reason: M.timerReason(action, timer.name))
            if action == .cancel, store.timer(timerId)?.isShown != true { back() }
        }
    }
}

struct TimerFact<Value: View>: View {
    let label: String
    @ViewBuilder let value: Value

    var body: some View {
        VStack(alignment: .leading, spacing: SL.rowTextGap) {
            Text(label)
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
            value
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
