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
            if model.phase == .active, let chat = model.chat, let actions = model.actions {
                MainTabsView(model: model, chat: chat, actions: actions, feed: model.home)
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
    let actions: DeviceActionsModel
    let feed: HomeFeedModel
    @State private var tab: MainTab
    @State private var openThread: OpenThread?
    @State private var settingsOpen = false
    @Environment(\.tabsCycleEvery) private var cycleEvery
    @Environment(\.listClock) private var listClock

    init(model: AppModel, chat: ChatStore, actions: DeviceActionsModel, feed: HomeFeedModel, tab: MainTab = .chats) {
        self.model = model
        self.chat = chat
        self.actions = actions
        self.feed = feed
        _tab = State(initialValue: tab)
    }

    struct OpenThread: Equatable {
        let threadId: String?
        let nonce = UUID()
    }

    var body: some View {
        ZStack {
            if let openThread {
                ChatView(store: chat, threadId: openThread.threadId) {
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
        .fullScreenCover(isPresented: $settingsOpen) {
            SettingsRootView(actions: actions, device: thisDevice, openThread: { threadId in
                settingsOpen = false
                withAnimation(.snappy) { openThread = OpenThread(threadId: threadId) }
            }) { settingsOpen = false }
        }
    }

    private var thisDevice: ThisDevice {
        let link: ThisDevice.Link = switch chat.connection {
        case .online: .online
        case .connecting: .connecting
        case .offline: .offline
        }
        return ThisDevice(name: AppModel.deviceName, link: link, pairedAt: model.pairedAt, version: model.versionLine)
    }

    private var todayBadge: Int? {
        feed.available ? feed.layout?.badge : actions.waitingCount
    }

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .today:
            TodayPage(feed: feed, actions: actions, openSettings: { settingsOpen = true }, openSearch: nil) { threadId in
                withAnimation(.snappy) { openThread = OpenThread(threadId: threadId) }
            }
        case .chats:
            ChatListView(store: chat) { threadId in
                withAnimation(.snappy) { openThread = OpenThread(threadId: threadId) }
            }
        case .memory:
            MemoryRootView(api: model.api)
        }
    }

    private var bars: some View {
        ZStack(alignment: .bottom) {
            EdgeFade(.bottom, height: DesignTokens.Size.fadeTabBar, solid: 0.3)
            HStack(spacing: 0) {
                FloatingTabBar(selection: $tab, tabs: [
                    FloatingTab(id: MainTab.today, title: Text(L.text("tab.today")), badge: todayBadge) {
                        TimelineView(.everyMinute) { context in
                            TodayTabIcon(day: TodayNumber.day(at: listClock ?? context.date))
                        }
                    },
                    FloatingTab(id: MainTab.chats, title: Text(L.text("tab.chats"))) { Icon(.message) },
                    FloatingTab(id: MainTab.memory, title: Text(L.text("tab.memory"))) { Icon(.affiliate) },
                ])
                .frame(maxWidth: DesignTokens.Size.tabBarWidth)
                .layoutPriority(1)
                Spacer(minLength: 12)
                SunflowerButton(Text(L.text("talk"))) {
                    withAnimation(.snappy) { openThread = OpenThread(threadId: nil) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 26)
        }
        .ignoresSafeArea(.container, edges: .bottom)
    }
}

extension EnvironmentValues {
    @Entry var tabsCycleEvery: Double? = nil
}
