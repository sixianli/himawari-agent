#if DEBUG
import Foundation
import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariSenses
import HimawariListenUI
import HimawariManage
import HimawariShare
import SwiftUI

enum DemoScene: String, CaseIterable {
    case chat = "04-chat"
    case main = "next-2-main"
    case memory = "05-memory"
    case memoryDetail = "06-memory-detail"
    case memoryEdit = "18-memory-more-1-edit"
    case rules = "18-memory-more-2-rules"
    case ruleDetail = "18-memory-more-3-rule-detail"
    case deviceAbilities = "19-settings-more-1-abilities"
    case her = "next-3-her"
    case herPrivacy = "next-3-her-privacy"
    case herApprovals = "next-3-her-approvals"
    case herDevices = "next-3-her-devices"
    case herNotifications = "next-3-her-notifications"
    case herAllowances = "next-3-her-allowances"
    case herAllowancesEmpty = "next-3-her-allowances-empty"
    case herAllowanceDays = "next-3-her-allowance-days"
    case memoryVersions = "next-4-memory-versions"
    case memoryTrash = "next-4-memory-trash"
    case herAbout = "next-6-her-about"
    case herTimers = "next-9-timers"
    case herTimersEmpty = "next-9-timers-empty"
    case herTimersReminders = "next-9-timers-reminders"
    case herTimerRecurring = "next-9-timer-recurring"
    case herTimerReminder = "next-9-timer-reminder"
    case herTimerPaused = "next-9-timer-paused"
    case herNoTimers = "next-9-her-no-timers"
    case chatEmptyFlower = "next-6-chat-empty"
    case backgroundEntry = "next-8-background"
    case backgroundNone = "next-8-background-none"
    case backgroundSheet = "next-8-background-sheet"
    case backgroundSubthread = "next-8-background-subthread"
    case backgroundExchanges = "next-8-background-exchanges"
    case backgroundQuiet = "next-8-background-quiet"
    case deletePerception = "next-7-delete-perception"
    case deletePerceptionDays = "next-7-delete-perception-days"
    case deletePerceptionEpisode = "next-7-delete-perception-episode"
    case pairing = "11-pairing"
    case pairingScan = "15-pairing-flow-1-scan"
    case pairingConfirmServer = "15-pairing-flow-1b-confirm-server"
    case pairingWaiting = "15-pairing-flow-2-waiting"
    case pairingExpired = "15-pairing-flow-3-expired"
    case pairingUnreachable = "15-pairing-flow-4-unreachable"
    case pairingRemoved = "15-pairing-flow-5-removed"
    case chatEmpty = "16-chat-states-1-empty"
    case chatSending = "16-chat-states-3-sending"
    case chatOffline = "16-chat-states-4-offline"
    case chatAnswering = "16-chat-states-5-answering"
    case chatSteps = "16-chat-states-6-steps"
    case chatFormat = "next-2-chat-format"
    case chatFormatStreaming = "next-2-chat-format-streaming"
    case chatRich = "next-5-chat-rich"
    case chatSelectText = "next-5-chat-select-text"
    case chatCopied = "next-5-chat-copied"
    case chatReplied = "next-5-chat-replied"
    case chatReplying = "next-5-chat-replying"
    case chatOptions = "next-2-chat-options"
    case chatOptionChosen = "next-2-chat-options-chosen"
    case chatAttach = "next-2-chat-attach"
    case chatTalkListening = "next-2-chat-talk-listening"
    case chatTalkHer = "next-2-chat-talk-her"
    case sensesOverview = "19-senses-1-overview"
    case sensesIntro = "19-senses-2-intro"
    case sensesSystemPrompt = "19-senses-3-system-prompt"
    case sensesDetail = "19-senses-4-detail"
    case sensesDenied = "19-senses-5-denied"
    case actionsDetail = "17-today-more-2-detail"
    case actionsDetailFace = "17-today-more-3-detail-face-id"
    case actionsApprovals = "17-today-more-1-approvals"
    case actionsPrimer = "19-settings-more-2-permission-primer"
    case actionsPrimerDenied = "19-settings-more-3-permission-denied"
    case listenIntro = "23-listen-1"
    case listenEnroll = "23-listen-2"
    case listenLive = "23-listen-3"
    case listenInterrupted = "23-listen-3b"
    case listenCalling = "23-listen-4"
    case listenAsking = "23-listen-5"
    case listenStopped = "23-listen-6"
    case handoverTyping = "19-senses-6-share-sheet"
    case handoverAnswered = "19-senses-6b-share-answered"
    case handoverQueued = "19-senses-6c-share-queued"
    case handoverEntryOff = "19-senses-6d-share-entry-off"
    case handoverRemoved = "19-senses-6e-share-removed"
    case handoverUnpaired = "19-senses-6f-share-unpaired"
    case safariGuide = "22-gaps-1-safari-guide"
    case safariOn = "22-gaps-1b-safari-on"
    case shareEntry = "19-senses-share-entry"
    case motionShimmer = "motion-shimmer"
    case motionSheet = "motion-sheet"
    case motionScroll = "motion-scroll-under-glass"

