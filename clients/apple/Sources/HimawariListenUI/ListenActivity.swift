import Foundation
import HimawariCore
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import AppIntents
#endif

public enum ListenPhase: String, Codable, Hashable, Sendable {
    case listening
    case paused
    case calling
    case asking
}

public struct ListenLiveState: Codable, Hashable, Sendable {
    public var phase: ListenPhase
    public var startedAt: Date
    public var source: String
    public var heard: String
    public var heardTail: String
    public var askReason: String?
    public var nameOnly: Bool

    public init(phase: ListenPhase, startedAt: Date, source: AudioInputRoute, heard: String = "", heardTail: String = "", askReason: SpokenCommandRefusal? = nil, nameOnly: Bool = false) {
        self.phase = phase
        self.startedAt = startedAt
        self.source = source.rawValue
        self.heard = heard
        self.heardTail = heardTail
        self.askReason = askReason?.rawValue
        self.nameOnly = nameOnly
    }

    public var route: AudioInputRoute {
        AudioInputRoute(rawValue: source) ?? .deviceMicrophone
    }

    public var refusal: SpokenCommandRefusal? {
        askReason.flatMap(SpokenCommandRefusal.init(rawValue:))
    }
}

public enum ListenCommand: String, Sendable {
    case pause
    case stop
    case resume
    case notMe
    case itsMe
    case openRecordingKit
}

@MainActor
public final class ListenCommandCenter {
    public static let shared = ListenCommandCenter()

    public var handler: (@MainActor (ListenCommand) async -> Void)? {
        didSet { deliverPending() }
    }

    private var pending: ListenCommand?

    private init() {}

    public func perform(_ command: ListenCommand) async {
        guard let handler else {
            if command == .openRecordingKit { pending = command }
            return
        }
        await handler(command)
    }

    private func deliverPending() {
        guard let handler, let command = pending else { return }
        pending = nil
        Task { await handler(command) }
    }
}

#if canImport(ActivityKit) && os(iOS)
public struct ListenActivityAttributes: ActivityAttributes {
    public typealias ContentState = ListenLiveState

    public init() {}
}

public struct PauseListeningIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Pause listening"
    public static let isDiscoverable = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        await ListenCommandCenter.shared.perform(.pause)
        return .result()
    }
}

public struct StopListeningIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Stop listening"
    public static let isDiscoverable = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        await ListenCommandCenter.shared.perform(.stop)
        return .result()
    }
}

public struct ResumeListeningIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Resume listening"
    public static let isDiscoverable = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        await ListenCommandCenter.shared.perform(.resume)
        return .result()
    }
}

public struct NotMeIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Not me"
    public static let isDiscoverable = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        await ListenCommandCenter.shared.perform(.notMe)
        return .result()
    }
}

public struct ItsMeIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "It's me, go ahead"
    public static let isDiscoverable = false
    public static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    public init() {}

    public func perform() async throws -> some IntentResult {
        await ListenCommandCenter.shared.perform(.itsMe)
        return .result()
    }
}

public struct OpenListenRecordingKitIntent: AppIntent {
    public static let title: LocalizedStringResource = "Record listening samples"
    public static let description = IntentDescription("Opens the recording kit for the listening evaluation.")
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ListenCommandCenter.shared.perform(.openRecordingKit)
        return .result()
    }
}

public struct HimawariListenIntents: AppIntentsPackage {}
#endif
