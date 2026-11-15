import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariListen
import HimawariManage
import SwiftUI

struct TodayPage: View {
    let feed: HomeFeedModel
    let actions: DeviceActionsModel?
    var listening: ListeningController?
    var openListening: () -> Void = {}
    let openSettings: () -> Void
    let openSearch: (() -> Void)?
    let openThread: (String) -> Void
    @State private var opened: PendingApproval?
    @State private var scrolled = false
    @Environment(\.listClock) private var listClock
    @Environment(\.stillFrames) private var stillFrames

    var body: some View {
        GeometryReader { proxy in
            let origin = max(0, proxy.safeAreaInsets.top - DesignTokens.Home.statusBar)
            ZStack(alignment: .topTrailing) {
                ScrollView {
                    ZStack(alignment: .topLeading) {
                        HomeGlow()
                        CornerSunflower()
                            .offset(y: origin)
                        Wordmark()
                            .offset(x: DesignTokens.Home.wordmarkLeading, y: origin + DesignTokens.Size.navTop)
                        content
                            .padding(.top, origin + DesignTokens.Home.paddingTop)
                            .padding(.horizontal, DesignTokens.Home.paddingX)
                            .padding(.bottom, DesignTokens.Home.paddingBottom)
                    }
                }
                .scrollIndicators(.hidden)
                .ignoresSafeArea(.container, edges: .top)
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    geometry.contentOffset.y + geometry.contentInsets.top > 0
                } action: { _, isScrolled in
                    scrolled = isScrolled
                }
                .refreshable {
                    await feed.refresh()
                    await actions?.refresh()
                }
                if scrolled {
                    EdgeFade(.top, height: origin + DesignTokens.Size.fadeTop, solid: (origin + DesignTokens.Size.fadeTopSolid) / (origin + DesignTokens.Size.fadeTop))
                        .ignoresSafeArea(.container, edges: .top)
                        .frame(maxHeight: .infinity, alignment: .top)
                }
                topButtons
                    .padding(.trailing, DesignTokens.Home.paddingX)
                    .padding(.top, origin + DesignTokens.Size.navTop - proxy.safeAreaInsets.top)
                if let actions, let opened {
                    ApprovalDetailView(model: actions, approval: opened, openThread: openThread) {
                        withAnimation(.snappy) { self.opened = nil }
                    }
                    .transition(.move(edge: .trailing))
                    .zIndex(1)
                }
            }
            .overlay(alignment: .bottom) { toast }
        }
        .himawariScreenBackground()
        .task { await feed.refresh() }
    }

    private var topButtons: some View {
        HStack(spacing: DesignTokens.Home.buttonGap) {
            if let openSearch {
                GlassCircleButton(Text(L.text("today.search")), action: openSearch) {
                    Icon(.search, size: DesignTokens.IconSize.glassButton)
                }
            }
            GlassCircleButton(Text(L.text("settings")), action: openSettings) {
                Icon(.user, size: DesignTokens.IconSize.glassButton)
            }
        }
    }

    private var hasDeviceActions: Bool {
        guard let actions else { return false }
        return !actions.pending.isEmpty || !actions.recent.isEmpty
    }

    @ViewBuilder
    private var content: some View {
        if let layout = feed.layout {
            VStack(alignment: .leading, spacing: DesignTokens.Home.gap) {
                if let lead = layout.lead {
                    LeadItemView(
                        item: lead,
                        approval: feed.approval(for: lead, in: actions),
                        detail: feed.approval(for: lead, in: actions)?.display?.bodyPreview,
                        busy: feed.busy.contains(lead.key),
                        canAct: feed.canAct(lead, approvals: actions),
                        open: { open(lead) },
                        decide: { action in decide(lead, action) }
                    )
                }
                if !layout.rows.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(layout.rows.enumerated()), id: \.element.key) { index, item in
                            row(item)
                            if index < layout.rows.count - 1 { RowSeparator() }
                        }
                    }
                    .himawariCard(padding: EdgeInsets(top: 0, leading: DesignTokens.Home.rowsLeading, bottom: 0, trailing: DesignTokens.Home.rowsTrailing))
                }
                if !layout.upcoming.isEmpty {
                    UpcomingCard(upcoming: layout.upcoming, now: listClock ?? Date())
                }
                if let actions, hasDeviceActions, feed.snapshot?.incompleteSources.isEmpty == false {
                    TodayDeviceActionsCard(model: actions) { approval in
                        withAnimation(.snappy) { opened = approval }
                    }
                }
                if let listening {
                    ListenTodayCard(controller: listening, open: openListening)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(.snappy, value: feed.settled)
        } else if listening != nil || hasDeviceActions {
            VStack(spacing: DesignTokens.Home.gap) {
                if let listening {
                    ListenTodayCard(controller: listening, open: openListening)
                }
                if let actions, hasDeviceActions {
                    TodayDeviceActionsCard(model: actions) { approval in
                        withAnimation(.snappy) { opened = approval }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ item: HomeFeedItem) -> some View {
        let approval = feed.approval(for: item, in: actions)
        if item.awaitsOwner, let choice = item.choice, feed.canAct(item, approvals: actions) {
            DecisionRow(
                title: TodayWords.title(item, approval: approval),
                detail: approval?.display?.bodyPreview,
                status: TodayWords.status(item),
                decline: choice.decline?.buttonLabel,
                confirm: choice.confirm.buttonLabel,
                openLabel: L.text("today.open"),
                busy: feed.busy.contains(item.key),
                icon: TodayWords.icon(item),
                statusTint: TodayWords.tint(item),
                open: { open(item) },
                respond: { confirmed in
                    guard let action = confirmed ? choice.confirm : choice.decline else { return }
                    decide(item, action)
                }
            )
        } else {
            HomeLinkRow(item: item, title: TodayWords.title(item, approval: approval), opens: opens(item)) { open(item) }
        }
    }

    private func opens(_ item: HomeFeedItem) -> Bool {
        feed.approval(for: item, in: actions) != nil || item.threadId != nil
    }

    private func open(_ item: HomeFeedItem) {
        if let approval = feed.approval(for: item, in: actions) {
            withAnimation(.snappy) { opened = approval }
        } else if let threadId = item.threadId {
            openThread(threadId)
        }
    }

    private func decide(_ item: HomeFeedItem, _ action: HomeFeedAction) {
        if action.ownerPresence {
            open(item)
            return
        }
        Task { await feed.decide(item, action: action, approvals: actions) }
    }

    @ViewBuilder
    private var toast: some View {
        if let toast = feed.toast {
            HomeToastView(toast: toast) {
                Task { await feed.undo(toast) }
            }
            .padding(.horizontal, DesignTokens.Home.paddingX)
            .padding(.bottom, DesignTokens.Size.rowGap)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: toast.id) {
                guard !stillFrames else { return }
                try? await Task.sleep(for: .seconds(HomeToastView.seconds))
                withAnimation(.snappy) { feed.dismiss(toast) }
            }
        }
    }
}

enum TodayWords {
    static func title(_ item: HomeFeedItem, approval: PendingApproval?) -> String {
        if let approval { return approval.title }
        if let sentence = item.sentence, !sentence.isEmpty { return sentence }
        switch item.itemKind {
        case .approval: return L.text("today.fallback.approval")
        case .running: return L.text("today.fallback.running")
        case .problem: return L.text("today.fallback.problem")
        case .done: return L.text("today.fallback.done")
        case .headsUp, .memoryConfirm, .other: return L.text("today.fallback.other")
        }
    }

    static func status(_ item: HomeFeedItem) -> String {
        if item.itemKind == .approval { return L.text("today.approval.waiting") }
        return item.subtitle ?? ""
    }

    static func tint(_ item: HomeFeedItem) -> Color {
        switch item.itemKind {
        case .approval: .hmSun
        case .problem: .hmDanger
        default: .hmMuted
        }
    }

    static func icon(_ item: HomeFeedItem) -> IconName {
        switch item.itemKind {
        case .approval: return .handStop
        case .memoryConfirm: return .ear
        case .done: return .check
        case .problem: return .alertCircle
        case .running, .headsUp, .other: break
        }
        switch item.source.type {
        case "mail": return .mail
        case "rule": return .listCheck
        case "connection": return .cloud
        case "memory": return .bell
        default: return .message
        }
    }
}

struct LeadItemView: View {
    let item: HomeFeedItem
    let approval: PendingApproval?
    let detail: String?
    let busy: Bool
    let canAct: Bool
    let open: () -> Void
    let decide: (HomeFeedAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Home.leadGap) {
            HStack(alignment: .top, spacing: DesignTokens.Home.leadIndent - DesignTokens.IconSize.todayTop) {
                Icon(TodayWords.icon(item), size: DesignTokens.IconSize.todayTop)
                    .foregroundStyle(item.itemKind == .approval ? Color.hmSun : Color.hmText)
                    .frame(height: DesignTokens.Home.leadIconBox)
                VStack(alignment: .leading, spacing: 0) {
                    Text(TodayWords.title(item, approval: approval))
                        .hmType(DesignTokens.TypeScale.todayTop)
                        .foregroundStyle(Color.hmText)
                        .fixedSize(horizontal: false, vertical: true)
                    let caption = TodayWords.status(item)
                    if !caption.isEmpty {
                        Text(caption)
                            .hmType(DesignTokens.TypeScale.caption)
                            .foregroundStyle(item.itemKind == .approval ? Color.hmSun : Color.hmMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture(perform: open)
            }
            if let detail, !detail.isEmpty {
                Text(detail)
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmText)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, DesignTokens.Size.pillSmall / 2)
                    .padding(.vertical, DesignTokens.Size.pillSmall / 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.offlineBanner, style: .continuous))
                    .padding(.leading, DesignTokens.Home.leadIndent)
            }
            if canAct, let choice = item.choice {
                HStack(spacing: DesignTokens.Size.composerGap) {
                    if let decline = choice.decline {
                        Button(decline.buttonLabel) { decide(decline) }
                            .buttonStyle(CapsuleButtonStyle(.secondary))
                    }
                    Button(choice.confirm.buttonLabel) { decide(choice.confirm) }
                        .buttonStyle(CapsuleButtonStyle(.primary))
                }
                .padding(.leading, DesignTokens.Home.leadIndent)
                .disabled(busy)
                .opacity(busy ? 0.5 : 1)
            }
        }
        .padding(.horizontal, DesignTokens.Home.paddingX / 4)
        .accessibilityElement(children: .contain)
    }
}

