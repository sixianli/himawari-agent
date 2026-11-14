#if DEBUG
import Foundation
import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariListenUI
import HimawariManage
import HimawariShare
import SwiftUI

enum DemoScene: String, CaseIterable {
    case chatList = "03-chat-list"
    case chat = "04-chat"
    case memory = "05-memory"
    case memoryDetail = "06-memory-detail"
    case memoryEdit = "18-memory-more-1-edit"
    case rules = "18-memory-more-2-rules"
    case ruleDetail = "18-memory-more-3-rule-detail"
    case settings = "08-settings"
    case device = "19-settings-more-1-device"
    case addDevice = "19-settings-more-2-add-device"
    case addDeviceAsking = "19-settings-more-3-new-device"
    case addDeviceExpired = "19-settings-more-4-code-expired"
    case files = "19-settings-more-5-files"
    case exportPacking = "19-settings-more-6-export-packing"
    case exportReady = "19-settings-more-7-export-ready"
    case capabilities = "20-himawari-self-1-capabilities"
    case loginBrowsers = "20-himawari-self-2-login-browsers"
    case pairing = "11-pairing"
    case pairingScan = "15-pairing-flow-1-scan"
    case pairingConfirmServer = "15-pairing-flow-1b-confirm-server"
    case pairingWaiting = "15-pairing-flow-2-waiting"
    case pairingExpired = "15-pairing-flow-3-expired"
    case pairingUnreachable = "15-pairing-flow-4-unreachable"
    case pairingRemoved = "15-pairing-flow-5-removed"
    case chatEmpty = "16-chat-states-1-empty"
    case chatNew = "16-chat-states-2-new"
    case chatSending = "16-chat-states-3-sending"
    case chatOffline = "16-chat-states-4-offline"
    case chatAnswering = "16-chat-states-5-answering"
    case chatSteps = "16-chat-states-6-steps"
    case tabTodayOneDigit = "tab-today-1-digit"
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
    case motionTabs = "motion-tab-switch"
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
        switch screen {
        case .memory, .memoryDetail, .memoryEdit, .rules, .ruleDetail:
            MainTabsView(model: .demo(.active), chat: .demo(DemoChatFixtures.chatList()), tab: .memory, memory: AnyView(ManageDemoView(screen)))
        default:
            MainTabsView(model: .demo(.active), chat: .demo(DemoChatFixtures.chatList()), tab: .today, settings: AnyView(ManageDemoView(screen)))
        }
    }

    @ViewBuilder
    private var other: some View {
        switch scene {
        case .chatList:
            tabs(DemoChatFixtures.chatList())
        case .chatEmpty:
            tabs(DemoChatState())
        case .tabTodayOneDigit:
            tabs(DemoChatFixtures.chatList())
                .environment(\.listClock, DemoChatFixtures.now.addingTimeInterval(-3 * 86_400))
        case .motionTabs:
            tabs(DemoChatFixtures.chatList())
                .environment(\.tabsCycleEvery, 3)
        case .chat:
            chat(DemoChatFixtures.answered())
        case .chatNew:
            ChatView(store: .demo(DemoChatState()), threadId: nil) {}
        case .chatSending:
            chat(DemoChatFixtures.sending())
        case .chatOffline:
            chat(DemoChatFixtures.offline())
        case .chatAnswering, .motionShimmer:
            chat(DemoChatFixtures.answering())
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
        case .listenIntro, .listenEnroll, .listenLive, .listenInterrupted, .listenCalling, .listenAsking, .listenStopped:
            ListenDemoScene(scene: scene)
        case .memory, .memoryDetail, .memoryEdit, .rules, .ruleDetail, .settings, .device, .addDevice, .addDeviceAsking,
            .addDeviceExpired, .files, .exportPacking, .exportReady, .capabilities, .loginBrowsers:
            EmptyView()
        }
    }

    private func tabs(_ state: DemoChatState) -> some View {
        MainTabsView(model: .demo(.active), chat: .demo(state))
    }

    private func chat(_ state: DemoChatState) -> some View {
        ChatView(store: .demo(state), threadId: DemoChatFixtures.osakaThreadId) {}
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
            ListenTodayCardPreview()
                .padding(.horizontal, 16)
                .padding(.top, 152)
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

struct ListenTodayCardPreview: View {
    var body: some View {
        SensingCard(summary: SensingSummary(paused: false, senses: [ListenText.hearingLabel], todayCount: 5), onPause: {}, onOpen: {})
    }
}
#endif
