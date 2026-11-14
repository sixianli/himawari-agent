#if os(macOS)
import AppKit
import Foundation
import HimawariChat
import HimawariCore
import HimawariShell
import Observation

struct RunningWork: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let progress: DeviceProgress?
    let progressLabel: String?

    init(id: String, title: String, progress: DeviceProgress?, progressLabel: String?) {
        self.id = id
        self.title = title
        self.progress = progress
        self.progressLabel = progressLabel
    }
}

@MainActor
protocol MacWorkControl: AnyObject {
    func stop(_ workId: String) async
}

@MainActor
@Observable
final class MenuBarModel {
    let app: AppModel
    let settings: MacSettingsStore
    private(set) var home: HomeSnapshot?
    private(set) var running: [RunningWork] = []
    private(set) var acting: String?
    private(set) var failedItem: String?
    private(set) var shortcutState: GlobalShortcut.State?
    @ObservationIgnored weak var work: MacWorkControl?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var serverActions: [DeviceActionSummary] = []
    @ObservationIgnored private var localProgress: [String: DeviceProgress] = [:]
    @ObservationIgnored private var actionRequestIds: [String: String] = [:]
    @ObservationIgnored private var demoShowsStop = false

    init(app: AppModel, settings: MacSettingsStore) {
        self.app = app
        self.settings = settings
    }

    init(demo app: AppModel, settings: MacSettingsStore, home: HomeSnapshot?, running: [RunningWork], shortcut: GlobalShortcut.State?) {
        self.app = app
        self.settings = settings
        self.home = home
        self.running = running
        shortcutState = shortcut
        demoShowsStop = true
    }

    var awaitingCount: Int { home?.awaitingCount ?? 0 }
    var mostPressing: HomeItem? { home?.mostPressing }

    func shortcutChanged(_ state: GlobalShortcut.State?) {
        shortcutState = state
    }

    var activeShortcutLabel: String? {
        if case let .active(shortcut) = shortcutState { return GlobalShortcut.label(shortcut) }
        return nil
    }

    func startRefreshing() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await refresh()
                let seconds = app.configuration.map { TimeInterval($0.heartbeatSeconds) } ?? 30
                try? await Task.sleep(for: .seconds(max(seconds, 1)))
            }
        }
    }

    func refresh() async {
        guard app.phase == .active else {
            home = nil
            running = []
            return
        }
        let locale = AnswerLocale.matching(preferredLanguages: Locale.preferredLanguages).rawValue
        if let snapshot = try? await app.api.home(locale: locale) { home = snapshot }
        if let actions = try? await app.api.deviceActions() {
            serverActions = actions
            rebuildRunning()
        }
    }

    func report(progress: DeviceProgress?, for actionId: String) {
        localProgress[actionId] = progress
        rebuildRunning()
    }

    private func rebuildRunning() {
        running = serverActions.filter(\.isRunning).map { action in
            let progress = localProgress[action.id]
            return RunningWork(
                id: action.id,
                title: DetailLocale.pick(action.detail) ?? "",
                progress: progress,
                progressLabel: progress.map { L.format("panel.progress", $0.done, $0.total) }
            )
        }
    }

    var canStop: Bool { work != nil || demoShowsStop }

    func stop(_ workId: String) {
        Task { await work?.stop(workId) }
    }

    func respond(_ item: HomeItem, with action: HomeAction) {
        guard acting == nil else { return }
        acting = item.key
        failedItem = nil
        let key = [item.key, action.action, action.binding ?? ""].joined(separator: "\n")
        let requestId = actionRequestIds[key] ?? OutgoingMessage.newId()
        actionRequestIds[key] = requestId
        let presence = action.ownerPresence ? app.ownerPresence(reason: L.text("panel.presenceReason")) : nil
        Task {
            do {
                try await app.api.act(on: item, action: action, requestId: requestId, presence: presence)
                actionRequestIds[key] = nil
            } catch OwnerPresenceError.declined {
                actionRequestIds[key] = nil
                acting = nil
                return
            } catch let DeviceAPIError.server(status, _, _, _) where (400 ..< 500).contains(status) {
                actionRequestIds[key] = nil
                failedItem = item.key
            } catch {
                failedItem = item.key
            }
            await refresh()
            acting = nil
        }
    }
}
#endif
