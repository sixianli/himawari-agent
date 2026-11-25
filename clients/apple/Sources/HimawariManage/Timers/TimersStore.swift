import Foundation
import HimawariCore
import Observation

@MainActor
@Observable
public final class TimersStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case unsupported
        case failed
    }

    public private(set) var phase: Phase = .loading
    public private(set) var timers: [OwnerTimer] = []
    public private(set) var working: Set<String> = []
    public var failedChange = false

    @ObservationIgnored private let read: () async throws -> TimersSnapshot
    @ObservationIgnored private let send: (String, OwnerTimer.Action, String) async throws -> Void

    public init(gateway: ManageGateway) {
        read = {
            try TimersSnapshot.decode(try await gateway.read(.v2, "timers.read"))
        }
        send = { timerId, action, reason in
            _ = try await gateway.command(
                .v2,
                "timers.change",
                payload: ["timerId": .string(timerId), "action": .string(action.rawValue)],
                options: ManageCommandOptions(confirmReason: reason)
            )
        }
    }

    init(timers: [OwnerTimer]?, failing: Bool = false) {
        let snapshot = timers.map { TimersSnapshot(timers: $0, generatedAt: Date()) }
        read = {
            guard let snapshot else { throw ManageGatewayError.unknownType(.v2, "timers.read") }
            return snapshot
        }
        send = { _, _, _ in
            if failing { throw ManageGatewayError.rejected(status: 409, code: nil) }
        }
        if let timers {
            self.timers = timers
            phase = .loaded
        } else {
            phase = .unsupported
        }
    }

    public var groups: [TimerGroup] { TimerList.groups(timers) }
    public var counts: (active: Int, paused: Int) { TimerList.counts(timers) }

    public func timer(_ id: String) -> OwnerTimer? { timers.first { $0.timerId == id } }

    public func load() async {
        do {
            timers = try await read().timers
            phase = .loaded
        } catch let error as ManageGatewayError where Self.isUnsupported(error) {
            phase = .unsupported
        } catch {
            if phase != .loaded { phase = .failed }
        }
    }

    public func change(_ timer: OwnerTimer, _ action: OwnerTimer.Action, reason: String) async {
        guard !working.contains(timer.timerId) else { return }
        if action == .pause, !timer.canPause { return }
        let before = timers
        working.insert(timer.timerId)
        defer { working.remove(timer.timerId) }
        if let index = timers.firstIndex(where: { $0.timerId == timer.timerId }) {
            switch action {
            case .pause: timers[index].status = .paused
            case .resume: timers[index].status = .active
            case .cancel: timers[index].status = .cancelled
            }
        }
        do {
            try await send(timer.timerId, action, reason)
        } catch {
            timers = before
            failedChange = true
            return
        }
        await load()
    }

    static func isUnsupported(_ error: ManageGatewayError) -> Bool {
        switch error {
        case .unknownType, .notOnPhone: true
        case .rejected(let status, _, _): status == 501
        case .malformedResponse: false
        }
    }
}
