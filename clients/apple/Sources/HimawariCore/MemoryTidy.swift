import Foundation

public struct MemoryTidyUp: Decodable, Sendable, Equatable, Identifiable {
    public let changeId: String
    public let memoryId: String
    public let action: String
    public let text: String
    public let relatedText: String?
    public let createdAt: String
    public let undone: Bool
    public let undoable: Bool

    public var id: String { changeId }
}

public struct MemoryConversationReview: Decodable, Sendable, Equatable, Identifiable {
    public struct Change: Decodable, Sendable, Equatable {
        public let memoryId: String
        public let action: String
    }

    public let reviewId: String
    public let finishedAt: String
    public let undone: Bool
    public let undoable: Bool
    public let changes: [Change]

    public var id: String { reviewId }
}

public struct MemoryTidySnapshot: Decodable, Sendable, Equatable {
    public let tidyUps: [MemoryTidyUp]
    public let conversationReviews: [MemoryConversationReview]
}

public struct MemoryReviewEntry: Decodable, Sendable, Equatable {
    public let memoryId: String
    public let text: String?
    public let upstreamMemoryId: String
    public let upstreamText: String?
    public let reason: String
    public let depth: Int
    public let truncated: Bool
    public let flaggedAt: String
}

public struct MemoryReviewSnapshot: Decodable, Sendable, Equatable {
    public let memories: [MemoryReviewEntry]
}

public struct MemoryReviewGroup: Sendable, Equatable, Identifiable {
    public let memoryId: String
    public let text: String?
    public let sources: [MemoryReviewEntry]

    public var id: String { memoryId }
}

public enum MemoryTidyEntry: Sendable, Equatable, Identifiable {
    case change(MemoryTidyUp)
    case review(MemoryConversationReview)

    public var id: String {
        switch self {
        case .change(let change): change.changeId
        case .review(let review): review.reviewId
        }
    }

    public var at: String {
        switch self {
        case .change(let change): change.createdAt
        case .review(let review): review.finishedAt
        }
    }

    public var undoable: Bool {
        switch self {
        case .change(let change): change.undoable
        case .review(let review): review.undoable
        }
    }
}

public enum MemoryTidy {
    public static func reviewGroups(_ review: MemoryReviewSnapshot?) -> [MemoryReviewGroup] {
        guard let review else { return [] }
        var order: [String] = []
        var buckets: [String: [MemoryReviewEntry]] = [:]
        for entry in review.memories {
            if buckets[entry.memoryId] == nil { order.append(entry.memoryId) }
            buckets[entry.memoryId, default: []].append(entry)
        }
        return order.map { id in
            let sources = buckets[id] ?? []
            return MemoryReviewGroup(memoryId: id, text: sources.compactMap(\.text).first, sources: sources)
        }
    }

    public static func recent(_ snapshot: MemoryTidySnapshot?) -> [MemoryTidyEntry] {
        guard let snapshot else { return [] }
        let changes = snapshot.tidyUps.filter { !$0.undone }.map(MemoryTidyEntry.change)
        let reviews = snapshot.conversationReviews.filter { !$0.undone && !$0.changes.isEmpty }.map(MemoryTidyEntry.review)
        return (changes + reviews)
            .enumerated()
            .sorted { left, right in
                let leftAt = Self.instant(left.element.at)
                let rightAt = Self.instant(right.element.at)
                if leftAt != rightAt { return leftAt > rightAt }
                return left.offset < right.offset
            }
            .map(\.element)
    }

    static func instant(_ value: String) -> Date {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value) ?? .distantPast
    }
}

public struct MemoryBasisNode: Decodable, Sendable, Equatable {
    public let memoryId: String
    public let changeId: String?
    public let action: String?
    public let changedAt: String?
    public let basisMemoryIds: [String]
    public let repeated: Bool
    public let truncated: Bool
}

public struct MemoryBasisChain: Decodable, Sendable, Equatable {
    public let memoryId: String
    public let nodes: [MemoryBasisNode]
    public let complete: Bool

    public func sourceIds() -> [String] {
        var seen: Set<String> = [memoryId]
        var result: [String] = []
        for node in nodes where node.memoryId == memoryId {
            for id in node.basisMemoryIds where seen.insert(id).inserted { result.append(id) }
        }
        return result
    }
}
