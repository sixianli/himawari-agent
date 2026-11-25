import HimawariCore
import HimawariDesign
import SwiftUI

struct BackgroundWorkCapsule: View {
    let work: BackgroundWork
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: DesignTokens.Avatar.backgroundPillGap) {
                Text(L.format("background.capsule", work.openMatterCount))
                    .foregroundStyle(Color.hmText)
                if work.overBudgetCount > 0 {
                    Text("·")
                        .foregroundStyle(Color.hmMuted)
                    Circle()
                        .fill(Color.hmSun)
                        .frame(width: DesignTokens.Chat.backgroundAlertDot, height: DesignTokens.Chat.backgroundAlertDot)
                    Text(L.format("background.capsule.over", work.overBudgetCount))
                        .foregroundStyle(Color.hmText)
                }
                Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
            }
            .font(.system(size: DesignTokens.Avatar.backgroundPillFontSize))
            .padding(.leading, DesignTokens.Avatar.backgroundPillPaddingLeft)
            .padding(.trailing, DesignTokens.Avatar.backgroundPillPaddingRight)
            .frame(height: DesignTokens.Avatar.backgroundPillHeight)
            .glassEffect(.regular.interactive(), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

enum BackgroundWorkText {
    static func money(_ micros: Int) -> String {
        MicroDollars.dollars(micros).map { L.format("background.dollars", $0) } ?? L.text("background.dollars.tiny")
    }

    static func name(_ subthread: BackgroundWork.Subthread) -> String {
        subthread.title ?? L.text("background.untitled")
    }

    static func detail(_ subthread: BackgroundWork.Subthread) -> String? {
        let step = subthread.step.map { L.format("background.step", $0.current, $0.total) }
        let parts = [subthread.currentDoing, step].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func tag(_ tag: BackgroundWorkTag) -> String {
        switch tag {
        case .working: L.text("background.tag.working")
        case .waitingAnswer: L.text("background.tag.waitingAnswer")
        case .waitingResult: L.text("background.tag.waitingResult")
        case .overBudget: L.text("background.tag.overBudget")
        case .done: L.text("background.tag.done")
        case .stopped: L.text("background.tag.stopped")
        }
    }

    static func exchangeTitle(_ exchange: BackgroundWork.Exchange) -> String {
        switch (exchange.direction, exchange.kind) {
        case (_, .resultBoard): L.text("background.exchange.resultBoard")
        case (.toSubthread, .brief): L.text("background.exchange.brief")
        case (.toSubthread, _): L.text("background.exchange.message")
        case (.toMain, .question): L.text("background.exchange.question")
        case (.toMain, .stuck): L.text("background.exchange.stuck")
        case (.toMain, .result): L.text("background.exchange.result")
        case (.toMain, .budget): L.text("background.exchange.budget")
        case (.toMain, _): L.text("background.exchange.progress")
        }
    }

    static func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour().minute())
    }

    static func dayTime(_ date: Date) -> String {
        date.formatted(.dateTime.month().day().hour().minute())
    }
}

public struct BackgroundWorkSheet: View {
    let store: ChatStore
    let close: () -> Void
    @Environment(\.calendar) private var calendar

    public init(store: ChatStore, close: @escaping () -> Void) {
        self.store = store
        self.close = close
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.Chat.backgroundCardGap) {
                    Text(L.text("background.subtitle"))
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                    ForEach(matters) { matter in
                        MatterCard(matter: matter, store: store)
                    }
                }
                .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
            .scrollIndicators(.hidden)
            .background(Color.hmBackground)
            .navigationTitle(L.text("background.title"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: close) { Icon(.x, size: DesignTokens.IconSize.glassButton) }
                        .accessibilityLabel(Text(L.text("process.sheet.close")))
                }
            }
            .navigationDestination(for: SubthreadRoute.self) { route in
                SubthreadPage(store: store, route: route)
            }
        }
        .task { await store.refreshBackgroundWork() }
    }

    private var matters: [BackgroundWork.Matter] {
        store.backgroundWork?.visibleMatters(now: Date(), calendar: calendar) ?? []
    }
}

