import Foundation

public struct MemoryApprovalRequest: Decodable, Sendable, Equatable, Identifiable {
    public let requestId: String
    public let threadId: String
    public let sourceRef: String
    public let text: String
    public let topic: String
    public let requestedAt: String

    public var id: String { requestId }
}

public struct MemoryExternalProposal: Decodable, Sendable, Equatable, Identifiable {
    public let proposalId: String
    public let text: String
    public let category: String
    public let dataClassification: String
    public let client: String
    public let receivedAt: String

    public var id: String { proposalId }
}

public struct MemoryExternalBatch: Decodable, Sendable, Equatable, Identifiable {
    public let batchId: String
    public let decidedAt: String
    public let committed: Int
    public let rejected: Int

    public var id: String { batchId }
}

public struct MemoryExternalProposals: Decodable, Sendable, Equatable {
    public let total: Int
    public let items: [MemoryExternalProposal]
    public let batches: [MemoryExternalBatch]
}

public struct MemoryPersonSuggestion: Decodable, Sendable, Equatable, Identifiable {
    public let suggestionId: String
    public let personId: String
    public let candidateId: String
    public let createdAt: String

    public var id: String { suggestionId }
}

public struct MemoryPerson: Decodable, Sendable, Equatable, Identifiable {
    public let personId: String
    public let name: String

    public var id: String { personId }
}

public struct MemoryReminder: Decodable, Sendable, Equatable, Identifiable {
    public let reminderId: String
    public let text: String
    public let dueAt: String
    public let remindAt: String
    public let sourceThreadId: String?

    public var id: String { reminderId }
}

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

public struct MemoryPersonQuestion: Sendable, Equatable, Identifiable {
    public let suggestion: MemoryPersonSuggestion
    public let name: String
    public let candidateName: String

    public var id: String { suggestion.id }
}

public struct MemoryAwaitingSnapshot: Decodable, Sendable, Equatable {
    public let pending: [MemoryApprovalRequest]
    public let externalProposals: MemoryExternalProposals
    public let personSuggestions: [MemoryPersonSuggestion]
    public let people: [MemoryPerson]
    public let reminders: [MemoryReminder]
    public let tidyUps: [MemoryTidyUp]
    public let conversationReviews: [MemoryConversationReview]
    public let manualAddReady: Bool

    public var personQuestions: [MemoryPersonQuestion] {
        let names = Dictionary(people.map { ($0.personId, $0.name) }, uniquingKeysWith: { first, _ in first })
        return personSuggestions.compactMap { suggestion in
            guard let name = names[suggestion.personId], let candidate = names[suggestion.candidateId] else { return nil }
            return MemoryPersonQuestion(suggestion: suggestion, name: name, candidateName: candidate)
        }
    }

    public var undoableTidyUps: [MemoryTidyUp] { tidyUps.filter { $0.undoable && !$0.undone } }
    public var undoableReviews: [MemoryConversationReview] { conversationReviews.filter { $0.undoable && !$0.undone } }
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

public enum MemoryAwaiting {
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

    public static func count(_ snapshot: MemoryAwaitingSnapshot?, review: MemoryReviewSnapshot?) -> Int {
        guard let snapshot else { return 0 }
        return snapshot.pending.count
            + snapshot.externalProposals.total
            + snapshot.personQuestions.count
            + snapshot.reminders.count
            + reviewGroups(review).count
    }

    public static func hiddenExternal(_ snapshot: MemoryAwaitingSnapshot) -> Int {
        max(0, snapshot.externalProposals.total - snapshot.externalProposals.items.count)
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
