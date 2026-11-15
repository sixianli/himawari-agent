import Foundation

public enum ProactiveRating: String, Sendable, CaseIterable {
    case useful
    case unneeded
    case missed
}

public struct ProactiveQuietPeriod: Decodable, Sendable, Hashable {
    public let days: [Int]
    public let start: String
    public let end: String

    public var sortedDays: [Int] {
        days.sorted { ($0 + 6) % 7 < ($1 + 6) % 7 }
    }

    public var coversEveryDay: Bool { Set(days).count == 7 }
}

public struct ProactiveConnection: Decodable, Sendable, Hashable {
    public let status: String
    public let account: String?
    public let connectedAt: String?
}

public struct ProactiveBackoff: Decodable, Sendable, Hashable, Identifiable {
    public let classKey: String
    public let domain: String
    public let stage: Int
    public let ignoredCount: Int
    public let changedAt: String

    public var id: String { classKey }
}

public struct ProactiveInsight: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let result: String
    public let summary: String
    public let reason: String
    public let from: String
    public let dueAt: String?
    public let priority: String?
    public let status: String
    public let pushed: Bool
    public let pushReaction: String?
    public let rating: String?
    public let updatedAt: String

    public var ownerRating: ProactiveRating? { rating.flatMap(ProactiveRating.init(rawValue:)) }
    public var isOpen: Bool { status == "open" }
}

public struct ProactiveCounts: Decodable, Sendable, Hashable {
    public let fetched: Int
    public let skipped: Int
    public let judged: Int
    public let act: Int
    public let know: Int
    public let check: Int
    public let ignore: Int
    public let floorRaised: Int
    public let pushed: Int
}

public enum ProactiveDecisionLine: Sendable, Equatable {
    case needsOwner
    case pushed(Int)
    case deferred
    case capped
    case cappedDaily
    case modelMalformed
    case modelCutOff
    case modelUnfinished
    case modelNoAnswer
    case readFailed
    case noMail
    case allSkipped(Int)
    case floorRaised(fetched: Int, raised: Int)
    case quiet(fetched: Int, skipped: Int)
}

public struct ProactiveDecision: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let checkedAt: String
    public let verdict: String
    public let reasonCode: String
    public let counts: ProactiveCounts
    public let opened: Bool
    public let rating: String?

    public var ownerRating: ProactiveRating? { rating.flatMap(ProactiveRating.init(rawValue:)) }

    public var rateChoices: [ProactiveRating] {
        switch verdict {
        case "pushed", "deferred": [.useful, .unneeded]
        case "silent": [.missed]
        default: []
        }
    }

    public var line: ProactiveDecisionLine {
        switch verdict {
        case "needs_owner": return .needsOwner
        case "pushed": return .pushed(max(counts.pushed, 1))
        case "deferred": return .deferred
        case "capped": return .capped
        case "capped_daily": return .cappedDaily
        case "failed":
            switch reasonCode {
            case "MODEL_OUTPUT_INVALID": return .modelMalformed
            case "MODEL_OUTPUT_TRUNCATED": return .modelCutOff
            case "MODEL_NOT_COMPLETED": return .modelUnfinished
            case "MODEL_CALL_ERROR": return .modelNoAnswer
            default: return reasonCode.hasPrefix("MODEL_FAILED_") ? .modelNoAnswer : .readFailed
            }
        default:
            if counts.fetched == 0 { return .noMail }
            if counts.skipped == counts.fetched { return .allSkipped(counts.fetched) }
            if counts.floorRaised > 0 { return .floorRaised(fetched: counts.fetched, raised: counts.floorRaised) }
            return .quiet(fetched: counts.fetched, skipped: counts.skipped)
        }
    }

    public var showsJudgedBreakdown: Bool { counts.judged > 0 && verdict != "needs_owner" }
}

public struct ProactiveOverview: Decodable, Sendable, Hashable {
    public let source: String
    public let connection: ProactiveConnection
    public let enabled: Bool
    public let quietHours: [ProactiveQuietPeriod]
    public let importantSenders: [String]
    public let dailyLimitReached: Bool
    public let backoff: [ProactiveBackoff]
    public let insights: [ProactiveInsight]
    public let decisions: [ProactiveDecision]

    public func openInsights(limit: Int) -> [ProactiveInsight] {
        let open = insights.filter(\.isOpen)
        let sorted = open.sorted { left, right in
            switch (ProactiveTime.parse(left.dueAt), ProactiveTime.parse(right.dueAt)) {
            case let (a?, b?) where a != b: return a < b
            case (_?, nil): return true
            case (nil, _?): return false
            default: return (ProactiveTime.parse(left.updatedAt) ?? .distantPast) > (ProactiveTime.parse(right.updatedAt) ?? .distantPast)
            }
        }
        return Array(sorted.prefix(limit))
    }

    public func recentDecisions(limit: Int) -> [ProactiveDecision] {
        let sorted = decisions.sorted {
            (ProactiveTime.parse($0.checkedAt) ?? .distantPast) > (ProactiveTime.parse($1.checkedAt) ?? .distantPast)
        }
        return Array(sorted.prefix(limit))
    }
}

public enum ProactiveTime {
    public static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

public struct ProactiveDayLimit: Decodable, Sendable, Hashable {
    public let limit: Int
    public let defaultLimit: Int
    public let minimum: Int
    public let maximum: Int
    public let used: Int?
    public let resetsAt: String?

    public var step: Int {
        let spread = maximum.subtractingReportingOverflow(minimum)
        let span = spread.overflow ? 1_000_000_000 : min(max(1, spread.partialValue), 1_000_000_000)
        var step = 1
        while span / (step * 10) >= 20 { step *= 10 }
        return step
    }

    public func clamped(_ value: Int) -> Int { min(maximum, max(minimum, value)) }
    public func stepUp(from value: Int) -> Int { clamped(value.addingReportingOverflow(step).overflow ? maximum : value + step) }
    public func stepDown(from value: Int) -> Int { clamped(value.subtractingReportingOverflow(step).overflow ? minimum : value - step) }
}

public struct ProactiveSource: Decodable, Sendable, Hashable, Identifiable {
    public let source: String
    public let intake: String
    public let trust: String
    public let enabled: Bool
    public let perDay: ProactiveDayLimit
    public let perCheck: ProactiveDayLimit
    public let dailyLimitReached: Bool
    public let updatedAt: String?

    public var id: String { source }

    public var displayName: String { Self.displayName(of: source) }

    public static func displayName(of source: String) -> String {
        let words = source.split(separator: "_").map { String($0) }
        guard let first = words.first else { return source }
        let head = first.prefix(1).uppercased() + first.dropFirst()
        return ([head] + words.dropFirst()).joined(separator: " ")
    }
}

public struct ProactiveSourceList: Decodable, Sendable, Hashable {
    public let sources: [ProactiveSource]
}
