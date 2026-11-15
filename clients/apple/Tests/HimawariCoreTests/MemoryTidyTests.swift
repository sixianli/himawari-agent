import XCTest
@testable import HimawariCore

final class MemoryTidyTests: XCTestCase {
    private func overview(tidy: String = "[]", reviews: String = "[]") throws -> MemoryTidySnapshot {
        let body = #"{"memories":[],"pending":[],"tidyUps":\#(tidy),"conversationReviews":\#(reviews),"manualAddReady":true,"capturePaused":false,"imports":[]}"#
        return try JSONDecoder().decode(MemoryTidySnapshot.self, from: Data(body.utf8))
    }

    private func change(_ id: String, action: String = "merge", at: String, undone: Bool = false, undoable: Bool = true) -> String {
        #"{"changeId":"\#(id)","memoryId":"m-\#(id)","action":"\#(action)","text":"t-\#(id)","relatedText":null,"createdAt":"\#(at)","undone":\#(undone),"undoable":\#(undoable)}"#
    }

    func testNothingTidiedGivesAnEmptyList() throws {
        XCTAssertTrue(MemoryTidy.recent(try overview()).isEmpty)
        XCTAssertTrue(MemoryTidy.recent(nil).isEmpty)
    }

    func testUndoneChangesAndEmptyReviewsAreLeftOut() throws {
        let value = try overview(
            tidy: "[\(change("c1", at: "2026-11-15T01:00:00.000Z")),\(change("c2", at: "2026-11-15T02:00:00.000Z", undone: true))]",
            reviews: #"[{"reviewId":"v1","finishedAt":"2026-11-15T03:00:00.000Z","undone":false,"undoable":true,"changes":[]},{"reviewId":"v2","finishedAt":"2026-11-15T00:30:00.000Z","undone":true,"undoable":false,"changes":[{"memoryId":"m","action":"created"}]}]"#
        )
        XCTAssertEqual(MemoryTidy.recent(value).map(\.id), ["c1"])
    }

    func testNewestFirstAcrossChangesAndReviews() throws {
        let value = try overview(
            tidy: "[\(change("c1", at: "2026-11-14T18:00:00Z")),\(change("c2", action: "future_kind", at: "2026-11-15T02:00:00.000Z", undoable: false))]",
            reviews: #"[{"reviewId":"v1","finishedAt":"2026-11-15T01:00:00.000Z","undone":false,"undoable":true,"changes":[{"memoryId":"m","action":"created"}]}]"#
        )
        let recent = MemoryTidy.recent(value)
        XCTAssertEqual(recent.map(\.id), ["c2", "v1", "c1"])
        XCTAssertEqual(recent.map(\.undoable), [false, true, true])
    }

    func testEqualTimesKeepTheServerOrder() throws {
        let value = try overview(tidy: "[\(change("b", at: "2026-11-15T01:00:00.000Z")),\(change("a", at: "2026-11-15T01:00:00.000Z"))]")
        XCTAssertEqual(MemoryTidy.recent(value).map(\.id), ["b", "a"])
    }

    func testReviewGroupsKeepEachMemoryOnceInFirstSeenOrder() throws {
        let body = #"{"memories":[{"memoryId":"m1","text":null,"upstreamMemoryId":"u1","upstreamText":null,"reason":"memory_edited","depth":1,"truncated":false,"flaggedAt":"2026-11-15T01:00:00.000Z"},{"memoryId":"m2","text":"b","upstreamMemoryId":"u3","upstreamText":null,"reason":"something_new","depth":1,"truncated":false,"flaggedAt":"2026-11-15T01:00:00.000Z"},{"memoryId":"m1","text":"a","upstreamMemoryId":"u2","upstreamText":"x","reason":"memory_removed","depth":2,"truncated":true,"flaggedAt":"2026-11-15T01:00:00.000Z"}],"rules":[],"agreement":{"handled":0,"agreed":0,"missed":0,"openMemories":2,"openRules":0},"generatedAt":"2026-11-15T01:00:00.000Z"}"#
        let review = try JSONDecoder().decode(MemoryReviewSnapshot.self, from: Data(body.utf8))
        let groups = MemoryTidy.reviewGroups(review)
        XCTAssertEqual(groups.map(\.memoryId), ["m1", "m2"])
        XCTAssertEqual(groups[0].text, "a")
        XCTAssertEqual(groups[0].sources.count, 2)
        XCTAssertTrue(MemoryTidy.reviewGroups(nil).isEmpty)
    }

    func testBasisSourcesAreTheDirectBasisWithoutRepeatsOrItself() throws {
        let body = #"{"memoryId":"m1","nodes":[{"memoryId":"m1","changeId":"c1","action":"merge","changedAt":"2026-11-15T01:00:00.000Z","decisionRecordId":null,"basisMemoryIds":["m2","m3","m2","m1"],"repeated":false,"truncated":false},{"memoryId":"m2","changeId":null,"action":null,"changedAt":null,"decisionRecordId":null,"basisMemoryIds":["m9"],"repeated":false,"truncated":false}],"complete":true}"#
        let chain = try JSONDecoder().decode(MemoryBasisChain.self, from: Data(body.utf8))
        XCTAssertEqual(chain.sourceIds(), ["m2", "m3"])
    }

    func testNoBasisGivesNoSources() throws {
        let body = #"{"memoryId":"m1","nodes":[],"complete":true}"#
        let chain = try JSONDecoder().decode(MemoryBasisChain.self, from: Data(body.utf8))
        XCTAssertTrue(chain.sourceIds().isEmpty)
    }
}
