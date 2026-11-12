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
    @State private var tab: MainTab = .chats
    @State private var openThread: OpenThread?
    @State private var settingsOpen = false

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
                    .safeAreaInset(edge: .bottom) { Color.clear.frame(height: 80) }
                    .overlay(alignment: .bottom) { bars }
                    .transition(.opacity)
            }
        }
        .fullScreenCover(isPresented: $settingsOpen) {
            SettingsRootView(api: model.api) { settingsOpen = false }
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
            MemoryRootView(api: model.api)
        }
    }

    private var bars: some View {
        ZStack(alignment: .bottom) {
            EdgeFade(.bottom, height: 140).ignoresSafeArea()
            HStack(spacing: 14) {
                FloatingTabBar(selection: $tab, tabs: [
                    FloatingTab(id: MainTab.today, title: Text(L.text("tab.today"))) { Icon(.sun) },
                    FloatingTab(id: MainTab.chats, title: Text(L.text("tab.chats"))) { Icon(.message) },
                    FloatingTab(id: MainTab.memory, title: Text(L.text("tab.memory"))) { Icon(.affiliate) },
                ])
                .frame(maxWidth: 282)
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
                Icon(.user, size: 24)
            }
            .padding(.trailing, 16)
            .padding(.top, 10)
        }
        .himawariScreenBackground()
    }
}
