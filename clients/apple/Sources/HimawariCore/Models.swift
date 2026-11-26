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

public struct PerceptionSenseSwitch: Codable, Sendable, Equatable {
    public let sense: String
    public let enabled: Bool
}

public struct PerceptionSummary: Codable, Sendable, Equatable {
    public let recordTextCharacters: Int?
    public let recordTypes: [String: PerceptionTypeRule]?
    public let state: String?
    public let pausedUntil: String?
    public let senses: [PerceptionSenseSwitch]?
    public let retentionDays: [String: Int]?
    public let mirrorKinds: [String: [String: PerceptionFieldRule]]?

    public init(
        recordTextCharacters: Int? = nil,
        recordTypes: [String: PerceptionTypeRule]? = nil,
        state: String? = nil,
        pausedUntil: String? = nil,
        senses: [PerceptionSenseSwitch]? = nil,
        retentionDays: [String: Int]? = nil,
        mirrorKinds: [String: [String: PerceptionFieldRule]]? = nil
    ) {
        self.recordTextCharacters = recordTextCharacters
        self.recordTypes = recordTypes
        self.state = state
        self.pausedUntil = pausedUntil
        self.senses = senses
        self.retentionDays = retentionDays
        self.mirrorKinds = mirrorKinds
    }
}

public struct ChatModel: Codable, Sendable, Equatable, Identifiable {
    public struct Price: Codable, Sendable, Equatable {
        public let input: Double
        public let output: Double

        public init(input: Double, output: Double) {
            self.input = input
            self.output = output
        }
    }

    public enum PriceTier: String, Codable, Sendable {
        case low
        case mid
        case high
    }

    public let ref: String
    public let name: String
    public let provider: String
    public let thinkingLevels: [String]
    public var automatic: Bool? = nil
    public var price: Price? = nil
    public var priceTier: PriceTier? = nil

    public var id: String { ref }

    public init(ref: String, name: String, provider: String, thinkingLevels: [String], automatic: Bool? = nil, price: Price? = nil, priceTier: PriceTier? = nil) {
        self.ref = ref
        self.name = name
        self.provider = provider
        self.thinkingLevels = thinkingLevels
        self.automatic = automatic
        self.price = price
        self.priceTier = priceTier
    }

    public var defaultThinkingLevel: String? {
        ["medium", "low"].first(where: thinkingLevels.contains)
            ?? thinkingLevels.first(where: { $0 != "off" })
            ?? thinkingLevels.first
    }
}

public struct ChatModels: Codable, Sendable, Equatable {
    public let defaultRef: String
    public let options: [ChatModel]

    public init(defaultRef: String, options: [ChatModel]) {
        self.defaultRef = defaultRef
        self.options = options
    }
}

public struct DeviceConfiguration: Codable, Sendable, Equatable {
    public let heartbeatSeconds: Int
    public let connectionMaxSeconds: Int
    public let signatureToleranceSeconds: Int
    public let limits: [DeviceLimit]
    public let streamConnections: Int?
    public let attachments: AttachmentLimits?
    public let perception: PerceptionSummary?
    public var chatModels: ChatModels? = nil

    public var acceptsChatAttachments: Bool { attachments != nil }

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
    public var options: MessageOptions? = nil
    public var chosenFrom: ChosenOption? = nil
    public var id: String { messageId }
}

extension ThreadMessage {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try container.decode(String.self, forKey: .messageId)
        sequence = try container.decode(Int.self, forKey: .sequence)
        role = try container.decode(MessageRole.self, forKey: .role)
        contentRef = try container.decode(String.self, forKey: .contentRef)
        status = try container.decode(MessageStatus.self, forKey: .status)
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId)
        runId = try container.decodeIfPresent(String.self, forKey: .runId)
        committedAt = try container.decode(String.self, forKey: .committedAt)
        options = try? container.decodeIfPresent(MessageOptions.self, forKey: .options)
        chosenFrom = try? container.decodeIfPresent(ChosenOption.self, forKey: .chosenFrom)
    }
}

public struct ChosenOption: Codable, Sendable, Equatable {
    public let setId: String
    public let optionId: String
}

public struct MessageOptions: Codable, Sendable, Equatable {
    public static let dismissId = "dismiss"

    public enum State: String, Codable, Sendable {
        case open
        case chosen
        case stale

        public init(from decoder: any Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .stale
        }
    }

    public struct Action: Codable, Sendable, Equatable {
        public let tool: String
        public let summary: String
    }

    public struct Item: Codable, Sendable, Equatable, Identifiable {
        public let optionId: String
        public let label: String
        public let reason: String?
        public let action: Action?
        public let state: State
        public var id: String { optionId }
        public var isDismiss: Bool { optionId == MessageOptions.dismissId }
        public var isOpen: Bool { state == .open }
    }

    public let setId: String
    public let items: [Item]

    public func choiceKey(threadId: String, messageId: String, item: Item) -> String? {
        guard item.action != nil else { return nil }
        let digest = Hashing.sha256(Data([threadId, messageId, setId, item.optionId].joined(separator: "\n").utf8))
        return "device-option-" + digest.map { String(format: "%02x", $0) }.joined()
    }
}

public struct ThreadRunSummary: Codable, Sendable, Equatable {
    public let runId: String
    public let revision: Int
    public let status: String

    public static let workingStates: Set<String> = ["accepted", "building_context", "running", "reconciling_external_result"]

    public var isWorking: Bool { Self.workingStates.contains(status) }
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
    public var emittedAt: String? = nil
}