    static let argument = "-HimawariDemoScene"
    static let demoHost = "himawari.example.com"
    static let shownMarker = "himawari-demo-scene-shown"
    static var requested: DemoScene? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: argument), arguments.indices.contains(index + 1) else { return nil }
        return DemoScene(rawValue: arguments[index + 1])
    }
}

struct DemoSceneView: View {
    let scene: DemoScene
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content
            .environment(\.listClock, DemoChatFixtures.now)
            .environment(\.stillFrames, !scene.rawValue.hasPrefix("motion-"))
            .environment(\.chatVoice, DemoVoice())
            .onAppear { SerifFace.shared.prepare() }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                let marker = FileManager.default.temporaryDirectory.appendingPathComponent(DemoScene.shownMarker)
                try? Data(scene.rawValue.utf8).write(to: marker, options: .atomic)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let screen = ManageDemoScreen(rawValue: scene.rawValue) {
            manage(screen)
        } else {
            other
        }
    }

    @ViewBuilder
    private func manage(_ screen: ManageDemoScreen) -> some View {
        ManageDemoView(screen)
    }

    @ViewBuilder
    private var other: some View {
        switch scene {
        case .main:
            MainShell(model: .demo(.active), chat: .demo(DemoChatFixtures.answered()), actions: .demo(), threadId: DemoChatFixtures.osakaThreadId)
        case .chatEmpty:
            chat(DemoChatState())
        case .actionsDetail:
            approvalDetail(at: 0)
        case .actionsDetailFace:
            approvalDetail(at: 1)
        case .actionsApprovals:
            ApprovalsView(model: .demo(), openThread: { _ in }) {}
        case .actionsPrimer:
            PermissionPrimerView(permission: DeviceActionsModel.demoPermission, ask: {}, close: {})
                .himawariScreenBackground()
        case .actionsPrimerDenied:
            PermissionPrimerView(permission: DeviceActionsModel.demoDeniedPermission, ask: {}, close: {})
                .himawariScreenBackground()
        case .chat:
            chat(DemoChatFixtures.answered())
        case .chatSending:
            chat(DemoChatFixtures.sending())
        case .chatOffline:
            chat(DemoChatFixtures.offline())
        case .chatAnswering, .motionShimmer:
            chat(DemoChatFixtures.answering())
        case .chatFormat:
            chat(DemoChatFixtures.formatted())
        case .chatFormatStreaming:
            chat(DemoChatFixtures.formattedStreaming())
        case .chatRich:
            chat(DemoChatFixtures.rich())
        case .chatSelectText:
            chat(DemoChatFixtures.rich())
                .environment(\.chatOpensSelectText, "m2")
        case .chatCopied:
            chat(DemoChatFixtures.rich())
                .environment(\.chatShowsCopied, true)
        case .chatEmptyFlower:
            chat(DemoChatFixtures.empty())
        case .backgroundEntry:
            chat(DemoChatFixtures.backgroundWork())
        case .backgroundNone:
            chat(DemoChatFixtures.backgroundWork(empty: true))
        case .backgroundSheet:
            BackgroundWorkSheet(store: .demo(DemoChatFixtures.backgroundWork())) {}
        case .backgroundSubthread:
            subthread(DemoChatFixtures.backgroundFlightsId, opensExchanges: false)
        case .backgroundExchanges:
            subthread(DemoChatFixtures.backgroundFlightsId, opensExchanges: true)
        case .backgroundQuiet:
            NavigationStack {
                SubthreadPage(store: .demo(DemoChatFixtures.backgroundWork()), route: SubthreadRoute(matter: "报销", subthreadId: "thread-sub-0000000000000000000000000000000d"))
            }
        case .chatReplied:
            chat(DemoChatFixtures.replied())
        case .chatReplying:
            chat(DemoChatFixtures.answered())
                .environment(\.chatStartsReplyTo, "m2")
        case .chatOptions:
            chat(DemoChatFixtures.withOptions())
                .environment(\.chatChooseOption, { _, _, _ in })
        case .chatOptionChosen:
            chat(DemoChatFixtures.optionChosen())
                .environment(\.chatChooseOption, { _, _, _ in })
        case .chatAttach:
            chat(DemoChatFixtures.offline())
                .environment(\.chatOpensAttachSheet, true)
        case .chatTalkListening:
            chat(DemoChatFixtures.formatted())
                .environment(\.chatTalk, DemoTalk(phase: .listening, heard: DemoChatFixtures.talkHeard))
                .environment(\.chatOpensTalk, true)
        case .chatTalkHer:
            chat(DemoChatFixtures.formattedStreaming())
                .environment(\.chatTalk, DemoTalk(phase: .herTurn))
                .environment(\.chatOpensTalk, true)
        case .chatSteps:
            chat(DemoChatFixtures.answered())
                .environment(\.processStepsOpenAfter, 1)
        case .motionSheet:
            chat(DemoChatFixtures.answered())
                .environment(\.processStepsOpenAfter, 4)
        case .motionScroll:
            chat(DemoChatFixtures.longConversation())
                .environment(\.transcriptScrollsToTopAfter, 4)
        case .pairing:
            PairingView(model: .demo(.unpaired(nil)))
        case .pairingScan:
            PairingView(model: .demo(.unpaired(nil)), scanning: true)
        case .pairingConfirmServer:
            PairingView(model: .demo(.confirmingServer(host: DemoScene.demoHost)))
        case .pairingWaiting:
            PairingView(model: .demo(.waitingForConfirmation(number: "482 913"), host: DemoScene.demoHost))
        case .pairingExpired:
            PairingView(model: .demo(.unpaired(.codeExpired(ttlSeconds: 600))))
        case .pairingUnreachable:
            PairingView(model: .demo(.unpaired(.unreachable)))
        case .handoverTyping:
            HandoverDemo.sheet(.typing)
        case .handoverAnswered:
            HandoverDemo.sheet(.answered)
        case .handoverQueued:
            HandoverDemo.sheet(.queued)
        case .handoverEntryOff:
            HandoverDemo.sheet(.entryOff)
        case .handoverRemoved:
            HandoverDemo.sheet(.removed)
        case .handoverUnpaired:
            HandoverDemo.sheet(.unpaired)
        case .safariGuide:
            HandoverDemo.entry(.safariGuide)
        case .safariOn:
            HandoverDemo.entry(.safariOn)
        case .shareEntry:
            HandoverDemo.entry(.shareOn)
        case .pairingRemoved:
            PairingView(model: .demo(.unpaired(.removed)))
        case .sensesOverview:
            DemoSensesHost(scene: .overview)
        case .sensesIntro:
            DemoSensesHost(scene: .intro)
        case .sensesSystemPrompt:
            DemoSensesHost(scene: .systemPrompt)
        case .sensesDetail:
            DemoSensesHost(scene: .detail)
        case .sensesDenied:
            DemoSensesHost(scene: .denied)
        case .deletePerception:
            DemoPerceptionDeletionHost(segment: .episodes, episode: nil)
        case .deletePerceptionDays:
            DemoPerceptionDeletionHost(segment: .days, episode: nil)
        case .deletePerceptionEpisode:
            DemoPerceptionDeletionHost(segment: .episodes, episode: "episode:00000000000000000000000000000002")
        case .listenIntro, .listenEnroll, .listenLive, .listenInterrupted, .listenCalling, .listenAsking, .listenStopped:
            ListenDemoScene(scene: scene)
        case .memory, .memoryDetail, .memoryEdit, .rules, .ruleDetail, .deviceAbilities, .her, .herApprovals, .herPrivacy, .herDevices, .herNotifications, .herAllowances, .herAllowancesEmpty, .herAllowanceDays, .memoryVersions, .memoryTrash, .herAbout, .herTimers, .herTimersEmpty, .herTimersReminders, .herTimerRecurring, .herTimerReminder, .herTimerPaused, .herNoTimers:
            EmptyView()
        }
    }

    private func approvalDetail(at index: Int) -> some View {
        let actions = DeviceActionsModel.demo()
        return ApprovalDetailView(model: actions, approval: actions.pending[index], openThread: { _ in }) {}
    }

    private func subthread(_ id: String, opensExchanges: Bool) -> some View {
        NavigationStack {
            SubthreadPage(store: .demo(DemoChatFixtures.backgroundWork()), route: SubthreadRoute(matter: "12 月 3 日大阪出差", subthreadId: id), exchangesOpen: opensExchanges)
        }
    }

    private func chat(_ state: DemoChatState) -> some View {
        ChatView(store: .demo(state), threadId: DemoChatFixtures.osakaThreadId)
            .environment(\.chatCanAttach, true)
    }
}

