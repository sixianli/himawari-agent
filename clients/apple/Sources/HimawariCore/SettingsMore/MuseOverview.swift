import Foundation

public struct MuseChannel: Decodable, Sendable, Equatable {
    public let state: String
    public let lastBatchAt: String?
    public let gapCount: Int

    public var isPaused: Bool { state == "paused" }
    public var isDown: Bool { state == "down" }
    public var hasReceived: Bool { state != "never" }
}

public struct MuseDelay: Decodable, Sendable, Equatable {
    public let medianMinutes: Int
    public let samples: Int
}

public struct MuseItem: Decodable, Sendable, Equatable, Identifiable {
    public let kind: String
    public let naturalKey: String
    public let occurredAt: String
    public let title: String?
    public let text: String?
    public let withheld: Bool
    public let timingOk: Bool?
    public let contentOk: Bool?

    public var id: String { "\(kind):\(naturalKey)" }

    public var isRated: Bool { timingOk != nil && contentOk != nil }

    public func rating(timing: Bool?, content: Bool?) -> MuseRating? {
        guard (timing == nil) == (content == nil) else { return nil }
        guard timing != timingOk || content != contentOk else { return nil }
        return MuseRating(kind: kind, naturalKey: naturalKey, timingOk: timing, contentOk: content)
    }
}

public struct MuseOverview: Decodable, Sendable, Equatable {
    public let channel: MuseChannel
    public let receivedWeek: Int
    public let suppressedWeek: Int
    public let pending: Int
    public let delay: MuseDelay?
    public let items: [MuseItem]

    public enum DelayUnit: Sendable, Equatable {
        case minutes
        case hours
    }

    public static func delayParts(minutes: Int) -> (unit: DelayUnit, value: Double) {
        minutes < 120 ? (.minutes, Double(minutes)) : (.hours, (Double(minutes) / 6).rounded() / 10)
    }
}

public struct MuseRating: Encodable, Sendable, Equatable {
    public let kind: String
    public let naturalKey: String
    public let timingOk: Bool?
    public let contentOk: Bool?

    private enum CodingKeys: String, CodingKey {
        case kind, naturalKey, timingOk, contentOk
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(naturalKey, forKey: .naturalKey)
        try container.encode(timingOk, forKey: .timingOk)
        try container.encode(contentOk, forKey: .contentOk)
    }
}

public struct MuseIntakeChange: Encodable, Sendable, Equatable {
    public let paused: Bool

    public init(paused: Bool) {
        self.paused = paused
    }
}
