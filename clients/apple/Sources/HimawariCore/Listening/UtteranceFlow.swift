import Foundation

public struct SpokenRequestPolicy: Sendable, Equatable {
    public let partialInterval: TimeInterval
    public let partialMinimumCharacters: Int
    public let followUpSeconds: TimeInterval

    public init(partialInterval: TimeInterval, partialMinimumCharacters: Int, followUpSeconds: TimeInterval) {
        self.partialInterval = partialInterval
        self.partialMinimumCharacters = partialMinimumCharacters
        self.followUpSeconds = followUpSeconds
    }

    public static let designed = SpokenRequestPolicy(partialInterval: 0.4, partialMinimumCharacters: 2, followUpSeconds: 8)
}

public enum UtteranceStart: Sendable, Equatable {
    case heard
    case ownerTouched
}

public enum UtteranceStep: Sendable, Equatable {
    case heardName
    case prepare(utteranceId: String, text: String)
}

public struct HeardSpeech: Sendable, Equatable {
    public let text: String
    public let startedAt: Date
    public let duration: TimeInterval
    public let language: String?
    public let confidence: Double
    public let source: AudioInputRoute
    public let ownerScore: Int?

    public init(text: String, startedAt: Date, duration: TimeInterval, language: String?, confidence: Double, source: AudioInputRoute, ownerScore: Int?) {
        self.text = text
        self.startedAt = startedAt
        self.duration = duration
        self.language = language
        self.confidence = confidence
        self.source = source
        self.ownerScore = ownerScore
    }
}

public enum UtteranceResult: Sendable, Equatable {
    case command(request: String, heard: HeardUtterance, touched: Bool, heardName: String?)
    case calledOnly(HeardUtterance)
    case record(HeardUtterance)
    case nothing
}

private struct CalledName: Sendable, Equatable {
    let name: String
    let text: String
}

public struct UtteranceFlow: Sendable, Equatable {
    public let names: NameCall
    public let policy: SpokenRequestPolicy
    public private(set) var utteranceId: String = HeardUtterance.newUtteranceId()
    private var start: UtteranceStart = .heard
    private var followsName = false
    private var nameAnnounced = false
    private var lastSent: String?
    private var lastSentAt: Date?
    private var awaitingRequestUntil: Date?
    private var calledName: CalledName?

    public init(names: NameCall, policy: SpokenRequestPolicy = .designed) {
        self.names = names
        self.policy = policy
    }

    public mutating func begin(_ start: UtteranceStart, at now: Date, utteranceId: String = HeardUtterance.newUtteranceId()) {
        self.utteranceId = utteranceId
        self.start = start
        followsName = start == .heard && (awaitingRequestUntil.map { now <= $0 } ?? false)
        if !followsName { calledName = nil }
        awaitingRequestUntil = nil
        nameAnnounced = followsName
        lastSent = nil
        lastSentAt = nil
    }

    public var isCommandCandidate: Bool {
        start == .ownerTouched || followsName || nameAnnounced
    }

    public mutating func partial(_ text: String, at now: Date) -> [UtteranceStep] {
        guard let request = request(in: text) else { return [] }
        var steps: [UtteranceStep] = []
        if start == .heard && !nameAnnounced {
            nameAnnounced = true
            steps.append(.heardName)
        }
        guard request.saysMore, request.text.count >= policy.partialMinimumCharacters, request.text != lastSent else { return steps }
        if let lastSentAt, now.timeIntervalSince(lastSentAt) < policy.partialInterval { return steps }
        lastSent = request.text
        lastSentAt = now
        steps.append(.prepare(utteranceId: utteranceId, text: request.text))
        return steps
    }

    public mutating func finish(_ speech: HeardSpeech, mode: ListeningMode, at now: Date) -> UtteranceResult {
        let heard = HeardUtterance(
            utteranceId: utteranceId,
            text: speech.text,
            startedAt: speech.startedAt,
            duration: speech.duration,
            language: speech.language,
            confidence: speech.confidence,
            source: speech.source,
            speaker: speech.ownerScore.map { HeardSpeaker(kind: .owner, score: $0) } ?? HeardSpeaker(kind: .unknown, score: nil)
        )
        defer { utteranceId = HeardUtterance.newUtteranceId() }
        if let request = request(in: speech.text) {
            if request.saysMore {
                return .command(request: request.text, heard: heard, touched: start == .ownerTouched, heardName: request.name)
            }
            if start == .heard && !followsName {
                awaitingRequestUntil = now.addingTimeInterval(policy.followUpSeconds)
                calledName = request.name.map { CalledName(name: $0, text: speech.text.trimmingCharacters(in: .whitespacesAndNewlines)) }
                return .calledOnly(heard)
            }
        }
        guard mode == .full, !speech.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .nothing }
        return .record(heard)
    }

    private func request(in text: String) -> (text: String, name: String?, saysMore: Bool)? {
        if start == .ownerTouched || followsName {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if start == .heard, let calledName {
                return ("\(calledName.text)\n\(trimmed)", calledName.name, !trimmed.isEmpty)
            }
            return (trimmed, nil, !trimmed.isEmpty)
        }
        return names.match(text).map { ($0.text, $0.name, $0.saysMoreThanTheName) }
    }
}
