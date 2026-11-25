import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariListen
import HimawariListenUI
import HimawariManage
import HimawariSenses
import HimawariShare
import SwiftUI

public struct HimawariRootView: View {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        Group {
            #if DEBUG
            if let scene = DemoScene.requested {
                DemoSceneView(scene: scene)
            } else {
                app
            }
            #else
            app
            #endif
        }
        .dismissesKeyboardOnOutsideTap()
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    @State private var handoverEntry: HandoverEntryLink?

    private var app: some View {
        Group {
            if model.phase == .active, let chat = model.chat {
                MainShell(model: model, chat: chat)
            } else {
                PairingView(model: model)
            }
        }
        .onOpenURL { url in
            handoverEntry = HandoverLink.entry(in: url).map(HandoverEntryLink.init)
        }
        .sheet(item: $handoverEntry) { link in
            NavigationStack {
                HandoverEntryRoute(link.entry, safariURL: model.vault.pairingRecord()?.origin)
            }
        }
        .onAppear { SerifFace.shared.prepare() }
        .onOpenURL { url in model.handlePairingLink(url.absoluteString) }
        .confirmationDialog(
            L.text("watch.offer.title"),
            isPresented: Binding(get: { model.watchOffer != nil }, set: { if !$0 { model.declineWatchOffer() } }),
            titleVisibility: .visible
        ) {
            Button(L.text("watch.offer.watch")) { model.sendOfferToWatch() }
            Button(L.text("watch.offer.cancel"), role: .cancel) { model.declineWatchOffer() }
        } message: {
            if let host = model.watchOfferHost { Text(host) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive() }
        }
    }
}

struct HandoverEntryLink: Identifiable {
    let entry: HandoverEntry
    var id: String { entry.rawValue }
}

struct MainShell: View {
    let model: AppModel
    let chat: ChatStore
    private let actionsOverride: DeviceActionsModel?
    private let fixedThreadId: String?
    @State private var mainThreadId: String?
    @State private var lookupFailed = false
    @State private var draft = Draft()
    @State private var listening: ListeningController?
    @State private var herOpen: Bool
    @State private var herListenOpen = false
    #if os(iOS)
    @State private var dictation = ChatDictation()
    @State private var talkSession = ChatTalkSession()
    #endif

    init(model: AppModel, chat: ChatStore, actions: DeviceActionsModel? = nil, threadId: String? = nil, herOpen: Bool = false) {
        self.model = model
        self.chat = chat
        actionsOverride = actions
        fixedThreadId = threadId
        _herOpen = State(initialValue: herOpen)
    }

    private var actions: DeviceActionsModel? { actionsOverride ?? model.actions }

    struct Draft: Equatable {
        var text = ""
        var nonce = UUID()
    }

    var body: some View {
        Group {
            if let threadId = fixedThreadId ?? mainThreadId {
                ChatView(store: chat, threadId: threadId, draft: draft.text, openHerPage: { herOpen = true })
                    .id(draft.nonce)
                    .environment(\.chatStopRun, stopRun)
                    .environment(\.chatOwnerAwaited, (actions?.waitingCount ?? 0) > 0)
                    .environment(\.chatCanAttach, model.configuration?.acceptsChatAttachments == true)
                    #if os(iOS)
                    .environment(\.chatVoice, dictation)
                    .environment(\.chatTalk, talkSession)
                    #endif
            } else {
                MainThreadWaiting(failed: lookupFailed) { Task { await findMainThread() } }
            }
        }
        .task {
            guard fixedThreadId == nil, mainThreadId == nil else { return }
            await findMainThread()
        }
        .overlay(alignment: .bottom) {
            if let listening {
                ListenOverlay(controller: listening)
            }
        }
        .hmCover(isPresented: $herOpen) {
            herPage
        }
        #if os(iOS)
        .hmCover(isPresented: Binding(get: { listening?.recordingKitOpen ?? false }, set: { listening?.recordingKitOpen = $0 })) {
            ListenEvalKitView { listening?.recordingKitOpen = false }
        }
        #endif
        .onAppear {
            if listening == nil, model.phase == .active {
                listening = ListeningController(api: model.api, chat: chat)
            }
        }
    }

    private func findMainThread() async {
        lookupFailed = false
        do {
            mainThreadId = try await MainThreadLocator(api: model.api, confirmKey: model.confirmKey).mainThreadId()
        } catch {
            lookupFailed = true
        }
    }

    private var stopRun: @MainActor @Sendable (String, ThreadRunSummary) async throws -> Void {
        let stopper = ThreadRunStopper(api: model.api, confirmKey: model.confirmKey)
        return { threadId, run in try await stopper.stop(threadId: threadId, run: run) }
    }

    private var herPage: some View {
        HerPage(
            api: model.api,
            confirmKey: model.confirmKey,
            listening: listening,
            actions: actions,
            openListening: { herListenOpen = true },
            senses: model.senses.map { senses in
                AnyView(SensesView(model: senses) { HandoverEntryRows() })
            },
            sensesOn: { model.senses?.status?.senses.count },
            talk: { text in
                herOpen = false
                draft = Draft(text: text)
            },
            close: { herOpen = false },
            removedThisDevice: {
                herOpen = false
                model.removedThisDevice()
            }
        )
        .sheet(isPresented: $herListenOpen) {
            if let listening {
                ListenEntrySheet(controller: listening) { herListenOpen = false }
                    .presentationCornerRadius(DesignTokens.Radius.sheetTop)
            }
        }
    }
}

struct MainThreadWaiting: View {
    let failed: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: DesignTokens.Avatar.wordmarkGap) {
            HimawariAvatar(busy: !failed)
            if failed {
                Button(action: retry) {
                    Text(L.text("main.retry"))
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmSun)
                        .frame(minHeight: DesignTokens.Size.rowMinHeight)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .himawariScreenBackground()
    }
}

extension ListeningController: HerListening {}
