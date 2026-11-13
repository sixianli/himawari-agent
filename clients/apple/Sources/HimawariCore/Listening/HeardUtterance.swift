import Foundation

public enum SpeakerKind: String, Codable, Sendable {
    case owner
    case contact
    case unknown
}

public struct HeardSpeaker: Codable, Sendable, Equatable {
    public let kind: SpeakerKind
    public let score: Int?

    public init(kind: SpeakerKind, score: Int?) {
        self.kind = kind
        self.score = score.map(VoiceScore.clamp)
    }
}

public enum Transcriber: String, Codable, Sendable {
    case device
    case server
    case thirdParty = "third_party"
}

public struct HeardUtterance: Sendable, Equatable {
    public let utteranceId: String
    public let text: String
    public let startedAt: Date
    public let duration: TimeInterval
    public let language: String?
    public let confidence: Double
    public let source: AudioInputRoute
    public let speaker: HeardSpeaker?

    public init(utteranceId: String, text: String, startedAt: Date, duration: TimeInterval, language: String?, confidence: Double, source: AudioInputRoute, speaker: HeardSpeaker?) {
        self.utteranceId = utteranceId
        self.text = text
        self.startedAt = startedAt
        self.duration = duration
        self.language = language
        self.confidence = confidence
        self.source = source
        self.speaker = speaker
    }

    public static func newUtteranceId() -> String {
        RandomToken.base64URL(byteCount: 16)
    }
}

public struct SpeechUtteranceUpload: Codable, Sendable, Equatable {
    public struct Evidence: Codable, Sendable, Equatable {
        public let durationMs: Int
        public let language: String?
        public let utteranceId: String
        public let transcriber: Transcriber
    }

    public let id: String
    public let type: String
    public let captureSource: String
    public let occurredAt: String
    public let confidence: Int
    public let text: String
    public let speaker: HeardSpeaker?
    public let evidence: Evidence

    public static let maximumDurationMs = 3_600_000
    public static let languageLimit = 16

    public init(_ heard: HeardUtterance, textLimit: Int?) {
        id = "perception:\(heard.utteranceId)"
        type = "speech.utterance"
        captureSource = heard.source.rawValue
        occurredAt = Self.timestamp(heard.startedAt)
        confidence = VoiceScore.fromUnit(heard.confidence)
        if let textLimit, heard.text.count > textLimit {
            text = String(heard.text.prefix(textLimit))
        } else {
            text = heard.text
        }
        speaker = heard.speaker
        evidence = Evidence(
            durationMs: min(max(Int((heard.duration * 1000).rounded()), 0), Self.maximumDurationMs),
            language: heard.language.map { String($0.prefix(Self.languageLimit)) },
            utteranceId: heard.utteranceId,
            transcriber: .device
        )
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}

public enum HeardOutcome: String, Codable, Sendable {
    case stored
    case duplicate
    case limitReached = "limit_reached"
    case senseOff = "sense_off"
    case paused
}

public struct HeardUploadResult: Sendable, Equatable {
    public let outcomes: [String: HeardOutcome]
    public let reached: [String]

    public init(outcomes: [String: HeardOutcome], reached: [String]) {
        self.outcomes = outcomes
        self.reached = reached
    }

    public static let audioLimitKey = "perception.audio.daily"

    public var audioLimitReached: Bool {
        reached.contains(Self.audioLimitKey)
    }

    public var refusal: ListeningStopReason? {
        let values = Set(outcomes.values)
        if values.contains(.senseOff) { return .senseOff }
        if values.contains(.paused) { return .paused }
        if audioLimitReached { return .dailyAudioLimit }
        return nil
    }
}

extension DeviceAPI {
    public func upload(heard: [SpeechUtteranceUpload]) async throws -> HeardUploadResult {
        struct Body: Encodable { let records: [SpeechUtteranceUpload] }
        struct Item: Decodable {
            let id: String
            let outcome: HeardOutcome
        }
        struct Result: Decodable {
            let outcomes: [Item]
            let reached: [String]?
        }
        let data = try await http.send(DeviceRequest(method: "POST", path: "perception", body: try JSONEncoder().encode(Body(records: heard))))
        let result = try decode(Result.self, data)
        return HeardUploadResult(
            outcomes: Dictionary(result.outcomes.map { ($0.id, $0.outcome) }, uniquingKeysWith: { first, _ in first }),
            reached: result.reached ?? []
        )
    }
}
