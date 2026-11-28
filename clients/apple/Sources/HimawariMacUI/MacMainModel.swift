#if os(macOS)
import Foundation
import HimawariCore
import HimawariManage
import HimawariShell
import Observation

public enum MacDestination: Hashable, Sendable {
    case chat
    case her(HerSection)

    static let sidebarSections: [HerSection] = [.memory, .rules, .approvals, .timers, .allowances, .vault]
}

struct ChatDraft: Equatable {
    var text = ""
    var id = UUID()
}

@MainActor
@Observable
public final class MacMainModel {
    public var selection: MacDestination? = .chat
    private(set) var draft = ChatDraft()
    public private(set) var workspace: HerWorkspace?
    @ObservationIgnored let app: AppModel
    @ObservationIgnored private var workspaceOrigin: String?

    init(app: AppModel) {
        self.app = app
    }

    var isSignedIn: Bool { app.phase == .active && app.chat != nil }

    var herDestinations: [HerSection] {
        guard let workspace else { return [] }
        return MacDestination.sidebarSections.filter { workspace.isAvailable($0, actions: app.actions) }
    }

    var destinations: [MacDestination] {
        isSignedIn ? [.chat] + herDestinations.map(MacDestination.her) : []
    }

    var settingsSections: [HerSection] {
        guard let workspace else { return [] }
        return [HerSection.notifications, .privacy].filter { workspace.isAvailable($0, actions: app.actions) }
    }

    func badge(for destination: MacDestination) -> Int {
        guard destination == .her(.approvals) else { return 0 }
        return app.actions?.waitingCount ?? 0
    }

    func talk(_ text: String) {
        draft = ChatDraft(text: text)
        selection = .chat
    }

    func go(to destination: MacDestination) {
        guard destinations.contains(destination) else { return }
        selection = destination
    }

    func syncWithSignIn() async {
        guard isSignedIn else {
            workspace = nil
            workspaceOrigin = nil
            selection = .chat
            return
        }
        let origin = app.api.http.currentCredentials.map { "\($0.origin.absoluteString)#\($0.deviceId)" }
        guard workspace == nil || origin != workspaceOrigin else { return }
        let workspace = HerWorkspace(api: app.api, confirmKey: app.confirmKey)
        self.workspace = workspace
        workspaceOrigin = origin
        await workspace.load()
        if let selection, !destinations.contains(selection) { self.selection = .chat }
    }
}
#endif