public struct SubthreadRoute: Hashable, Sendable {
    let matter: String
    let subthreadId: String

    public init(matter: String, subthreadId: String) {
        self.matter = matter
        self.subthreadId = subthreadId
    }
}

private struct MatterCard: View {
    let matter: BackgroundWork.Matter
    let store: ChatStore

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(matter.matter)
                    .hmType(DesignTokens.TypeScale.rowAction)
                    .foregroundStyle(matter.isOpen ? Color.hmText : Color.hmMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(L.format("background.spent", BackgroundWorkText.money(matter.spentMicros)))
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                    .monospacedDigit()
            }
            .padding(.vertical, DesignTokens.Chat.backgroundCardHeaderPaddingY)
            .overlay(alignment: .bottom) { RowSeparator() }
            ForEach(Array(matter.subthreads.enumerated()), id: \.element.id) { index, subthread in
                NavigationLink(value: SubthreadRoute(matter: matter.matter, subthreadId: subthread.subthreadId)) {
                    SubthreadRow(subthread: subthread, icon: icon(for: subthread))
                }
                .buttonStyle(.plain)
                .overlay(alignment: .bottom) {
                    if index < matter.subthreads.count - 1 { RowSeparator() }
                }
                .task(id: subthread.runsNewestFirst.first?.runId) {
                    guard let run = subthread.runsNewestFirst.first else { return }
                    await store.loadExecution(run.runId, in: subthread.subthreadId)
                }
            }
        }
        .padding(.horizontal, DesignTokens.Size.cardPaddingX)
        .padding(.bottom, DesignTokens.Chat.backgroundCardPaddingY)
        .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
        .hmShadow(DesignTokens.Shadows.lift)
    }

    private func icon(for subthread: BackgroundWork.Subthread) -> IconName {
        guard let run = subthread.runsNewestFirst.first,
              let step = ProcessLine.steps(from: store.executions[run.runId] ?? []).last
        else { return .puzzle }
        return ProcessRowView.icon(step.icon)
    }
}

private struct SubthreadRow: View {
    let subthread: BackgroundWork.Subthread
    let icon: IconName

    var body: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            Icon(icon, size: DesignTokens.IconSize.listRow)
                .foregroundStyle(Color.hmText)
            VStack(alignment: .leading, spacing: DesignTokens.Chat.backgroundRowLineGap) {
                Text(BackgroundWorkText.name(subthread))
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                if let detail = BackgroundWorkText.detail(subthread) {
                    Text(detail)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let tag = subthread.tag {
                BackgroundTag(tag: tag)
            }
            Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                .foregroundStyle(Color.hmMuted)
        }
        .padding(.vertical, DesignTokens.Chat.backgroundRowPaddingY)
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .contentShape(Rectangle())
    }
}

private struct BackgroundTag: View {
    let tag: BackgroundWorkTag

    var body: some View {
        Text(BackgroundWorkText.tag(tag))
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(tint)
            .padding(.horizontal, DesignTokens.Chat.backgroundTagPaddingX)
            .padding(.vertical, DesignTokens.Chat.backgroundTagPaddingY)
            .background(Color.hmFill, in: Capsule())
    }

    private var tint: Color {
        switch tag {
        case .overBudget: .hmSun
        case .done, .stopped: .hmMuted
        case .working, .waitingAnswer, .waitingResult: .hmText
        }
    }
}

public struct SubthreadPage: View {
    let store: ChatStore
    let route: SubthreadRoute
    @State private var openedRuns: Set<String> = []
    @State private var exchangesOpen: Bool
    @State private var openedExchange: Int?

    public init(store: ChatStore, route: SubthreadRoute, exchangesOpen: Bool = false) {
        self.store = store
        self.route = route
        _exchangesOpen = State(initialValue: exchangesOpen)
    }

