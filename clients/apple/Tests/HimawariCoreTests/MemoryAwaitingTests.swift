import XCTest
@testable import HimawariCore

final class MemoryAwaitingTests: XCTestCase {
    private func snapshot(
        pending: String = "[]",
        external: String = #"{"total":0,"items":[],"batches":[]}"#,
        suggestions: String = "[]",
        people: String = "[]",
        reminders: String = "[]",
        tidy: String = "[]",
        reviews: String = "[]"
    ) throws -> MemoryAwaitingSnapshot {
        let body = #"{"memories":[],"pending":\#(pending),"externalProposals":\#(external),"personSuggestions":\#(suggestions),"people":\#(people),"reminders":\#(reminders),"tidyUps":\#(tidy),"conversationReviews":\#(reviews),"manualAddReady":true,"capturePaused":false,"imports":[]}"#
        return try JSONDecoder().decode(MemoryAwaitingSnapshot.self, from: Data(body.utf8))
    }

    private let proposal = #"{"proposalId":"p1","text":"喜欢靠窗","category":"preference","dataClassification":"private","client":"Codex","receivedAt":"2026-11-15T01:00:00.000Z"}"#
    private let approval = #"{"requestId":"r1","threadId":"t1","sourceRef":"s","text":"对花生过敏","topic":"health","requestedAt":"2026-11-15T01:00:00.000Z"}"#
    private let reminder = #"{"reminderId":"m1","text":"交报告","dueAt":"2026-11-15T03:00:00.000Z","remindAt":"2026-11-15T02:00:00.000Z","sourceThreadId":null}"#
    private let twoPeople = #"[{"personId":"a","name":"田中","aliases":[],"relation":null,"reverseRelation":null,"links":[],"memoryIds":[]},{"personId":"b","name":"田中先生","aliases":[],"relation":null,"reverseRelation":null,"links":[],"memoryIds":[]}]"#

    func testNothingWaitingCountsZero() throws {
        XCTAssertEqual(MemoryAwaiting.count(try snapshot(), review: nil), 0)
        XCTAssertEqual(MemoryAwaiting.count(nil, review: nil), 0)
    }

    func testCountAddsEveryListTheTabShows() throws {
        let value = try snapshot(
            pending: "[\(approval)]",
            external: #"{"total":7,"items":[\#(proposal)],"batches":[]}"#,
            suggestions: #"[{"suggestionId":"s1","personId":"a","candidateId":"b","createdAt":"2026-11-15T01:00:00.000Z"}]"#,
            people: twoPeople,
            reminders: "[\(reminder)]"
        )
        XCTAssertEqual(MemoryAwaiting.count(value, review: nil), 1 + 7 + 1 + 1)
        XCTAssertEqual(MemoryAwaiting.hiddenExternal(value), 6)
    }

    func testPersonQuestionWithAnUnknownPersonIsNotAskedOrCounted() throws {
        let value = try snapshot(
            suggestions: #"[{"suggestionId":"s1","personId":"a","candidateId":"gone","createdAt":"2026-11-15T01:00:00.000Z"}]"#,
            people: twoPeople
        )
        XCTAssertTrue(value.personQuestions.isEmpty)
        XCTAssertEqual(MemoryAwaiting.count(value, review: nil), 0)
    }

    func testReviewCountsEachMemoryOnceAcrossItsSources() throws {
        let body = #"{"memories":[{"memoryId":"m1","text":"a","upstreamMemoryId":"u1","upstreamText":null,"reason":"memory_edited","depth":1,"truncated":false,"flaggedAt":"2026-11-15T01:00:00.000Z"},{"memoryId":"m1","text":"a","upstreamMemoryId":"u2","upstreamText":"x","reason":"memory_removed","depth":2,"truncated":true,"flaggedAt":"2026-11-15T01:00:00.000Z"},{"memoryId":"m2","text":null,"upstreamMemoryId":"u3","upstreamText":null,"reason":"something_new","depth":1,"truncated":false,"flaggedAt":"2026-11-15T01:00:00.000Z"}],"rules":[],"agreement":{}}"#
        let review = try JSONDecoder().decode(MemoryReviewSnapshot.self, from: Data(body.utf8))
        let groups = MemoryAwaiting.reviewGroups(review)
        XCTAssertEqual(groups.map(\.memoryId), ["m1", "m2"])
        XCTAssertEqual(groups[0].sources.count, 2)
        XCTAssertEqual(MemoryAwaiting.count(try snapshot(), review: review), 2)
    }

