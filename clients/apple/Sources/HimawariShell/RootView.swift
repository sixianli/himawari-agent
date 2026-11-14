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
                MainTabsView(model: model, chat: chat, actions: actions)
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
    @State private var tab: MainTab
    @State private var openThread: OpenThread?
    @State private var settingsOpen = false
    @Environment(\.tabsCycleEvery) private var cycleEvery
    @Environment(\.listClock) private var listClock

    init(model: AppModel, chat: ChatStore, actions: DeviceActionsModel, tab: MainTab = .chats) {
        self.model = model
        self.chat = chat
        self.actions = actions
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
        .hmCover(isPresented: $settingsOpen) {
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

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .today:
            TodayView(actions: actions, openSettings: { settingsOpen = true }) { threadId in
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
                    FloatingTab(id: MainTab.today, title: Text(L.text("tab.today")), badge: actions.waitingCount) {
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

struct TodayView: View {
    let actions: DeviceActionsModel
    let openSettings: () -> Void
    let openThread: (String) -> Void
    @State private var opened: PendingApproval?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if let opened {
                ApprovalDetailView(model: actions, approval: opened, openThread: openThread) { withAnimation(.snappy) { self.opened = nil } }
                    .transition(.move(edge: .trailing))
                    .zIndex(1)
            }
            if actions.pending.isEmpty && actions.recent.isEmpty {
                EmptyStateView(Text(L.text("placeholder.notConnected")))
            } else {
                ScrollView {
                    TodayDeviceActionsCard(model: actions) { approval in
                        withAnimation(.snappy) { opened = approval }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, DesignTokens.Size.navBarHeight + 16)
                    .padding(.bottom, 130)
                }
                .scrollIndicators(.hidden)
                .refreshable { await actions.refresh() }
            }
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
