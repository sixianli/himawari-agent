import Foundation
import XCTest
@testable import HimawariManage

private actor UploadRecorder: DeviceTransport {
    private(set) var uploads: [[String: JSONValue]] = []

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        if path == ManageGateway.textPath {
            let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
            await record(body)
            return DeviceResponse(status: 200, body: Data(#"{"payloadRef":"ref-1"}"#.utf8))
        }
        return DeviceResponse(status: 200, body: Data("{}".utf8))
    }

    private func record(_ body: [String: JSONValue]) {
        uploads.append(body)
    }
}

private actor MemoryServer: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        await record(body)
        switch body["type"] {
        case .string("memory.overview.read"):
            return DeviceResponse(status: 200, body: Data(Self.overview.utf8))
        case .string("memory.rules.read"):
            return DeviceResponse(status: 200, body: Data(Self.rules.utf8))
        default:
            return DeviceResponse(status: 200, body: Data("{}".utf8))
        }
    }

    private func record(_ body: [String: JSONValue]) {
        sent.append(body)
    }

    private static func memory(_ id: String, category: String, status: String) -> String {
        #"{"memoryId":"\#(id)","revision":1,"text":"t","dataClassification":"private","inference":false,"sourceThreadId":null,"sourceRefs":[],"category":"\#(category)","subCategory":null,"status":"\#(status)","recordedAt":"2026-10-21T03:00:00.000Z","lastUsedAt":null,"importBatchId":null,"history":[]}"#
    }

    static let overview = #"{"payload":{"memories":[\#(memory("m1", category: "health", status: "active")),\#(memory("m2", category: "health", status: "active")),\#(memory("m3", category: "work", status: "active")),\#(memory("m4", category: "work", status: "deleted"))],"imports":[],"capturePaused":false}}"#
    static let rules = #"{"payload":{"rules":[{"ruleId":"r1","type":"push_quiet_hours","summary":"晚上别推","status":"active","enforced":true,"updatedAt":"2026-10-21T03:00:00.000Z","quote":null,"changes":null,"lastUsed":null}]}}"#
}

@MainActor
final class MemoryStoreTests: XCTestCase {
    func testSummaryCountsOnlyWhatTheMemoryPageShows() async throws {
        let store = MemoryStore(gateway: ManageGateway(transport: MemoryServer(), makeIdentifier: { "0123456789abcdef0123" }))
        XCTAssertNil(store.summary(categoryLabel: { $0 }))
        await store.load()
        XCTAssertEqual(store.summary(categoryLabel: { $0 }), MemorySummary(memories: 3, topics: 2, rules: 1))
    }

    func testPausingMemorySendsTheSettingsCommandAndReloads() async throws {
        let server = MemoryServer()
        let store = MemoryStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        try await store.setCapturePaused(true, reason: "暂停记忆")
        let sent = await server.sent
        let command = sent.first { $0["type"] == .string("memory.settings.set") }
        XCTAssertEqual(command?["payload"], .object(["capturePaused": .bool(true)]))
        XCTAssertTrue(sent.contains { $0["type"] == .string("memory.overview.read") })
    }

    private func item(classification: String) throws -> MemoryItem {
        let body = #"{"memoryId":"memory-1","revision":2,"text":"对花生过敏","dataClassification":"\#(classification)","inference":false,"sourceThreadId":null,"sourceRefs":[],"category":"health","subCategory":null,"status":"active","recordedAt":"2026-10-21T03:00:00.000Z","lastUsedAt":null,"importBatchId":null,"history":[]}"#
        return try JSONDecoder().decode(MemoryItem.self, from: Data(body.utf8))
    }

    func testCorrectingAMemoryUploadsTheNewTextWithTheMemorysOwnClassification() async throws {
        let transport = UploadRecorder()
        let store = MemoryStore(gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }))
        try await store.correct(try item(classification: "sensitive"), text: "对坚果过敏", reason: "修改")
        let uploads = await transport.uploads
        XCTAssertEqual(uploads.count, 1)
        XCTAssertEqual(uploads[0]["dataClassification"], .string("sensitive"))
        XCTAssertEqual(uploads[0]["content"], .string("对坚果过敏"))
    }
}
