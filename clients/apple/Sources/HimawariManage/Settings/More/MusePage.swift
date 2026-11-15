import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct MusePage: View {
    let store: MoreSettingsStore
    let back: () -> Void
    @State private var failed = false
    @State private var asking = false
    @State private var busy = false
    @State private var notice: String?
    @State private var pendingPaused: Bool?

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.museTitle, leading: .back, action: back)
            if let overview = store.muse {
                MoreNote(M.museChannel(overview.channel, time: overview.channel.lastBatchAt.flatMap(clock)), warning: overview.channel.isDown)
                if overview.channel.hasReceived {
                    summary(overview)
                    if overview.items.isEmpty {
                        MoreNote(M.museEmpty)
                    } else {
                        MoreNote(M.museNote)
                        VStack(spacing: PL.gap) {
                            ForEach(overview.items) { item in
                                MuseItemCard(item: item, busy: busy) { timing, content in
                                    rate(item, timing, content)
                                }
                            }
                        }
                    }
                }
                SettingsGroup(label: nil) {
                    SettingsRow(
                        icon: nil,
                        title: M.museIntake,
                        detail: M.museIntakeHint,
                        switchState: Binding(
                            get: { !(pendingPaused ?? overview.channel.isPaused) },
                            set: { setIntake(paused: !$0) }
                        ),
                        last: true
                    )
                    .disabled(pendingPaused != nil)
                }
                Button { asking = true } label: {
                    Text(M.museClear).hmType(SL.rowValue).foregroundStyle(Color.hmDanger)
                        .frame(minHeight: DesignTokens.Size.minTapTarget)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, SL.groupLabelPadding)
                .disabled(busy)
                if let notice { MoreNote(notice) }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.loadMuse() }
        .refreshable { await store.loadMuse() }
        .confirmationDialog(M.museClearAsk, isPresented: $asking, titleVisibility: .visible) {
            Button(M.clear, role: .destructive) { clearAll() }
            Button(M.cancel, role: .cancel) {}
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    @ViewBuilder
    private func summary(_ overview: MuseOverview) -> some View {
        VStack(alignment: .leading, spacing: SL.rowTextGap) {
            Text(M.museReceived(overview.receivedWeek)).hmType(SL.rowValue).foregroundStyle(Color.hmText)
            Text(M.musePending(overview.pending)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            if overview.suppressedWeek > 0 {
                Text(M.museSuppressed(overview.suppressedWeek)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            }
            if let delay = overview.delay {
                Text(M.museDelay(delay)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            }
            if overview.channel.gapCount > 0 {
                Text(M.museGaps(overview.channel.gapCount)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SL.groupLabelPadding)
    }

    private func clock(_ iso: String) -> String? {
        DeviceActionTime.parse(iso).map { M.dayAndTime($0, now: Date(), calendar: .current) }
    }

    private func rate(_ item: MuseItem, _ timing: Bool?, _ content: Bool?) {
        busy = true
        runMoreAction(failed: $failed) {
            defer { busy = false }
            try await store.rate(item, timing: timing, content: content, reason: M.confirmMuseRate)
            await store.loadMuse()
        }
    }

    private func setIntake(paused: Bool) {
        pendingPaused = paused
        runMoreAction(failed: $failed) {
            defer { pendingPaused = nil }
            try await store.setMuseIntake(paused: paused, reason: M.confirmMuseIntake)
            await store.loadMuse()
        }
    }

    private func clearAll() {
        busy = true
        notice = nil
        runMoreAction(failed: $failed) {
            defer { busy = false }
            try await store.clearMuse(reason: M.confirmMuseClear)
            await store.loadMuse()
            notice = M.museCleared
        }
    }
}

struct MuseItemCard: View {
    let item: MuseItem
    let busy: Bool
    let rate: (Bool?, Bool?) -> Void
    @State private var timing: Bool?
    @State private var content: Bool?

    init(item: MuseItem, busy: Bool, rate: @escaping (Bool?, Bool?) -> Void) {
        self.item = item
        self.busy = busy
        self.rate = rate
        _timing = State(initialValue: item.timingOk)
        _content = State(initialValue: item.contentOk)
    }

    private var when: String {
        DeviceActionTime.parse(item.occurredAt).map { M.dayAndTime($0, now: Date(), calendar: .current) } ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SL.rowGap) {
            VStack(alignment: .leading, spacing: SL.rowTextGap) {
                Text(M.museKind(item.kind) + " · " + when)
                    .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                if item.withheld {
                    Text(M.museWithheld).hmType(PL.title).foregroundStyle(Color.hmMuted)
                } else {
                    if let title = item.title, !title.isEmpty {
                        Text(title).hmType(PL.title).foregroundStyle(Color.hmText)
                    }
                    Text(item.text.flatMap { $0.isEmpty ? nil : $0 } ?? M.museNoText)
                        .hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                }
            }
            judge(M.museTiming, timing) { choose(timing: $0, content: content) }
            judge(M.museContent, content) { choose(timing: timing, content: $0) }
            if item.isRated {
                Button { rate(nil, nil) } label: {
                    Text(M.museUndo).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .frame(minHeight: DesignTokens.Size.minTapTarget)
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard()
        .onChange(of: item) { _, latest in
            timing = latest.timingOk
            content = latest.contentOk
        }
    }

    private func judge(_ label: String, _ current: Bool?, choose: @escaping (Bool) -> Void) -> some View {
        HStack(spacing: PL.buttonGap) {
            Text(label).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach([true, false], id: \.self) { value in
                Button { choose(value) } label: { Text(value ? M.museRight : M.museWrong) }
                    .buttonStyle(RowPillButtonStyle(filled: current == value))
                    .disabled(busy)
            }
        }
    }

    private func choose(timing nextTiming: Bool?, content nextContent: Bool?) {
        timing = nextTiming
        content = nextContent
        guard nextTiming != nil, nextContent != nil else { return }
        rate(nextTiming, nextContent)
    }
}
