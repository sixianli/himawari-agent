import Foundation

public struct VoiceTimingRecord: Decodable, Sendable, Equatable, Identifiable {
    public let messageId: String
    public let saidAt: Date
    public let firstTextAt: Date
    public let firstSoundAt: Date?
    public let emittedAt: Date?

    public var id: String { messageId }
    public var textGap: TimeInterval { firstTextAt.timeIntervalSince(saidAt) }
    public var soundGap: TimeInterval? { firstSoundAt.map { $0.timeIntervalSince(firstTextAt) } }

    public init(messageId: String, saidAt: Date, firstTextAt: Date, firstSoundAt: Date?, emittedAt: Date?) {
        self.messageId = messageId
        self.saidAt = saidAt
        self.firstTextAt = firstTextAt
        self.firstSoundAt = firstSoundAt
        self.emittedAt = emittedAt
    }

    private enum CodingKeys: String, CodingKey {
        case messageId, saidAt, firstTextAt, firstSoundAt, emittedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try container.decode(String.self, forKey: .messageId)
        saidAt = try Self.date(container, .saidAt)
        firstTextAt = try Self.date(container, .firstTextAt)
        firstSoundAt = try container.decodeIfPresent(String.self, forKey: .firstSoundAt).map { try Self.parse($0, .firstSoundAt, container) }
        emittedAt = try container.decodeIfPresent(String.self, forKey: .emittedAt).map { try Self.parse($0, .emittedAt, container) }
    }

    private static func date(_ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> Date {
        try parse(try container.decode(String.self, forKey: key), key, container)
    }

    private static func parse(_ text: String, _ key: CodingKeys, _ container: KeyedDecodingContainer<CodingKeys>) throws -> Date {
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle()) { return date }
        throw DecodingError.dataCorruptedError(forKey: key, in: container, debugDescription: "not an ISO 8601 time")
    }
}

public struct VoiceTimingSummary: Sendable, Equatable {
    public static let minimumRounds = 5
    public static let shownRounds = 20

    public struct Spread: Sendable, Equatable {
        public let half: TimeInterval
        public let ninety: TimeInterval
    }

    public let rounds: Int
    public let soundRounds: Int
    public let textGap: Spread?
    public let soundGap: Spread?

    public init(_ records: [VoiceTimingRecord]) {
        rounds = records.count
        soundRounds = records.filter { $0.soundGap != nil }.count
        textGap = Self.spread(records.map(\.textGap))
        soundGap = Self.spread(records.compactMap(\.soundGap))
    }

    public static func atOrBelow(_ share: Double, of values: [TimeInterval]) -> TimeInterval? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let rank = Int((share * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank, 1), sorted.count) - 1]
    }

    private static func spread(_ values: [TimeInterval]) -> Spread? {
        guard values.count >= minimumRounds, let half = atOrBelow(0.5, of: values), let ninety = atOrBelow(0.9, of: values) else { return nil }
        return Spread(half: half, ninety: ninety)
    }
}

extension DeviceAPI {
    public func voiceTimings(limit: Int = VoiceTimingSummary.shownRounds) async throws -> [VoiceTimingRecord] {
        struct Body: Decodable { let items: [VoiceTimingRecord] }
        let data = try await http.send(DeviceRequest(method: "GET", path: "voice-timing", query: [URLQueryItem(name: "limit", value: String(limit))]))
        return try decode(Body.self, data).items.sorted { $0.saidAt > $1.saidAt }
    }
}