struct DemoSensesHost: View {
    @State private var demo: (model: SensesModel, opening: SenseItem?, opensAutomatically: Bool)

    init(scene: DemoSensesScene) {
        _demo = State(initialValue: DemoSensesService.scene(scene, now: DemoChatFixtures.now))
    }

    var body: some View {
        SensesView(model: demo.model, opening: demo.opening, close: {}) {
            HandoverEntryRows()
        }
        .environment(\.senseOpensAutomatically, demo.opensAutomatically)
    }
}

struct DemoPerceptionDeletionHost: View {
    @State private var model: PerceptionDeletionModel
    private let episode: String?

    init(segment: PerceptionDeletionSegment, episode: String?) {
        let model = PerceptionDeletionModel(senses: DemoSensesService.scene(.overview, now: DemoChatFixtures.now).model)
        model.segment = segment
        _model = State(initialValue: model)
        self.episode = episode
    }

    var body: some View {
        PerceptionDeletionView(model: model, opening: episode, close: {})
    }
}

struct ListenDemoScene: View {
    let scene: DemoScene

    static let clock = Date(timeIntervalSince1970: 1_794_468_600)
    static let listeningSince = clock.addingTimeInterval(-(45 * 60 + 12))

    private var listening: ListenLiveState {
        ListenLiveState(phase: .listening, startedAt: Self.listeningSince, source: .deviceMicrophone)
    }