    public var body: some View {
        ScrollView {
            if let subthread {
                VStack(alignment: .leading, spacing: DesignTokens.Chat.backgroundPageGap) {
                    if !subthread.tasks.isEmpty { plan(subthread) }
                    if let progress = subthread.progress, !progress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        latest(progress, at: subthread.progressAt)
                    }
                    if !subthread.runs.isEmpty { process(subthread) }
                    if !subthread.exchanges.isEmpty { exchanges(subthread) }
                    Text(L.text("background.readOnly"))
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
        }
        .scrollIndicators(.hidden)
        .background(Color.hmBackground)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let subthread {
                    VStack(spacing: 0) {
                        Text(BackgroundWorkText.name(subthread))
                            .hmType(DesignTokens.TypeScale.navTitle)
                            .foregroundStyle(Color.hmText)
                        header(subthread)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
            }
        }
    }

    private var subthread: BackgroundWork.Subthread? {
        store.backgroundWork?.matters
            .first { $0.matter == route.matter }?
            .subthreads.first { $0.subthreadId == route.subthreadId }
    }

    private func header(_ subthread: BackgroundWork.Subthread) -> some View {
        HStack(spacing: 0) {
            Text(route.matter + " · ")
                .foregroundStyle(Color.hmMuted)
            Text(L.format("background.budgetLine", BackgroundWorkText.money(subthread.spentMicros), BackgroundWorkText.money(subthread.budgetMicros)))
                .foregroundStyle(subthread.nearBudget ? Color.hmSun : Color.hmMuted)
                .monospacedDigit()
        }
        .hmType(DesignTokens.TypeScale.caption)
        .lineLimit(1)
    }

    private func section<Content: View>(_ title: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.Chat.backgroundSectionGap) {
            if let title {
                Text(title)
                    .hmType(DesignTokens.TypeScale.groupLabel)
                    .foregroundStyle(Color.hmMuted)
            }
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.horizontal, DesignTokens.Size.cardPaddingX)
                .padding(.vertical, DesignTokens.Chat.backgroundCardPaddingY)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                .hmShadow(DesignTokens.Shadows.lift)
        }
    }

    private func plan(_ subthread: BackgroundWork.Subthread) -> some View {
        section(L.text("background.plan")) {
            ForEach(Array(subthread.tasks.enumerated()), id: \.element.id) { index, task in
                HStack(spacing: DesignTokens.Size.rowGap) {
                    taskMark(task.status)
                        .frame(width: DesignTokens.IconSize.processRow, height: DesignTokens.IconSize.processRow)
                    Text(taskText(task))
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(task.status == .completed ? Color.hmMuted : Color.hmText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, DesignTokens.Chat.backgroundStepPaddingY)
                .overlay(alignment: .bottom) {
                    if index < subthread.tasks.count - 1 { RowSeparator() }
                }
            }
        }
    }

    @ViewBuilder
    private func taskMark(_ status: BackgroundWork.TaskItem.Status) -> some View {
        switch status {
        case .completed:
            Icon(.check, size: DesignTokens.IconSize.processRow).foregroundStyle(Color.hmMuted)
        case .inProgress:
            ProgressView().controlSize(.small)
        case .pending:
            Circle().strokeBorder(Color.hmMuted, lineWidth: DesignTokens.IconSize.stroke)
                .padding(DesignTokens.Chat.backgroundTagPaddingY)
        }
    }

    private func taskText(_ task: BackgroundWork.TaskItem) -> String {
        let subject = task.subject ?? ""
        guard task.status == .inProgress else { return subject }
        return task.activeForm.flatMap { $0.isEmpty ? nil : $0 } ?? subject
    }

    private func latest(_ progress: String, at: Date?) -> some View {
        section(L.text("background.latest")) {
            VStack(alignment: .leading, spacing: DesignTokens.Chat.backgroundRowLineGap) {
                Text(progress)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .textSelection(.enabled)
                if let at {
                    Text(BackgroundWorkText.dayTime(at))
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                }
            }
            .padding(.vertical, DesignTokens.Chat.backgroundStepPaddingY)
        }
    }

    private func process(_ subthread: BackgroundWork.Subthread) -> some View {
        let runs = subthread.runsNewestFirst
        return section(L.text("background.process")) {
            ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
                if index == 0 || openedRuns.contains(run.runId) {
                    if index > 0 { earlierRow(run, open: true) }
                    runSteps(run)
                } else {
                    earlierRow(run, open: false)
                }
                if index < runs.count - 1 { RowSeparator() }
            }
        }
    }

    private func earlierRow(_ run: BackgroundWork.Run, open: Bool) -> some View {
        Button {
            if open { openedRuns.remove(run.runId) } else { openedRuns.insert(run.runId) }
        } label: {
            HStack {
                Text(earlierText(run))
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Icon(open ? .chevronDown : .chevronRight, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
            }
            .padding(.vertical, DesignTokens.Chat.backgroundStepPaddingY)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func earlierText(_ run: BackgroundWork.Run) -> String {
        let when = BackgroundWorkText.dayTime(run.startedAt)
        guard let records = store.executions[run.runId] else { return L.format("background.earlier", when) }
        return L.format("background.earlierSteps", when, ProcessLine.steps(from: records).count)
    }

    private func runSteps(_ run: BackgroundWork.Run) -> some View {
        let steps = ProcessLine.steps(from: store.executions[run.runId] ?? [])
        return VStack(spacing: 0) {
            ForEach(steps) { step in
                HStack(spacing: DesignTokens.Size.rowGap) {
                    Icon(stepIcon(step), size: DesignTokens.IconSize.processRow)
                        .foregroundStyle(Color.hmText)
                    Text(step.title)
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(BackgroundWorkText.time(step.startedAt))
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .monospacedDigit()
                }
                .padding(.vertical, DesignTokens.Chat.backgroundStepPaddingY)
            }
        }
        .task(id: run.updatedAt) { await store.loadExecution(run.runId, in: route.subthreadId) }
    }

    private func stepIcon(_ step: ProcessStep) -> IconName {
        switch step.phase {
        case .failed, .unavailable: .alertCircle
        case .unrecognized: .puzzle
        default: ProcessRowView.icon(step.icon)
        }
    }

    private func exchanges(_ subthread: BackgroundWork.Subthread) -> some View {
        let items = subthread.exchangesInOrder
        return section(nil) {
            Button {
                exchangesOpen.toggle()
                if !exchangesOpen { openedExchange = nil }
            } label: {
                HStack {
                    Text(L.format("background.exchanges.count", items.count))
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Icon(exchangesOpen ? .chevronDown : .chevronRight, size: DesignTokens.IconSize.chevron)
                        .foregroundStyle(Color.hmMuted)
                }
                .padding(.vertical, DesignTokens.Chat.backgroundStepPaddingY)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if exchangesOpen {
                ForEach(Array(items.enumerated()), id: \.offset) { index, exchange in
                    RowSeparator()
                    Button {
                        openedExchange = openedExchange == index ? nil : index
                    } label: {
                        VStack(alignment: .leading, spacing: DesignTokens.Chat.backgroundRowLineGap) {
                            Text(BackgroundWorkText.exchangeTitle(exchange))
                                .hmType(DesignTokens.TypeScale.caption)
                                .foregroundStyle(Color.hmMuted)
                            Text(exchange.text)
                                .hmType(DesignTokens.TypeScale.body)
                                .foregroundStyle(Color.hmText)
                                .lineLimit(openedExchange == index ? nil : 2)
                                .multilineTextAlignment(.leading)
                            Text(BackgroundWorkText.dayTime(exchange.at))
                                .hmType(DesignTokens.TypeScale.caption)
                                .foregroundStyle(Color.hmMuted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, DesignTokens.Chat.backgroundStepPaddingY)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
