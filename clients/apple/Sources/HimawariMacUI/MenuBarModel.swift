#if os(macOS)
import AppKit
import Foundation
import HimawariChat
import HimawariCore
import HimawariShell
import Observation

public struct RunningWork: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let progress: DeviceProgress?
    public let progressLabel: String?

    public init(id: String, title: String, progress: DeviceProgress?, progressLabel: String?) {
        self.id = id
        self.title = title
        self.progress = progress
        self.progressLabel = progressLabel
    }
}

@MainActor
public protocol MacWorkControl: AnyObject {
    func stop(_ workId: String) async
}

@MainActor
@Observable
public final class MenuBarModel {
    public let app: AppModel
    public let settings: MacSettingsStore
    public private(set) var home: HomeSnapshot?
    public private(set) var running: [RunningWork] = []
    public private(set) var acting: String?
    public private(set) var shortcutState: GlobalShortcut.State?
    @ObservationIgnored public weak var work: MacWorkControl?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var serverActions: [DeviceActionSummary] = []
    @ObservationIgnored private var localProgress: [String: DeviceProgress] = [:]

    public init(app: AppModel, settings: MacSettingsStore) {
        self.app = app
        self.settings = settings
    }

    init(demo app: AppModel, settings: MacSettingsStore, home: HomeSnapshot?, running: [RunningWork], shortcut: GlobalShortcut.State?) {
        self.app = app
        self.settings = settings
        self.home = home
        self.running = running
        shortcutState = shortcut
    }

    public var awaitingCount: Int { home?.awaitingCount ?? 0 }
    public var mostPressing: HomeItem? { home?.mostPressing }

    func shortcutChanged(_ state: GlobalShortcut.State?) {
        shortcutState = state
    }

    public var activeShortcutLabel: String? {
        if case let .active(shortcut) = shortcutState { return GlobalShortcut.label(shortcut) }
        return nil
    }

    public func startRefreshing() {
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

    public func refresh() async {
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

    public func report(progress: DeviceProgress?, for actionId: String) {
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

    public func stop(_ workId: String) {
        Task { await work?.stop(workId) }
    }

    public func respond(_ item: HomeItem, with action: HomeAction) {
        guard acting == nil else { return }
        acting = item.key
        Task {
            defer { acting = nil }
            try? await app.api.act(on: item, action: action, requestId: OutgoingMessage.newId())
            await refresh()
        }
    }
}
#endif
