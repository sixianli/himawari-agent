import Foundation

private struct GatewayEnvelopeOf<Payload: Decodable>: Decodable {
    let payload: Payload
}

private func gatewayPayload<Payload: Decodable>(_ type: Payload.Type, from data: Data) throws -> Payload {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom(DeviceAPI.timestamp)
    return try decoder.decode(GatewayEnvelopeOf<Payload>.self, from: data).payload
}

public enum SpokenRating: String, Codable, Sendable, CaseIterable, Identifiable {
    case useful
    case unneeded

    public var id: String { rawValue }
}

public struct SpokenExplanation: Decodable, Sendable, Equatable {
    public struct Cause: Decodable, Sendable, Equatable {
        public enum Kind: Equatable, Sendable {
            case mail
            case reminder
            case memory
            case timer
            case perception
            case subthread
            case other

            init(_ raw: String) {
                switch raw {
                case "mail": self = .mail
                case "reminder": self = .reminder
                case "memory_saved": self = .memory
                case "timer": self = .timer
                case "perception_episode": self = .perception
                case "subthread", "result_board", "subthread_continue": self = .subthread
                default: self = .other
                }
            }
        }

        public let kind: Kind
        public let at: Date
        public let summary: String?
        public let memoryId: String?

        enum CodingKeys: String, CodingKey { case kind, at, summary, memoryId }

        public init(kind: Kind, at: Date, summary: String?, memoryId: String?) {
            self.kind = kind
            self.at = at
            self.summary = summary
            self.memoryId = memoryId
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = Kind(try container.decode(String.self, forKey: .kind))
            at = try container.decode(Date.self, forKey: .at)
            summary = try container.decodeIfPresent(String.self, forKey: .summary)
            memoryId = try container.decodeIfPresent(String.self, forKey: .memoryId)
        }
    }

    public struct Decision: Decodable, Sendable, Equatable, Identifiable {
        public let decisionId: String
        public let decidedAt: Date
        public let pushed: Bool
        public let reason: String?
        public let cause: Cause
        public var id: String { decisionId }

        public init(decisionId: String, decidedAt: Date, pushed: Bool, reason: String?, cause: Cause) {
            self.decisionId = decisionId
            self.decidedAt = decidedAt
            self.pushed = pushed
            self.reason = reason
            self.cause = cause
        }
    }

    public let messageId: String
    public var rating: SpokenRating?
    public let decisions: [Decision]

    public init(messageId: String, rating: SpokenRating?, decisions: [Decision]) {
        self.messageId = messageId
        self.rating = rating
        self.decisions = decisions
    }

    public var reasons: [String] {
        var seen = Set<String>()
        return decisions.compactMap(\.reason).filter { seen.insert($0).inserted }
    }

    public static func decode(_ data: Data) throws -> SpokenExplanation {
        try gatewayPayload(SpokenExplanation.self, from: data)
    }
}

public enum StatsSpan: String, Codable, Sendable, CaseIterable, Identifiable {
    case week
    case fourWeeks = "four_weeks"

    public var id: String { rawValue }
}

public enum StatsTrend: Equatable, Sendable {
    case up
    case down
    case same
}

public enum StatsRate: Equatable, Sendable {
    case value(Double, rated: Int, of: Int)
    case tooFew(Int)
}

public struct DecisionStats: Decodable, Sendable, Equatable {
    public struct Period: Decodable, Sendable, Equatable {
        public let start: Date
        public let end: Date
        public let spoken: Int
        public let rated: Int
        public let useful: Int
        public let unneeded: Int

        public init(start: Date, end: Date, spoken: Int, rated: Int, useful: Int, unneeded: Int) {
            self.start = start
            self.end = end
            self.spoken = spoken
            self.rated = rated
            self.useful = useful
            self.unneeded = unneeded
        }
    }

    public struct Recall: Decodable, Sendable, Equatable {
        public let at: Date
        public let correct: Int
        public let asked: Int

        public init(at: Date, correct: Int, asked: Int) {
            self.at = at
            self.correct = correct
            self.asked = asked
        }

        public var share: Double { Double(correct) / Double(max(asked, 1)) }
    }

    public let span: StatsSpan
    public let minimumSamples: Int
    public let current: Period
    public let previous: Period
    public let recall: Recall?
    public let previousRecall: Recall?