    func testOnlyUndoableNotYetUndoneChangesAreOffered() throws {
        let tidy = #"[{"changeId":"c1","memoryId":"m","action":"merge","text":"a","relatedText":null,"createdAt":"2026-11-15T01:00:00.000Z","undone":false,"undoable":true},{"changeId":"c2","memoryId":"m","action":"future_kind","text":"b","relatedText":null,"createdAt":"2026-11-15T01:00:00.000Z","undone":false,"undoable":false},{"changeId":"c3","memoryId":"m","action":"archive","text":"c","relatedText":null,"createdAt":"2026-11-15T01:00:00.000Z","undone":true,"undoable":true}]"#
        let reviews = #"[{"reviewId":"v1","finishedAt":"2026-11-15T01:00:00.000Z","undone":false,"undoable":true,"changes":[{"memoryId":"m","action":"created"}]},{"reviewId":"v2","finishedAt":"2026-11-15T01:00:00.000Z","undone":false,"undoable":false,"changes":[]}]"#
        let value = try snapshot(tidy: tidy, reviews: reviews)
        XCTAssertEqual(value.undoableTidyUps.map(\.changeId), ["c1"])
        XCTAssertEqual(value.undoableReviews.map(\.reviewId), ["v1"])
    }

    func testBasisSourcesAreTheRootsOwnBasisWithoutItselfOrRepeats() throws {
        let body = #"{"memoryId":"m1","nodes":[{"memoryId":"m1","changeId":"c","action":"merge","changedAt":null,"decisionRecordId":null,"basisMemoryIds":["m1","a","b","a"],"repeated":false,"truncated":false},{"memoryId":"a","changeId":null,"action":null,"changedAt":null,"decisionRecordId":null,"basisMemoryIds":["z"],"repeated":false,"truncated":false}],"complete":true}"#
        let chain = try JSONDecoder().decode(MemoryBasisChain.self, from: Data(body.utf8))
        XCTAssertEqual(chain.sourceIds(), ["a", "b"])
    }

    private func classified(_ category: String, _ classification: String, topic: String?, failed: Bool = false, ref: String = "r") throws -> MemoryClassifyItem {
        let topicText = topic.map { "\"\($0)\"" } ?? "null"
        let body = #"{"contentRef":"\#(ref)","category":"\#(category)","classification":"\#(classification)","topic":\#(topicText),"failed":\#(failed)}"#
        return try JSONDecoder().decode(MemoryClassifyItem.self, from: Data(body.utf8))
    }

    func testCreatePlanKeepsAPlainMemoryPrivate() throws {
        let plan = MemoryCreatePlan.make(try classified("preference", "private", topic: nil), contentRef: "r")
        XCTAssertEqual(plan, MemoryCreatePlan(category: "preference", sensitive: false, topic: nil))
    }

    func testCreatePlanTreatsHealthAsSensitiveEvenWhenClassifiedPrivate() throws {
        let plan = MemoryCreatePlan.make(try classified("health", "private", topic: nil), contentRef: "r")
        XCTAssertEqual(plan, MemoryCreatePlan(category: "health", sensitive: true, topic: "health"))
    }

    func testCreatePlanUsesTheServersTopicForSensitiveText() throws {
        let plan = MemoryCreatePlan.make(try classified("other", "sensitive", topic: "legal"), contentRef: "r")
        XCTAssertEqual(plan, MemoryCreatePlan(category: "other", sensitive: true, topic: "legal"))
    }

    func testCreatePlanFallsBackToSensitiveOtherWhenClassifyFailedOrMismatched() throws {
        let fallback = MemoryCreatePlan(category: "other", sensitive: true, topic: "other")
        XCTAssertEqual(MemoryCreatePlan.make(try classified("goal", "private", topic: nil, failed: true), contentRef: "r"), fallback)
        XCTAssertEqual(MemoryCreatePlan.make(try classified("goal", "private", topic: nil, ref: "x"), contentRef: "r"), fallback)
        XCTAssertEqual(MemoryCreatePlan.make(nil, contentRef: "r"), fallback)
    }
}
