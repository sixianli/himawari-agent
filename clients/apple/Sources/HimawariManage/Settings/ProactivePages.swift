import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

enum ProactiveErrors {
    static func declined(_ error: Error) -> Bool {
        !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError || error is URLError || error is HTTPExchangeError)
    }
}

struct ProactivePage: View {
    let store: SettingsStore
    let open: (SettingsRootView.Page) -> Void
    let back: () -> Void
    @State private var failed = false
    @State private var busy: String?

    private var session: ProactiveSession { store.proactive }
    private static let insightLimit = 20

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.proactiveTitle, leading: .back, action: back)
            if let overview = session.overview {
                content(overview)
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task {
            await session.reloadOverview()
            await session.reloadSources()
            await session.reloadWeekly()
        }
        .refreshable { await session.reloadOverview() }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    @ViewBuilder
    private func content(_ overview: ProactiveOverview) -> some View {
        SettingsGroup(label: nil) {
            SettingsRow(
                icon: nil,
                title: M.proactiveTitle,
                detail: overview.enabled ? nil : M.proactivePaused,
                switchState: Binding(get: { overview.enabled }, set: { toggle(overview, $0) }),
                last: false
            )
            SettingsRow(
                icon: .mail,
                title: ProactiveSource.displayName(of: overview.source),
                detail: overview.connection.status == "needs_reconnect" ? nil : M.sourceConnection(overview),
                warning: overview.connection.status == "needs_reconnect" ? M.sourceConnection(overview) : nil,
                last: false
            )
            SettingsRow(
                icon: .clock,
                title: M.proactiveQuiet,
                detail: overview.quietHours.isEmpty ? nil : overview.quietHours.map { M.quietSummary($0) }.joined(separator: "\n"),
                note: M.proactiveQuietFootnote,
                value: overview.quietHours.isEmpty ? M.proactiveQuietNone : nil,
                last: true
            )
        }
        .disabled(busy == "enabled")
        if overview.dailyLimitReached {
            Text(M.proactiveDailyLimit).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                .padding(.horizontal, SL.groupLabelPadding)
        }
        ForEach(overview.backoff) { entry in
            VStack(alignment: .leading, spacing: SL.rowGap) {
                Text(M.proactiveBackoff(entry)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                Button { restore(entry) } label: { Text(M.proactiveRestore) }
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: PL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                    .disabled(busy == entry.id)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .himawariCard()
        }
        links(overview)
        if overview.hasMetrics { metrics(overview.metrics) }
        let pending = overview.openInsights(limit: Self.insightLimit)
        if !pending.isEmpty {
            Text(M.proactiveToHandle).hmType(DesignTokens.TypeScale.groupLabel).foregroundStyle(Color.hmMuted)
                .padding(.horizontal, SL.groupLabelPadding)
            VStack(spacing: PL.gap) {
                ForEach(pending) { insight in
                    ProactiveInsightCard(insight: insight, busy: busy == insight.id) { action, rating in
                        respond(insight, action, rating)
                    }
                }
            }
        }
    }

    private func links(_ overview: ProactiveOverview) -> some View {
        SettingsGroup(label: nil) {
            Button { open(.proactiveLog) } label: {
                SettingsRow(icon: .history, title: M.proactiveLog, chevron: true, last: !hasSources && !hasReport)
            }
            .buttonStyle(.plain)
            if hasSources {
                Button { open(.proactiveSources) } label: {
                    SettingsRow(icon: .listCheck, title: M.proactiveSources, chevron: true, last: !hasReport)
                }
                .buttonStyle(.plain)
            }
            if hasReport {
                Button { open(.proactiveReport) } label: {
                    SettingsRow(icon: .clipboardList, title: M.proactiveReport, chevron: true, last: true)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var hasSources: Bool { !(session.sources ?? []).isEmpty }
    private var hasReport: Bool { session.weekly != nil }

    private func metrics(_ metrics: ProactiveMetrics) -> some View {
        VStack(alignment: .leading, spacing: SL.groupGap) {
            SettingsGroup(label: M.proactiveStats) {
                SettingsRow(icon: nil, title: M.metricSpoke, value: "\(metrics.spoke)")
                SettingsRow(icon: nil, title: M.metricHits, value: "\(metrics.hits)")
                SettingsRow(icon: nil, title: M.metricMisfires, value: "\(metrics.misfires)")
                SettingsRow(
                    icon: nil,
                    title: M.metricMissed,
                    note: M.metricReviewed(metrics.reviewed),
                    value: "\(metrics.missed)",
                    last: true
                )
            }
            Text(M.metricsDefinition).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                .padding(.horizontal, SL.groupLabelPadding)
        }
    }

    private func run(_ key: String, _ work: @escaping () async throws -> Void) {
        busy = key
        Task {
            defer { busy = nil }
            do {
                try await work()
            } catch where ProactiveErrors.declined(error) {
            } catch {
                failed = true
            }
        }
    }

    private func toggle(_ overview: ProactiveOverview, _ on: Bool) {
        run("enabled") {
            try await session.setEnabled(on, reason: on ? M.confirmProactiveOn : M.confirmProactiveOff)
        }
    }

    private func restore(_ entry: ProactiveBackoff) {
        run(entry.id) { try await session.restore(entry, reason: M.confirmProactiveRestore) }
    }

    private func respond(_ insight: ProactiveInsight, _ action: ProactiveInsightAction, _ rating: ProactiveRating?) {
        run(insight.id) {
            try await session.respond(insight, action, rating: rating, reason: action == .rate ? M.confirmProactiveRate : M.confirmProactiveRespond)
        }
    }
}

struct RatingChoices: View {
    let choices: [ProactiveRating]
    let current: ProactiveRating?
    let label: (ProactiveRating) -> String
    let pick: (ProactiveRating) -> Void

    var body: some View {
        HStack(spacing: PL.buttonGap) {
            ForEach(choices, id: \.self) { rating in
                Button { pick(rating) } label: { Text(label(rating)) }
                    .buttonStyle(CapsuleButtonStyle(current == rating ? .primary : .secondary, height: PL.buttonHeight, fontSize: DesignTokens.TypeScale.caption.size))
            }
        }
    }
}

struct ProactiveInsightCard: View {
    let insight: ProactiveInsight
    let busy: Bool
    let respond: (ProactiveInsightAction, ProactiveRating?) -> Void

    private var meta: String? {
        let due = ProactiveTime.parse(insight.dueAt).map { M.proactiveDue($0) }
        let priority = insight.priority.flatMap { M.proactivePriority($0) }
        let parts = [due, priority].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SL.rowGap) {
            VStack(alignment: .leading, spacing: SL.rowTextGap) {
                Text(insight.summary).hmType(PL.title).foregroundStyle(Color.hmText)
                if !insight.reason.isEmpty {
                    Text(insight.reason).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                if let meta {
                    Text(meta).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
            }
            HStack(spacing: PL.buttonGap) {
                Button { respond(.mute, nil) } label: { Text(M.proactiveMute) }
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: PL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                Button { respond(.done, nil) } label: { Text(M.proactiveDone) }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: PL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
            }
            RatingChoices(choices: [.useful, .unneeded], current: insight.ownerRating, label: M.proactiveRating) { rating in
                if rating != insight.ownerRating { respond(.rate, rating) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard()
        .disabled(busy)
    }
}

struct ProactiveLogPage: View {
    let store: SettingsStore
    let back: () -> Void
    @State private var failed = false
    @State private var busy: String?

    private static let limit = 30

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.proactiveLog, leading: .back, action: back)
            if let overview = store.proactive.overview {
                let decisions = overview.recentDecisions(limit: Self.limit)
                if decisions.isEmpty {
                    EmptyStateView(Text(M.proactiveLogEmpty)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    VStack(spacing: PL.gap) {
                        ForEach(decisions) { decision in
                            ProactiveDecisionCard(decision: decision, busy: busy == decision.id) { rating in
                                rate(decision, rating)
                            }
                        }
                    }
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.proactive.reloadOverview() }
        .refreshable { await store.proactive.reloadOverview() }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func rate(_ decision: ProactiveDecision, _ rating: ProactiveRating?) {
        busy = decision.id
        Task {
            defer { busy = nil }
            do {
                try await store.proactive.rate(decision, rating, reason: M.confirmProactiveRate)
            } catch where ProactiveErrors.declined(error) {
            } catch {
                failed = true
            }
        }
    }
}

struct ProactiveDecisionCard: View {
    let decision: ProactiveDecision
    let busy: Bool
    let rate: (ProactiveRating?) -> Void

    private var when: String {
        ProactiveTime.parse(decision.checkedAt).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SL.rowGap) {
            VStack(alignment: .leading, spacing: SL.rowTextGap) {
                HStack {
                    Text(M.proactiveVerdict(decision.verdict)).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    Spacer()
                    Text(when).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                Text(M.proactiveLine(decision.line)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                if decision.showsJudgedBreakdown {
                    Text(M.proactiveJudged(decision)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                if decision.opened {
                    Text(M.proactiveOpened).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
            }
            if !decision.rateChoices.isEmpty {
                RatingChoices(choices: decision.rateChoices, current: decision.ownerRating, label: M.proactiveRating) { rating in
                    rate(rating == decision.ownerRating ? nil : rating)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard()
        .disabled(busy)
    }
}

struct ProactiveSourcesPage: View {
    let store: SettingsStore
    let open: (String) -> Void
    let back: () -> Void

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.proactiveSources, leading: .back, action: back)
            if let sources = store.proactive.sources {
                if sources.isEmpty {
                    EmptyStateView(Text(M.sourcesNone)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    SettingsGroup(label: nil) {
                        ForEach(Array(sources.enumerated()), id: \.element.id) { index, source in
                            Button { open(source.id) } label: {
                                SettingsRow(
                                    icon: nil,
                                    title: source.displayName,
                                    value: source.enabled ? M.on : M.off,
                                    chevron: true,
                                    last: index == sources.count - 1
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.proactive.reloadSources() }
        .refreshable { await store.proactive.reloadSources() }
    }
}

struct ProactiveSourcePage: View {
    let store: SettingsStore
    let sourceId: String
    let back: () -> Void
    @State private var enabledDraft: Bool?
    @State private var perDayDraft: Int?
    @State private var perCheckDraft: Int?
    @State private var failed = false
    @State private var busy = false

    private var source: ProactiveSource? { store.proactive.sources?.first { $0.id == sourceId } }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            if let source {
                let enabled = enabledDraft ?? source.enabled
                let perDay = perDayDraft ?? source.perDay.limit
                let perCheck = perCheckDraft ?? source.perCheck.limit
                SheetHeader(title: source.displayName, leading: .back, action: back)
                SettingsGroup(label: nil) {
                    SettingsRow(
                        icon: nil,
                        title: M.sourceSwitch,
                        switchState: Binding(get: { enabled }, set: { enabledDraft = $0 }),
                        last: true
                    )
                }
                limit(
                    title: M.sourceDaily(perDay),
                    note: M.sourceUsedToday(source.perDay.used ?? 0, resets: ProactiveTime.parse(source.perDay.resetsAt)),
                    defaultValue: source.perDay.defaultLimit,
                    spec: source.perDay,
                    value: perDay
                ) { perDayDraft = $0 }
                limit(
                    title: M.sourcePerCheck(perCheck),
                    note: M.sourcePerCheckNote,
                    defaultValue: source.perCheck.defaultLimit,
                    spec: source.perCheck,
                    value: perCheck
                ) { perCheckDraft = $0 }
                if failed {
                    Text(M.tuningSaveFailed).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmDanger)
                }
                VStack(spacing: ManageLayout.ExportSheet.buttonGap) {
                    Button { save(source, enabled: enabled, perDay: perDay, perCheck: perCheck) } label: { Text(M.tuningSave) }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(busy || (enabled == source.enabled && perDay == source.perDay.limit && perCheck == source.perCheck.limit))
                    Button { save(source, enabled: enabled, perDay: source.perDay.defaultLimit, perCheck: source.perCheck.defaultLimit) } label: { Text(M.tuningRestore) }
                        .buttonStyle(CapsuleButtonStyle(.secondary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(busy || (perDay == source.perDay.defaultLimit && perCheck == source.perCheck.defaultLimit))
                }
            } else {
                SheetHeader(title: M.proactiveSources, leading: .back, action: back)
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
    }

    private func limit(title: String, note: String, defaultValue: Int, spec: ProactiveDayLimit, value: Int, set: @escaping (Int) -> Void) -> some View {
        VStack(alignment: .leading, spacing: SL.rowGap) {
            HStack {
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    Text(note).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    Text(M.tuningDefault("\(defaultValue)")).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                Spacer()
                Stepper(
                    "",
                    onIncrement: { set(spec.stepUp(from: value)) },
                    onDecrement: { set(spec.stepDown(from: value)) }
                )
                .labelsHidden()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard()
    }

    private func save(_ source: ProactiveSource, enabled: Bool, perDay: Int, perCheck: Int) {
        failed = false
        busy = true
        Task {
            defer { busy = false }
            do {
                try await store.proactive.change(source, enabled: enabled, perDay: perDay, perCheck: perCheck, reason: M.confirmProactiveSource(source.displayName))
                enabledDraft = nil
                perDayDraft = nil
                perCheckDraft = nil
            } catch where ProactiveErrors.declined(error) {
            } catch {
                failed = true
            }
        }
    }
}

struct ProactiveReportPage: View {
    let store: SettingsStore
    let back: () -> Void

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.proactiveReport, leading: .back, action: back)
            if let weekly = store.proactive.weekly {
                if !weekly.hasStarted {
                    Text(M.weeklyNotStarted).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                } else {
                    report(weekly.report)
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.proactive.reloadWeekly() }
        .refreshable { await store.proactive.reloadWeekly() }
    }

    @ViewBuilder
    private func report(_ report: ProactiveWeeklyReport) -> some View {
        Text(M.weeklyPeriod(report.startDay, report.endDay)).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
            .padding(.horizontal, SL.groupLabelPadding)
        if report.ratesWithheld {
            Text(M.weeklyNotFull).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                .padding(.horizontal, SL.groupLabelPadding)
        }
        if report.shownGroups.isEmpty {
            EmptyStateView(Text(M.weeklyEmpty)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else {
            VStack(spacing: PL.gap) {
                ForEach(report.shownGroups) { group in
                    ProactiveGroupCard(group: group, report: report)
                }
            }
            if !report.ratesWithheld {
                Text(M.weeklyDefinition).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    .padding(.horizontal, SL.groupLabelPadding)
            }
        }
    }
}

struct ProactiveGroupCard: View {
    let group: ProactiveWeeklyGroup
    let report: ProactiveWeeklyReport

    var body: some View {
        VStack(alignment: .leading, spacing: SL.rowGap) {
            VStack(alignment: .leading, spacing: SL.rowTextGap) {
                Text(M.weeklyGroup(group.group)).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                Text(M.weeklyCounts(total: group.total, rated: group.rated))
                    .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            }
            if !report.ratesWithheld {
                if group.hasEnoughRated(minimum: report.minimumSamples) {
                    VStack(alignment: .leading, spacing: SL.rowTextGap) {
                        ForEach(group.figures(ratesWithheld: false), id: \.rating) { figure in
                            Text(M.weeklyFigure(M.weeklyRating(group: group.group, figure.rating), figure))
                                .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmText)
                        }
                    }
                } else {
                    Text(M.weeklyFew(rated: group.rated, minimum: report.minimumSamples))
                        .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard()
    }
}
