#if os(macOS)
import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariManage
import HimawariShell
import SwiftUI

struct MacMainView: View {
    @Bindable var main: MacMainModel
    let register: @MainActor (OpenWindowAction, OpenSettingsAction) -> Void
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        Group {
            if main.isSignedIn, let chat = main.app.chat {
                NavigationSplitView {
                    sidebar
                        .navigationSplitViewColumnWidth(
                            min: DesignTokens.Mac.sidebarMinWidth,
                            ideal: DesignTokens.Mac.sidebarWidth,
                            max: DesignTokens.Mac.sidebarMaxWidth
                        )
                } detail: {
                    detail(chat: chat)
                }
                .frame(minWidth: DesignTokens.Mac.windowMinWidth, minHeight: DesignTokens.Mac.windowMinHeight)
            } else {
                Color.clear
                    .onAppear { dismissWindow(id: MacScenes.mainWindow) }
            }
        }
        .onAppear { register(openWindow, openSettings) }
        .task(id: main.app.phase) { await main.syncWithSignIn() }
    }

    private var sidebar: some View {
        List(selection: $main.selection) {
            row(.chat)
            let her = main.herDestinations
            if !her.isEmpty {
                Section(L.text("sidebar.her")) {
                    ForEach(her, id: \.self) { section in
                        row(.her(section))
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func row(_ destination: MacDestination) -> some View {
        Label {
            Text(MacSidebarText.title(destination))
        } icon: {
            MacSidebarIcon(destination: destination)
        }
        .badge(main.badge(for: destination))
        .tag(destination)
    }

    @ViewBuilder
    private func detail(chat: ChatStore) -> some View {
        switch main.selection ?? .chat {
        case .chat:
            MainChatPane(model: main.app, chat: chat, draft: main.draft.text)
                .id(main.draft.id)
                .frame(maxWidth: DesignTokens.Mac.chatColumnMaxWidth)
                .frame(maxWidth: .infinity)
                .navigationTitle(L.text("sidebar.chat"))
        case .her(let section):
            if let workspace = main.workspace {
                HerSectionPane(
                    model: main.app,
                    section: section,
                    workspace: workspace,
                    talk: { main.talk($0) },
                    openChat: { main.selection = .chat }
                )
            }
        }
    }
}

enum MacSidebarText {
    static func title(_ destination: MacDestination) -> String {
        switch destination {
        case .chat: L.text("sidebar.chat")
        case .her(let section): section.title
        }
    }
}
#endif
