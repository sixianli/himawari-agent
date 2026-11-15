import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor CommandRecorder: DeviceTransport {
    private(set) var sent: [(type: String, payload: JSONValue?, confirmed: Bool)] = []
    let overview: String
    let review: String

    init(overview: String, review: String) {
        self.overview = overview
        self.review = review
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        guard case .string(let type)? = body["type"] else { return DeviceResponse(status: 200, body: Data("{}".utf8)) }
        await record(type, body["payload"], confirmed: confirm != nil)
        switch type {
        case "memory.overview.read": return DeviceResponse(status: 200, body: Data(overview.utf8))
        case "memory.review.read": return DeviceResponse(status: 200, body: Data(review.utf8))
        case "memory.rules.read": return DeviceResponse(status: 200, body: Data(#"{"payload":{"rules":[]}}"#.utf8))
        default: return DeviceResponse(status: 200, body: Data("{}".utf8))
        }
    }

    private func record(_ type: String, _ payload: JSONValue?, confirmed: Bool) {
        sent.append((type, payload, confirmed))
    }
}

@MainActor
final class MemoryTidyStoreTests: XCTestCase {
    private let overview = #"{"payload":{"memories":[],"imports":[],"capturePaused":false,"tidyUps":[{"changeId":"c1","memoryId":"m1","action":"merge","text":"a","relatedText":null,"createdAt":"2026-11-15T01:00:00.000Z","undone":false,"undoable":true}],"conversationReviews":[{"reviewId":"v1","finishedAt":"2026-11-15T00:00:00.000Z","undone":false,"undoable":true,"changes":[{"memoryId":"m2","action":"created"}]}]}}"#
    private let review = #"{"payload":{"memories":[{"memoryId":"m3","text":"b","upstreamMemoryId":"m4","upstreamText":null,"reason":"memory_edited","depth":1,"truncated":false,"flaggedAt":"2026-11-15T01:00:00.000Z"}],"rules":[]}}"#

    func testLoadReadsTidyUpsReviewsAndTheReviewList() async throws {
        let transport = CommandRecorder(overview: overview, review: review)
        let store = MemoryStore(gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }))
        await store.load()
        XCTAssertEqual(MemoryTidy.recent(store.tidy).map(\.id), ["c1", "v1"])
        XCTAssertEqual(MemoryTidy.reviewGroups(store.review).map(\.memoryId), ["m3"])
    }

    func testUndoAndDismissSendTheServerIdsWithOwnerConfirmation() async throws {
        let transport = CommandRecorder(overview: overview, review: review)
        let store = MemoryStore(gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }))
        await store.load()
        let recent = MemoryTidy.recent(store.tidy)
        try await store.undo(recent[0])
        try await store.undo(recent[1])
        try await store.dismiss(MemoryTidy.reviewGroups(store.review)[0])
        let commands = await transport.sent.filter { !$0.type.hasSuffix(".read") }
        XCTAssertEqual(commands.map(\.type), ["memory.tidy.undo", "memory.conversationReview.undo", "memory.review.respond"])
        XCTAssertEqual(commands.map(\.confirmed), [true, true, true])
        XCTAssertEqual(commands[0].payload, ["changeId": "c1"])
        XCTAssertEqual(commands[1].payload, ["reviewId": "v1"])
        XCTAssertEqual(commands[2].payload, ["target": "m3", "action": "dismiss", "expectedRevision": nil])
    }

    func testAnOverviewWithoutTidyFieldsStillLoads() async throws {
        let transport = CommandRecorder(overview: #"{"payload":{"memories":[],"imports":[],"capturePaused":false}}"#, review: "{}")
        let store = MemoryStore(gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }))
        await store.load()
        XCTAssertEqual(store.phase, .loaded)
        XCTAssertTrue(MemoryTidy.recent(store.tidy).isEmpty)
        XCTAssertTrue(MemoryTidy.reviewGroups(store.review).isEmpty)
    }
}
