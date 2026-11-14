import Foundation

public enum DeviceKind: String, Codable, Sendable {
    case iphone
    case watch
    case mac
    case unrecognized
}

public enum ReleaseChannel: String, Codable, Sendable, CaseIterable {
    case direct
    case testflight
    case appStore = "app_store"
    case macDirect = "mac_direct"
    case unrecognized
}

public enum PairedDeviceStatus: String, Codable, Sendable {
    case pending
    case active
    case revoked
    case unrecognized
}

public struct PairedDeviceInfo: Codable, Sendable, Equatable {
    public let id: String
    public let revision: Int
    public let kind: DeviceKind
    public let name: String
    public let releaseChannel: ReleaseChannel
    public let status: PairedDeviceStatus
    public let pairingNumber: String?
}

public struct DeviceLimit: Codable, Sendable, Equatable, Identifiable {
    public let key: String
    public let unit: String
    public let value: Int64
    public let defaultValue: Int64
    public let onExceed: String
    public var id: String { key }
}

public struct AttachmentLimits: Codable, Sendable, Equatable {
    public let textCharacters: Int
    public let imageCharacters: Int
    public let perMessage: Int
    public let messageCharacters: Int

    public init(textCharacters: Int, imageCharacters: Int, perMessage: Int, messageCharacters: Int) {
        self.textCharacters = textCharacters
        self.imageCharacters = imageCharacters
        self.perMessage = perMessage
        self.messageCharacters = messageCharacters
    }
}

public struct PerceptionSummary: Codable, Sendable, Equatable {
    public let recordTextCharacters: Int?
    public let recordTypes: [String: PerceptionTypeRule]?
}

public struct DeviceConfiguration: Codable, Sendable, Equatable {
    public let heartbeatSeconds: Int
    public let connectionMaxSeconds: Int
    public let signatureToleranceSeconds: Int
    public let limits: [DeviceLimit]
    public let streamConnections: Int?
    public let attachments: AttachmentLimits?
    public let perception: PerceptionSummary?

    public func limit(_ key: String) -> Int64? {
        limits.first { $0.key == key }?.value
    }
}

public enum ThreadStatus: String, Codable, Sendable {
    case active
    case archived
    case trashed
    case deletionPending = "deletion_pending"
    case deletedVerified = "deleted_verified"
}

public struct ThreadSummary: Codable, Sendable, Equatable, Identifiable {
    public let threadId: String
    public let revision: Int
    public let status: ThreadStatus
    public let titleRef: String?
    public let pinOrder: Int?
    public let answerLocale: String
    public let messageWatermark: Int
    public let createdAt: String
    public let updatedAt: String
    public var id: String { threadId }
}

public enum MessageRole: String, Codable, Sendable {
    case owner
    case agent
    case system
}

public enum MessageStatus: String, Codable, Sendable {
    case committed
    case partial
    case failed
}

public struct ThreadMessage: Codable, Sendable, Equatable, Identifiable {
    public let messageId: String
    public let sequence: Int
    public let role: MessageRole
    public let contentRef: String
    public let status: MessageStatus
    public let turnId: String?
    public let runId: String?
    public let committedAt: String
    public var id: String { messageId }
}

public struct ThreadRunSummary: Codable, Sendable, Equatable {
    public let runId: String
    public let revision: Int
    public let status: String
}

public struct ThreadCollection: Codable, Sendable, Equatable {
    public let threads: [ThreadSummary]
    public let nextCursor: String?
}

public struct ThreadDetail: Codable, Sendable, Equatable {
    public let thread: ThreadSummary
    public let messages: [ThreadMessage]
    public let runs: [ThreadRunSummary]
    public let nextSequence: Int?

    public init(thread: ThreadSummary, messages: [ThreadMessage], runs: [ThreadRunSummary], nextSequence: Int?) {
        self.thread = thread
        self.messages = messages
        self.runs = runs
        self.nextSequence = nextSequence
    }
}

struct GatewayEnvelope<Payload: Decodable>: Decodable {
    let type: String
    let payload: Payload
}

public enum CommandOutcome: Sendable, Equatable {
    case accepted(threadRevision: Int, replayed: Bool)
    case conflict(reasonCode: String, latest: ThreadSummary?)
}

struct CommandResultPayload: Decodable {
    let threadId: String?
    let threadRevision: Int
    let replayed: Bool
}

public struct CreatedThread: Sendable, Equatable {
    public let threadId: String
    public let threadRevision: Int
}

public enum AnswerLocale: String, Codable, Sendable, CaseIterable {
    case chinese = "zh-CN"
    case english = "en"
    case japanese = "ja"

    public static func matching(preferredLanguages: [String]) -> AnswerLocale {
        for language in preferredLanguages {
            let lowered = language.lowercased()
            if lowered.hasPrefix("zh") { return .chinese }
            if lowered.hasPrefix("ja") { return .japanese }
            if lowered.hasPrefix("en") { return .english }
        }
        return .chinese
    }
}

struct ConflictPayload: Decodable {
    let reasonCode: String
    let latest: ThreadSummary?
}

public struct ThreadEvent: Codable, Sendable, Equatable {
    public let eventId: String
    public let threadId: String
    public let revision: Int
    public let cursor: String
    public let eventType: String
    public let payloadRef: String?
    public let occurredAt: String
}

public struct ExecutionText: Codable, Sendable, Equatable {
    public let threadId: String
    public let runId: String
    public let itemId: String
    public let offset: Int
    public let text: String
}
