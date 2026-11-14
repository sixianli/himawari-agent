import Foundation

struct Snapshot<Payload: Decodable>: Decodable {
    let payload: Payload
}

public struct MemoryItem: Decodable, Sendable, Identifiable, Hashable {
    public struct History: Decodable, Sendable, Hashable {
        public let historyId: Int
        public let kind: String
        public let text: String
        public let quote: String?
        public let sourceThreadId: String?
        public let sourceDeleted: Bool
        public let at: String
    }

    public let memoryId: String
    public let revision: Int
    public let text: String
    public let inference: Bool
    public let sourceThreadId: String?
    public let sourceRefs: [String]
    public let category: String
    public let subCategory: String?
    public let status: String
    public let recordedAt: String
    public let lastUsedAt: String?
    public let importBatchId: String?
    public let history: [History]

    public var id: String { memoryId }
}

public struct MemoryImport: Decodable, Sendable, Hashable {
    public let batchId: String
    public let source: String
}

public struct MemoryOverview: Decodable, Sendable {
    public let memories: [MemoryItem]
    public let imports: [MemoryImport]
    public let capturePaused: Bool
}

public struct RuleSummary: Decodable, Sendable, Identifiable, Hashable {
    public let ruleId: String
    public let type: String
    public let summary: String
    public let status: String
    public let enforced: Bool
    public let updatedAt: String
    public let quote: String?
    public let changes: Int?
    public let lastUsed: RuleUse?
    public let quoteSuperseded: Bool?
    public let quoteLatestMemoryId: String?

    public var id: String { ruleId }
}

public struct RuleUse: Decodable, Sendable, Hashable {
    public let at: String
    public let kind: String
    public let decisionId: String
}

public struct RuleBook: Decodable, Sendable {
    public let rules: [RuleSummary]
}

public struct MemoryGroup: Identifiable, Sendable, Equatable {
    public let label: String
    public let items: [MemoryItem]
    public var id: String { label }
}

public enum MemoryProvenance: Equatable, Sendable {
    case toldBy(date: Date?)
    case inferred
    case imported(source: String)
}

enum MemoryOrganizer {
    static func groups(_ memories: [MemoryItem], categoryLabel: (String) -> String) -> [MemoryGroup] {
        var order: [String] = []
        var buckets: [String: [MemoryItem]] = [:]
        for item in memories where item.status == "active" {
            let label = item.subCategory?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? categoryLabel(item.category)
            if buckets[label] == nil { order.append(label) }
            buckets[label, default: []].append(item)
        }
        return order.map { MemoryGroup(label: $0, items: buckets[$0] ?? []) }
    }

    static func provenance(_ item: MemoryItem, imports: [MemoryImport]) -> MemoryProvenance {
        if let batch = item.importBatchId, let source = imports.first(where: { $0.batchId == batch })?.source {
            return .imported(source: source)
        }
        if item.inference { return .inferred }
        return .toldBy(date: Timestamp.parse(item.recordedAt))
    }
}

public enum MemoryBasis: Equatable, Sendable {
    case said(date: Date?, quote: String?)
    case inferred
    case imported(source: String)
}

extension MemoryOrganizer {
    static func basis(_ item: MemoryItem, imports: [MemoryImport]) -> MemoryBasis {
        switch provenance(item, imports: imports) {
        case .imported(let source): return .imported(source: source)
        case .inferred: return .inferred
        case .toldBy(let date):
            let quote = item.history.first { $0.quote?.isEmpty == false }?.quote
            return .said(date: date, quote: quote)
        }
    }
}

enum Timestamp {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

struct RuleFact: Equatable {
    let title: String
    let detail: String?
    var note: String? = nil
    var opensMemory: String? = nil
}

enum RuleFacts {
    static func rows(_ rule: RuleSummary, now: Date = Date(), calendar: Calendar = .current) -> [RuleFact] {
        var rows: [RuleFact] = []
        if rule.status == "needs_review" || !rule.enforced {
            rows.append(RuleFact(title: M.ruleState(rule), detail: nil))
        }
        if let quote = rule.quote?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
            if rule.quoteSuperseded == true {
                rows.append(RuleFact(title: M.yourWords, detail: M.quoted(quote), note: M.quoteChangedLater, opensMemory: rule.quoteLatestMemoryId))
            } else {
                rows.append(RuleFact(title: M.yourWords, detail: M.quoted(quote)))
            }
        }
        if let used = rule.lastUsed, let at = Timestamp.parse(used.at) {
            rows.append(RuleFact(title: M.lastUsedRule, detail: M.dayAndTime(at, now: now, calendar: calendar)))
        }
        if let changes = rule.changes, changes > 0 {
            rows.append(RuleFact(title: M.changedTimes(changes), detail: Timestamp.parse(rule.updatedAt).map(M.shortDate)))
        }
        return rows
    }
}
