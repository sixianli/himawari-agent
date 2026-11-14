import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariManage
import SwiftUI

public struct HimawariRootView: View {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
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

    private var app: some View {
        Group {
            if model.phase == .active, let chat = model.chat {
                MainTabsView(model: model, chat: chat)
            } else {
                PairingView(model: model)
            }
        }
        .onAppear { SerifFace.shared.prepare() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive() }
        }
    }
}

enum MainTab: Hashable {
    case today
    case chats
    case memory
}

struct MainTabsView: View {
    let model: AppModel
    let chat: ChatStore
    @State private var tab: MainTab
    @State private var openThread: OpenThread?
    @State private var settingsOpen: Bool
    @Environment(\.tabsCycleEvery) private var cycleEvery
    private let memoryOverride: AnyView?
    private let settingsOverride: AnyView?

    init(model: AppModel, chat: ChatStore, tab: MainTab = .chats, memory: AnyView? = nil, settings: AnyView? = nil) {
        self.model = model
        self.chat = chat
        _tab = State(initialValue: tab)
        _settingsOpen = State(initialValue: settings != nil)
        memoryOverride = memory
        settingsOverride = settings
    }

    struct OpenThread: Equatable {
        let threadId: String?
        var draft = ""
        let nonce = UUID()
    }

    var body: some View {
        ZStack {
            if let openThread {
                ChatView(store: chat, threadId: openThread.threadId, draft: openThread.draft) {
                    withAnimation(.snappy) { self.openThread = nil }
                }
                .id(openThread.nonce)
                .transition(.move(edge: .trailing))
            } else {
                content
                    .safeAreaInset(edge: .bottom) { Color.clear.frame(height: DesignTokens.Size.tabBarReserve) }
                    .overlay(alignment: .bottom) { bars }
                    .transition(.opacity)
            }
        }
        .task {
            guard let cycleEvery else { return }
            let order: [MainTab] = [.chats, .today, .memory, .chats]
            for next in order.dropFirst() {
                try? await Task.sleep(for: .seconds(cycleEvery))
                withAnimation(.snappy) { tab = next }
            }
        }
        .sheet(isPresented: $settingsOpen) {
            Group {
                if let settingsOverride {
                    settingsOverride
                } else {
                    SettingsRootView(
                        api: model.api,
                        confirmKey: model.confirmKey,
                        close: { settingsOpen = false },
                        removedThisDevice: {
                            settingsOpen = false
                            model.removedThisDevice()
                        }
                    )
                }
            }
                .presentationDetents([.large])
                .presentationCornerRadius(DesignTokens.Radius.sheetTop)
                .presentationBackground(Color.hmBackground)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .today:
            TodayView { settingsOpen = true }
        case .chats:
            ChatListView(store: chat) { threadId in
                withAnimation(.snappy) { openThread = OpenThread(threadId: threadId) }
            }
        case .memory:
            if let memoryOverride {
                memoryOverride
            } else {
                memoryView
            }
        }
    }

    private var memoryView: some View {
        MemoryRootView(api: model.api, confirmKey: model.confirmKey) { draft in
            withAnimation(.snappy) { openThread = OpenThread(threadId: nil, draft: draft) }
        }
    }

    private var bars: some View {
        ZStack(alignment: .bottom) {
            EdgeFade(.bottom, height: DesignTokens.Size.fadeTabBar).ignoresSafeArea()
            HStack(spacing: 14) {
                FloatingTabBar(selection: $tab, tabs: [
                    FloatingTab(id: MainTab.today, title: Text(L.text("tab.today"))) { Icon(.sun) },
                    FloatingTab(id: MainTab.chats, title: Text(L.text("tab.chats"))) { Icon(.message) },
                    FloatingTab(id: MainTab.memory, title: Text(L.text("tab.memory"))) { Icon(.affiliate) },
                ])
                .frame(maxWidth: DesignTokens.Size.tabBarWidth)
                Spacer(minLength: 0)
                SunflowerButton(Text(L.text("talk"))) {
                    withAnimation(.snappy) { openThread = OpenThread(threadId: nil) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }
}

struct TodayView: View {
    let openSettings: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            EmptyStateView(Text(L.text("placeholder.notConnected")))
            GlassCircleButton(Text(L.text("settings")), action: openSettings) {
                Icon(.user, size: DesignTokens.IconSize.glassButton)
            }
            .padding(.trailing, 16)
            .padding(.top, 10)
        }
        .himawariScreenBackground()
    }
}

extension EnvironmentValues {
    @Entry var tabsCycleEvery: Double? = nil
}