struct HomeLinkRow: View {
    let item: HomeFeedItem
    let title: String
    let opens: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: DesignTokens.Home.linkRowGap) {
                icon
                    .frame(width: DesignTokens.IconSize.todayRow, height: DesignTokens.TypeScale.body.lineHeight)
                VStack(alignment: .leading, spacing: DesignTokens.Home.linkRowTextGap) {
                    Text(title)
                        .hmType(item.itemKind == .running ? DesignTokens.TypeScale.body : DesignTokens.TypeScale.navTitle)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.leading)
                    Text(meta)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if opens {
                    Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                        .foregroundStyle(Color.hmMuted)
                        .frame(height: DesignTokens.TypeScale.body.lineHeight)
                }
            }
            .padding(.vertical, DesignTokens.Home.linkRowPaddingY)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!opens)
    }

    private var meta: String {
        if let subtitle = item.subtitle { return subtitle }
        guard let at = HomeTimestamp.parse(item.source.at) else { return "" }
        return at.formatted(date: .omitted, time: .shortened)
    }

    @ViewBuilder
    private var icon: some View {
        switch item.itemKind {
        case .running:
            ProgressView().controlSize(.small).tint(Color.hmMuted)
        default:
            Icon(TodayWords.icon(item), size: DesignTokens.IconSize.todayRow)
                .foregroundStyle(item.itemKind == .problem ? Color.hmDanger : Color.hmMuted)
        }
    }
}

