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

public struct ProactiveMetrics: Decodable, Sendable, Hashable {
    public let spoke: Int
    public let hits: Int
    public let misfires: Int
    public let missed: Int
    public let reviewed: Int
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
    public let metrics: ProactiveMetrics

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

    public var hasMetrics: Bool { metrics.spoke > 0 || metrics.reviewed > 0 }
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
        let span = max(1, maximum - minimum)
        var step = 1
        while span / (step * 10) >= 20 { step *= 10 }
        return step
    }

    public func clamped(_ value: Int) -> Int { min(maximum, max(minimum, value)) }
    public func stepUp(from value: Int) -> Int { clamped(value + step) }
    public func stepDown(from value: Int) -> Int { clamped(value - step) }
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

public struct ProactiveRate: Decodable, Sendable, Hashable {
    public let successes: Int
    public let samples: Int
    public let enough: Bool
    public let value: Double?
}

public struct ProactiveRates: Decodable, Sendable, Hashable {
    public let useful: ProactiveRate?
    public let unneeded: ProactiveRate?
    public let missed: ProactiveRate?

    func rate(_ rating: ProactiveRating) -> ProactiveRate? {
        switch rating {
        case .useful: useful
        case .unneeded: unneeded
        case .missed: missed
        }
    }
}

public struct ProactiveWeeklyFigure: Sendable, Equatable {
    public let rating: ProactiveRating
    public let count: Int
    public let percent: Int?

    public init(rating: ProactiveRating, count: Int, percent: Int?) {
        self.rating = rating
        self.count = count
        self.percent = percent
    }
}

public struct ProactiveWeeklyGroup: Decodable, Sendable, Hashable, Identifiable {
    public let group: String
    public let total: Int
    public let rated: Int
    public let useful: Int
    public let unneeded: Int
    public let missed: Int
    public let applicable: [String]
    public let rates: ProactiveRates

    public var id: String { group }

    public func figures(ratesWithheld: Bool) -> [ProactiveWeeklyFigure] {
        applicable.compactMap(ProactiveRating.init(rawValue:)).map { rating in
            let count: Int
            switch rating {
            case .useful: count = useful
            case .unneeded: count = unneeded
            case .missed: count = missed
            }
            var percent: Int?
            if !ratesWithheld, let rate = rates.rate(rating), rate.enough, let value = rate.value {
                percent = Int((value * 100).rounded())
            }
            return ProactiveWeeklyFigure(rating: rating, count: count, percent: percent)
        }
    }

    public func hasEnoughRated(minimum: Int) -> Bool { rated >= minimum }
}

public struct ProactiveWeeklyReport: Decodable, Sendable, Hashable {
    public let startDay: String
    public let endDay: String
    public let complete: Bool
    public let ratesWithheld: Bool
    public let minimumSamples: Int
    public let groups: [ProactiveWeeklyGroup]

    public var shownGroups: [ProactiveWeeklyGroup] { groups.filter { $0.total > 0 } }
}

public struct ProactiveObservation: Decodable, Sendable, Hashable {
    public let startDay: String?
}

public struct ProactiveWeekly: Decodable, Sendable, Hashable {
    public let observation: ProactiveObservation
    public let report: ProactiveWeeklyReport

    public var hasStarted: Bool { observation.startDay != nil }
}
