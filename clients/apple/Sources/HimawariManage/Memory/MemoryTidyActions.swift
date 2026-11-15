import Foundation
import HimawariCore

extension MemoryStore {
    private func send(_ type: String, _ payload: JSONValue, reason: String) async throws {
        _ = try await gateway.command(.v2, type, payload: payload, options: ManageCommandOptions(confirmReason: reason))
        await load()
    }

    func undo(_ entry: MemoryTidyEntry) async throws {
        switch entry {
        case .change(let change):
            try await send("memory.tidy.undo", ["changeId": .string(change.changeId)], reason: M.confirmUndoTidy)
        case .review(let review):
            try await send("memory.conversationReview.undo", ["reviewId": .string(review.reviewId)], reason: M.confirmUndoTidy)
        }
    }

    func dismiss(_ group: MemoryReviewGroup) async throws {
        try await send(
            "memory.review.respond",
            ["target": .string(group.memoryId), "action": "dismiss", "expectedRevision": nil],
            reason: M.confirmDismissReview
        )
    }

    func basisSources(of item: MemoryItem) async -> [MemoryItem] {
        guard
            let data = try? await gateway.read(.v2, "memory.basis.read", payload: ["memoryId": .string(item.memoryId)]),
            let chain = (try? JSONDecoder().decode(Snapshot<MemoryBasisChain>.self, from: data))?.payload
        else { return [] }
        let known = Dictionary((overview?.memories ?? []).map { ($0.memoryId, $0) }, uniquingKeysWith: { first, _ in first })
        return chain.sourceIds().compactMap { known[$0] }
    }
}
