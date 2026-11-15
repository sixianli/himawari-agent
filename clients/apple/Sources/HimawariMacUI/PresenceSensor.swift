#if os(macOS)
import CoreGraphics
import Foundation
import HimawariChat
import HimawariCore
import HimawariShell

@MainActor
final class PresenceSensor {
    private let app: AppModel
    private let policy: PresenceReportPolicy
    private var lastReport: PresenceReport?
    private var task: Task<Void, Never>?

    init(app: AppModel, policy: PresenceReportPolicy = .standard) {
        self.app = app
        self.policy = policy
    }

    func start() {
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await tick()
                try? await Task.sleep(for: .seconds(policy.secondsUntilNextCheck(now: Date(), lastReport: lastReport)))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func tick() async {
        let now = Date()
        guard app.phase == .active, let seconds = Self.secondsSinceInput(), let lastInputAt = PresenceReport.lastInput(secondsSinceInput: seconds, now: now) else { return }
        let connected = app.chat?.connection == .online
        guard policy.shouldReport(lastInputAt: lastInputAt, now: now, lastReport: lastReport, streamConnected: connected) else { return }
        lastReport = PresenceReport(lastInputAt: lastInputAt, sentAt: now)
        try? await app.api.reportPresence(lastInputAt: lastInputAt)
    }

    static func secondsSinceInput() -> TimeInterval? {
        guard let anyInput = CGEventType(rawValue: ~0) else { return nil }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
    }
}
#endif