    public init(span: StatsSpan, minimumSamples: Int, current: Period, previous: Period, recall: Recall?, previousRecall: Recall?) {
        self.span = span
        self.minimumSamples = minimumSamples
        self.current = current
        self.previous = previous
        self.recall = recall
        self.previousRecall = previousRecall
    }

    public static func decode(_ data: Data) throws -> DecisionStats {
        try gatewayPayload(DecisionStats.self, from: data)
    }

    public func rate(_ rating: SpokenRating, in period: Period? = nil) -> StatsRate {
        let period = period ?? current
        guard period.rated >= minimumSamples else { return .tooFew(period.rated) }
        let count = rating == .useful ? period.useful : period.unneeded
        return .value(Double(count) / Double(period.rated), rated: period.rated, of: period.spoken)
    }

    public var spokenTrend: StatsTrend? { Self.trend(Double(current.spoken), Double(previous.spoken)) }

    public func rateTrend(_ rating: SpokenRating) -> StatsTrend? {
        guard case .value(let now, _, _) = rate(rating), case .value(let before, _, _) = rate(rating, in: previous) else { return nil }
        return Self.trend(now, before)
    }

    public var recallTrend: StatsTrend? {
        guard let recall, let previousRecall else { return nil }
        return Self.trend(recall.share, previousRecall.share)
    }

    static func trend(_ now: Double, _ before: Double) -> StatsTrend {
        if abs(now - before) < 0.000_001 { return .same }
        return now > before ? .up : .down
    }
}

public struct OwnerFile: Decodable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Decodable, Sendable, CaseIterable, Identifiable {
        case document
        case code
        case web
        case image
        case pdf
        case data
        case other

        public var id: String { rawValue }

        public init(from decoder: any Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }
    }

    public enum Origin: String, Decodable, Sendable {
        case uploaded
        case generated
    }

    public let fileId: String
    public let threadId: String
    public let threadTitle: String?
    public let name: String
    public let kind: Kind
    public let origin: Origin
    public let mediaType: String
    public let sizeBytes: Int
    public let version: Int
    public let createdAt: Date
    public let deleted: Bool
    public let contentPath: String?
    public var id: String { fileId }

    public init(fileId: String, threadId: String, threadTitle: String?, name: String, kind: Kind, origin: Origin, mediaType: String, sizeBytes: Int, version: Int, createdAt: Date, deleted: Bool = false, contentPath: String? = "x") {
        self.fileId = fileId
        self.threadId = threadId
        self.threadTitle = threadTitle
        self.name = name
        self.kind = kind
        self.origin = origin
        self.mediaType = mediaType
        self.sizeBytes = sizeBytes
        self.version = version
        self.createdAt = createdAt
        self.deleted = deleted
        self.contentPath = contentPath
    }

    public var canOpen: Bool { !deleted && contentPath != nil }
}

public struct OwnerFilePage: Decodable, Sendable, Equatable {
    public static let pageLimit = 100

    public let files: [OwnerFile]
    public let nextCursor: String?

    public init(files: [OwnerFile], nextCursor: String?) {
        self.files = files
        self.nextCursor = nextCursor
    }

    public static func decode(_ data: Data) throws -> OwnerFilePage {
        try gatewayPayload(OwnerFilePage.self, from: data)
    }
}

public enum OwnerFileFilter: Hashable, Sendable, Identifiable {
    case all
    case kind(OwnerFile.Kind)
    case uploaded

    public var id: String {
        switch self {
        case .all: "all"
        case .kind(let kind): kind.rawValue
        case .uploaded: "uploaded"
        }
    }

    public static var choices: [OwnerFileFilter] { [.all] + OwnerFile.Kind.allCases.map { .kind($0) } + [.uploaded] }

    public var payload: (kind: String?, origin: String?) {
        switch self {
        case .all: (nil, nil)
        case .kind(let kind): (kind.rawValue, nil)
        case .uploaded: (nil, OwnerFile.Origin.uploaded.rawValue)
        }
    }

    public static func matching(_ files: [OwnerFile], search: String) -> [OwnerFile] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return files }
        return files.filter { $0.name.localizedStandardContains(needle) }
    }
}
