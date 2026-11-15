import Foundation

public struct SensitiveCounts: Decodable, Sendable, Equatable {
    public let masked: Int
    public let withheld: Int
    public let notSaved: Int

    public var total: Int { masked + withheld + notSaved }
}

public struct SensitiveCursor: Codable, Sendable, Equatable {
    public let firstSeenAt: String
    public let id: String

    public init(firstSeenAt: String, id: String) {
        self.firstSeenAt = firstSeenAt
        self.id = id
    }
}

public struct SensitiveItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let threadId: String?
    public let source: String
    public let part: String
    public let category: String
    public let outcome: String
    public let firstSeenAt: String
    public let seenCount: Int
}

public struct SensitiveSnapshot: Decodable, Sendable, Equatable {
    public let counts: SensitiveCounts
    public let items: [SensitiveItem]
    public let next: SensitiveCursor?
}

public enum SensitiveFilter: String, CaseIterable, Sendable {
    case all
    case masked
    case withheld
    case notSaved = "not_saved"

    public func count(in counts: SensitiveCounts) -> Int {
        switch self {
        case .all: counts.total
        case .masked: counts.masked
        case .withheld: counts.withheld
        case .notSaved: counts.notSaved
        }
    }

    public func accepts(_ item: SensitiveItem) -> Bool {
        self == .all || item.outcome == rawValue
    }

    public static func shown(for counts: SensitiveCounts) -> [SensitiveFilter] {
        allCases.filter { $0 == .all || $0.count(in: counts) > 0 }
    }
}

public struct SensitiveDay: Equatable, Sendable {
    public let day: Date
    public let items: [SensitiveItem]
}

public enum SensitiveRecords {
    public static func grouped(
        _ items: [SensitiveItem],
        filter: SensitiveFilter,
        calendar: Calendar
    ) -> [SensitiveDay] {
        var days: [SensitiveDay] = []
        for item in items where filter.accepts(item) {
            guard let seen = DeviceActionTime.parse(item.firstSeenAt) else { continue }
            let day = calendar.startOfDay(for: seen)
            if let last = days.last, last.day == day {
                days[days.count - 1] = SensitiveDay(day: day, items: last.items + [item])
            } else {
                days.append(SensitiveDay(day: day, items: [item]))
            }
        }
        return days
    }

    public static func appended(_ page: SensitiveSnapshot, to existing: [SensitiveItem]) -> [SensitiveItem] {
        let known = Set(existing.map(\.id))
        return existing + page.items.filter { !known.contains($0.id) }
    }
}