    var body: some View {
        switch scene {
        case .listenIntro:
            ListenSheetChrome {
                ListenIntroView(onStart: {}, onLater: {})
            }
            .background(Color.hmBackground)
        case .listenEnroll:
            ListenSheetChrome {
                VoiceprintEnrollView(
                    progress: EnrollmentProgress(index: 1, total: 3, prompt: ListenText.enrollmentPrompts()[1], levels: Array(VoiceLevels.resting.prefix(27))),
                    onClose: {},
                    onLater: {}
                )
            }
            .background(Color.hmBackground)
        case .listenLive:
            liveToday
        case .listenInterrupted:
            lockScreen(time: Self.clock) {
                let text = ListenNoticeText.of(.pausedTapToContinue, policy: .designed, now: Self.clock)
                LockNotificationCard(title: text.title, body: text.body, when: ListenText.nowLabel, actions: [ListenNoticeText.continueAction])
            }
        case .listenCalling:
            lockScreen(time: Self.clock) {
                ListenCallPanel(
                    state: ListenLiveState(phase: .calling, startedAt: Self.listeningSince, source: .deviceMicrophone, heard: ListenText.demoRequest, heardTail: ListenText.demoRequestTail),
                    levels: VoiceLevels.resting
                )
            }
        case .listenAsking:
            lockScreen(time: Self.clock.addingTimeInterval(60)) {
                ListenAskPanel(
                    state: ListenLiveState(phase: .asking, startedAt: Self.listeningSince, source: .deviceMicrophone, heard: ListenText.demoAskHeard, askReason: .speakerUnconfirmed)
                ) { label in label } itsMe: { label in label }
            }
        case .listenStopped:
            lockScreen(time: Self.clock) {
                VStack(spacing: 8) {
                    let limit = ListenNoticeText.of(.stopped(.dailyAudioLimit, resumesAt: Calendar.current.startOfDay(for: Self.clock.addingTimeInterval(86_400))), policy: .designed, now: Self.clock)
                    LockNotificationCard(title: limit.title, body: limit.body, when: ListenText.nowLabel, actions: [])
                    let battery = ListenNoticeText.of(.downgraded(.batteryLow), policy: .designed, now: Self.clock)
                    LockNotificationCard(title: battery.title, body: battery.body, when: Self.clock.addingTimeInterval(-25 * 60).formatted(date: .omitted, time: .shortened), actions: [])
                }
            }
        default:
            EmptyView()
        }
    }

    private var liveToday: some View {
        ZStack(alignment: .topLeading) {
            Color.hmBackground.ignoresSafeArea()
            RadialGradient(colors: [Color.hmGlow, .clear], center: UnitPoint(x: 0, y: 20 / 844), startRadius: 0, endRadius: 340)
                .ignoresSafeArea()
            ListenIslandCompact(state: listening, now: Self.clock)
                .padding(.horizontal, 12)
                .listenIslandPreviewSurface()
                .offset(x: 96, y: 11)
            ListenLockBanner(state: listening, now: Self.clock) { label in label } stop: { label in label }
                .listenBannerPreviewSurface()
                .offset(x: 12, y: 62)
        }
        .ignoresSafeArea()
    }

    private func lockScreen<Content: View>(time: Date, @ViewBuilder content: () -> Content) -> some View {
        LockScreenBackdrop(
            time: time.formatted(date: .omitted, time: .shortened),
            date: time.formatted(.dateTime.month().day().weekday(.abbreviated)),
            content: content
        )
    }
}

#endif
