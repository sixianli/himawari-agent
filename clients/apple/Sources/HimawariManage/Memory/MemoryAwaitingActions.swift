import Foundation
import HimawariCore

enum MemoryDecision {
    static func approvalPayload(requestId: String, approved: Bool) -> JSONValue {
        ["requestId": .string(requestId), "resolution": .string(approved ? "approved" : "rejected"), "editedText": nil]
    }

    static func externalPayload(proposalId: String, keep: Bool) -> JSONValue {
        [
            "items": .array([
                [
                    "proposalId": .string(proposalId),
                    "decision": .string(keep ? "keep" : "reject"),
                    "editedText": nil,
                ],
            ]),
        ]
    }

    static func createPayload(contentRef: String, plan: MemoryCreatePlan) -> JSONValue {
        [
            "contentRef": .string(contentRef),
            "category": .string(plan.category),
            "subCategory": nil,
            "topic": plan.topic.map(JSONValue.string) ?? JSONValue.null,
            "pinned": false,
        ]
    }
}

extension MemoryStore {
    private func send(_ type: String, _ payload: JSONValue, reason: String) async throws {
        _ = try await gateway.command(.v2, type, payload: payload, options: ManageCommandOptions(confirmReason: reason))
        await load()
    }

    func answer(_ request: MemoryApprovalRequest, approved: Bool) async throws {
        try await send(
            "memory.approval.respond",
            MemoryDecision.approvalPayload(requestId: request.requestId, approved: approved),
            reason: approved ? M.confirmApproveMemory : M.confirmDeclineMemory
        )
    }

    func answer(_ proposal: MemoryExternalProposal, keep: Bool) async throws {
        try await send(
            "memory.external.respond",
            MemoryDecision.externalPayload(proposalId: proposal.proposalId, keep: keep),
            reason: keep ? M.confirmKeepExternal : M.confirmDeclineExternal
        )
    }

    func undo(_ batch: MemoryExternalBatch) async throws {
        try await send("memory.external.undo", ["batchId": .string(batch.batchId)], reason: M.confirmUndoBatch)
    }

    func answer(_ question: MemoryPersonQuestion, same: Bool) async throws {
        try await send(
            "memory.person.respond",
            ["suggestionId": .string(question.suggestion.suggestionId), "merge": .bool(same)],
            reason: M.confirmPerson
        )
    }

    func answer(_ reminder: MemoryReminder, action: String) async throws {
        try await send(
            "memory.reminder.respond",
            ["reminderId": .string(reminder.reminderId), "action": .string(action)],
            reason: M.confirmReminder
        )
    }

    func undo(_ change: MemoryTidyUp) async throws {
        try await send("memory.tidy.undo", ["changeId": .string(change.changeId)], reason: M.confirmUndoTidy)
    }

    func undo(_ review: MemoryConversationReview) async throws {
        try await send("memory.conversationReview.undo", ["reviewId": .string(review.reviewId)], reason: M.confirmUndoTidy)
    }

    func dismiss(_ group: MemoryReviewGroup) async throws {
        try await send(
            "memory.review.respond",
            ["target": .string(group.memoryId), "action": "dismiss", "expectedRevision": nil],
            reason: M.confirmDismissReview
        )
    }

    func create(_ text: String) async throws {
        let ref = try await gateway.uploadText(text, dataClassification: "private")
        var item: MemoryClassifyItem?
        if let data = try? await gateway.read(.v2, "memory.classify.read", payload: ["contentRefs": .array([.string(ref)])]) {
            item = (try? JSONDecoder().decode(Snapshot<MemoryClassifyResult>.self, from: data))?.payload.items.first
        }
        let plan = MemoryCreatePlan.make(item, contentRef: ref)
        let finalRef = plan.sensitive ? try await gateway.uploadText(text, dataClassification: "sensitive") : ref
        try await send("memory.create", MemoryDecision.createPayload(contentRef: finalRef, plan: plan), reason: M.confirmCreateMemory)
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
