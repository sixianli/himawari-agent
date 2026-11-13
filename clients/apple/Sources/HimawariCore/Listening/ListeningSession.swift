import Foundation

public enum ListeningMode: String, Codable, Sendable, Equatable {
    case full
    case nameOnly
}

public enum ListeningStopReason: String, Codable, Sendable, Equatable {
    case owner
    case dailyAudioLimit
    case senseOff
    case paused
}

public enum ListeningDowngradeReason: String, Codable, Sendable, Equatable {
    case batteryLow
    case deviceHot
    case batteryBudget
}

public enum ListeningState: Sendable, Equatable {
    case off
    case listening(since: Date, mode: ListeningMode, downgrade: ListeningDowngradeReason?)
    case interrupted(since: Date, listeningSince: Date, mode: ListeningMode)
    case waitingForOwner(since: Date)
    case stopped(ListeningStopReason, at: Date, resumesAt: Date?)
}

public enum ListeningNotice: Sendable, Equatable {
    case pausedTapToContinue
    case stopped(ListeningStopReason, resumesAt: Date?)
    case downgraded(ListeningDowngradeReason)
    case restored
}

public enum ListeningEvent: Sendable, Equatable {
    case ownerStarted(at: Date)
    case ownerStopped(at: Date)
    case interruptionBegan(at: Date)
    case interruptionEnded(at: Date, systemSuggestsResume: Bool)
    case resumeFailed(at: Date)
    case audioLimitReached(at: Date, resumesAt: Date)
    case serverRefused(ListeningStopReason, at: Date, resumesAt: Date?)
    case power(batteryPercent: Int?, charging: Bool, hot: Bool, budgetSpent: Bool = false)
}

public struct ListeningPolicy: Sendable, Equatable {
    public let batteryFloorPercent: Int

    public init(batteryFloorPercent: Int) {
        self.batteryFloorPercent = batteryFloorPercent
    }

    public static let designed = ListeningPolicy(batteryFloorPercent: 20)
}

public struct ListeningTransition: Sendable, Equatable {
    public let state: ListeningState
    public let notice: ListeningNotice?
    public let haptic: HapticEvent?
    public let microphoneOn: Bool
}

public struct ListeningSession: Sendable, Equatable {
    public private(set) var state: ListeningState = .off
    public let policy: ListeningPolicy

    public init(policy: ListeningPolicy = .designed) {
        self.policy = policy
    }

    public func elapsed(at now: Date) -> TimeInterval? {
        switch state {
        case let .listening(since, _, _): max(0, now.timeIntervalSince(since))
        case let .interrupted(_, listeningSince, _): max(0, now.timeIntervalSince(listeningSince))
        default: nil
        }
    }

    public var isCapturing: Bool {
        if case .listening = state { return true }
        return false
    }

    @discardableResult
    public mutating func handle(_ event: ListeningEvent) -> ListeningTransition {
        var notice: ListeningNotice?
        var haptic: HapticEvent?
        switch (state, event) {
        case let (.off, .ownerStarted(at)), let (.stopped, .ownerStarted(at)), let (.waitingForOwner, .ownerStarted(at)):
            state = .listening(since: at, mode: .full, downgrade: nil)
            haptic = .listeningStarted
        case let (.listening, .ownerStopped(at)), let (.interrupted, .ownerStopped(at)), let (.waitingForOwner, .ownerStopped(at)):
            state = .stopped(.owner, at: at, resumesAt: nil)
            haptic = .listeningStopped
        case let (.listening(since, mode, _), .interruptionBegan(at)):
            state = .interrupted(since: at, listeningSince: since, mode: mode)
        case let (.interrupted(_, listeningSince, mode), .interruptionEnded(_, true)):
            state = .listening(since: listeningSince, mode: mode, downgrade: nil)
        case let (.interrupted, .interruptionEnded(at, false)), let (.interrupted, .resumeFailed(at)):
            state = .waitingForOwner(since: at)
            notice = .pausedTapToContinue
        case let (.listening, .audioLimitReached(at, resumesAt)), let (.interrupted, .audioLimitReached(at, resumesAt)):
            state = .stopped(.dailyAudioLimit, at: at, resumesAt: resumesAt)
            notice = .stopped(.dailyAudioLimit, resumesAt: resumesAt)
            haptic = .listeningStopped
        case let (.listening, .serverRefused(reason, at, resumesAt)), let (.interrupted, .serverRefused(reason, at, resumesAt)):
            state = .stopped(reason, at: at, resumesAt: resumesAt)
            notice = .stopped(reason, resumesAt: resumesAt)
            haptic = .listeningStopped
        case let (.listening(since, _, current), .power(battery, charging, hot, budgetSpent)):
            let wanted: ListeningDowngradeReason? = if hot {
                .deviceHot
            } else if !charging && (battery.map { $0 < policy.batteryFloorPercent } ?? false) {
                .batteryLow
            } else if budgetSpent {
                .batteryBudget
            } else {
                nil
            }
            if wanted != current {
                state = .listening(since: since, mode: wanted == nil ? .full : .nameOnly, downgrade: wanted)
                notice = wanted.map(ListeningNotice.downgraded) ?? .restored
            }
        default:
            break
        }
        return ListeningTransition(state: state, notice: notice, haptic: haptic, microphoneOn: isCapturing)
    }
}

public enum CommandTriggerContext: Sendable, Equatable {
    case ownerTouched
    case heardName(route: AudioInputRoute, inEar: Bool?, loudnessScore: Int?)
}

public enum SpokenTrigger {
    public static func evidence(for context: CommandTriggerContext, speakerScore: Int?, heardName: String? = nil) -> VoiceEvidence {
        switch context {
        case .ownerTouched:
            VoiceEvidence(trigger: .handsOn, speakerScore: speakerScore)
        case let .heardName(.airpods, inEar, loudness):
            VoiceEvidence(trigger: .airpodsName, speakerScore: speakerScore, inputRoute: .airpods, inEar: inEar, loudnessScore: loudness, heardName: heardName)
        case let .heardName(route, _, loudness):
            VoiceEvidence(trigger: .ambientName, speakerScore: speakerScore, inputRoute: route, loudnessScore: loudness, heardName: heardName)
        }
    }
}
