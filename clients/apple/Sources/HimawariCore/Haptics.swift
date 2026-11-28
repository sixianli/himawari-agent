import Foundation

public enum HapticEvent: String, CaseIterable, Sendable {
    case messageSent
    case sheetSettled
    case stopPressed
    case faceIDSucceeded
    case faceIDFailed
    case pairingSucceeded
    case approvalNeeded
    case approvalNeededWeighty
    case longTaskFinished
    case taskFailed
    case heardName
    case listeningStarted
    case listeningStopped
    case copied

    public var source: HapticSource {
        switch self {
        case .messageSent, .sheetSettled, .stopPressed, .faceIDSucceeded, .faceIDFailed, .pairingSucceeded, .copied:
            .owner
        case .approvalNeeded, .approvalNeededWeighty, .longTaskFinished, .taskFailed, .heardName, .listeningStarted, .listeningStopped:
            .himawari
        }
    }

    public var pattern: HapticPattern {
        switch self {
        case .messageSent, .listeningStopped: .impactLight
        case .listeningStarted: .impactMedium
        case .sheetSettled, .heardName: .impactSoft
        case .stopPressed: .impactRigid
        case .faceIDSucceeded, .longTaskFinished, .copied: .success
        case .faceIDFailed: .error
        case .pairingSucceeded: .bloom
        case .approvalNeeded: .knock
        case .approvalNeededWeighty: .knockFirm
        case .taskFailed: .warning
        }
    }

    public var isApproval: Bool {
        self == .approvalNeeded || self == .approvalNeededWeighty
    }

    public var isListeningChange: Bool {
        self == .listeningStarted || self == .listeningStopped
    }

    public var firesWhileRecording: Bool {
        self == .listeningStarted
    }
}

public enum HapticSource: Sendable {
    case owner
    case himawari
}

public enum HapticPattern: String, Sendable {
    case impactLight
    case impactMedium
    case impactSoft
    case impactRigid
    case success
    case error
    case warning
    case bloom
    case knock
    case knockFirm
}

public enum HapticLevel: String, CaseIterable, Codable, Sendable {
    case all
    case essential
    case off
}

public struct HapticSituation: Sendable {
    public var level: HapticLevel
    public var systemHapticsEnabled: Bool
    public var recording: Bool
    public var ownerViewingThisPage: Bool
    public var waitedSeconds: TimeInterval
    public var quietTime: Bool
    public var watchTakesHimawariEvents: Bool

    public init(
        level: HapticLevel = .all,
        systemHapticsEnabled: Bool = true,
        recording: Bool = false,
        ownerViewingThisPage: Bool = false,
        waitedSeconds: TimeInterval = 0,
        quietTime: Bool = false,
        watchTakesHimawariEvents: Bool = false
    ) {
        self.level = level
        self.systemHapticsEnabled = systemHapticsEnabled
        self.recording = recording
        self.ownerViewingThisPage = ownerViewingThisPage
        self.waitedSeconds = waitedSeconds
        self.quietTime = quietTime
        self.watchTakesHimawariEvents = watchTakesHimawariEvents
    }
}

public struct HapticSettings: Codable, Sendable, Equatable {
    public var level: HapticLevel
    public var finishedAfterSeconds: TimeInterval
    public var repeatWindowSeconds: TimeInterval

    public init(level: HapticLevel = .all, finishedAfterSeconds: TimeInterval = 10, repeatWindowSeconds: TimeInterval = 3) {
        self.level = level
        self.finishedAfterSeconds = finishedAfterSeconds
        self.repeatWindowSeconds = repeatWindowSeconds
    }
}

public struct HapticPolicy: Sendable {
    public private(set) var settings: HapticSettings
    private var lastFired: [HapticEvent: Date] = [:]

    public init(settings: HapticSettings = HapticSettings()) {
        self.settings = settings
    }

    public mutating func update(_ settings: HapticSettings) {
        self.settings = settings
    }

    public mutating func decide(_ event: HapticEvent, in situation: HapticSituation, at now: Date) -> HapticPattern? {
        guard situation.systemHapticsEnabled else { return nil }
        switch situation.level {
        case .off:
            return nil
        case .essential:
            guard event.isApproval || event.isListeningChange else { return nil }
        case .all:
            break
        }
        if situation.recording && !event.firesWhileRecording { return nil }
        if event.source == .himawari {
            if situation.watchTakesHimawariEvents { return nil }
            if situation.quietTime && !event.isApproval { return nil }
            if situation.ownerViewingThisPage && !event.isApproval {
                guard event == .longTaskFinished, situation.waitedSeconds > settings.finishedAfterSeconds else { return nil }
            }
        }
        if let last = lastFired[event], now.timeIntervalSince(last) < settings.repeatWindowSeconds { return nil }
        lastFired[event] = now
        return event.pattern
    }
}
