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

@MainActor
final class MemoryStoreTests: XCTestCase {
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