struct UpcomingCard: View {
    let upcoming: [HomeUpcoming]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Home.upcomingGap) {
            Text(L.text("today.upcoming"))
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmMuted)
                .padding(.horizontal, DesignTokens.Home.paddingX / 4)
            VStack(spacing: 0) {
                ForEach(Array(upcoming.enumerated()), id: \.element.id) { index, entry in
                    HStack(spacing: DesignTokens.Size.rowGap) {
                        Text(UpcomingWords.when(entry, now: now))
                            .hmType(DesignTokens.TypeScale.upcomingTime)
                            .foregroundStyle(Color.hmSun)
                            .frame(width: DesignTokens.Home.upcomingTime, alignment: .leading)
                        Text(entry.text)
                            .hmType(DesignTokens.TypeScale.body)
                            .foregroundStyle(Color.hmText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: DesignTokens.Size.rowMinHeight)
                    .accessibilityElement(children: .combine)
                    if index < upcoming.count - 1 { RowSeparator() }
                }
            }
            .himawariCard(padding: EdgeInsets(top: 0, leading: DesignTokens.Home.upcomingInsetX, bottom: 0, trailing: DesignTokens.Home.upcomingInsetX))
        }
    }
}

enum UpcomingWords {
    static func clock(_ due: Date, calendar: Calendar, locale: Locale = .autoupdatingCurrent) -> String {
        let template = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: locale) ?? ""
        if template.contains("a") { return due.formatted(.dateTime.hour().minute()) }
        let parts = calendar.dateComponents([.hour, .minute], from: due)
        return String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    static func when(_ entry: HomeUpcoming, now: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        guard let due = entry.due else { return "" }
        let time = clock(due, calendar: calendar)
        switch UpcomingDay.of(due, now: now, calendar: calendar) {
        case .today: return L.format("today.upcoming.today", time)
        case .tonight: return L.format("today.upcoming.tonight", time)
        case .tomorrow: return L.format("today.upcoming.tomorrow", time)
        case .weekday:
            return L.format("today.upcoming.on", due.formatted(.dateTime.weekday(.abbreviated)), time)
        case .date:
            return L.format("today.upcoming.on", due.formatted(.dateTime.month(.defaultDigits).day()), time)
        }
    }
}

struct HomeToastView: View {
    static let seconds: Double = 6

    let toast: HomeToast
    let undo: () -> Void

    var body: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            Text(toast.message)
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmText)
                .frame(maxWidth: .infinity, alignment: .leading)
            if toast.undo != nil {
                Button(L.text("today.undo"), action: undo)
                    .hmType(DesignTokens.TypeScale.rowAction)
                    .foregroundStyle(Color.hmSun)
                    .frame(minHeight: DesignTokens.Size.minTapTarget)
            }
        }
        .padding(.horizontal, DesignTokens.Size.cardPaddingX)
        .frame(minHeight: DesignTokens.Size.pill)
        .background(Color.hmSurface, in: Capsule())
        .hmShadow(DesignTokens.Shadows.liftBig)
        .accessibilityElement(children: .contain)
    }
}
