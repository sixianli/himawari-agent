import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor MainServer: DeviceTransport {
    private(set) var types: [JSONValue?] = []
    private let answer: String

    init(answer: String) {
        self.answer = answer
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return await reply(body)
    }

    private func reply(_ body: [String: JSONValue]) -> DeviceResponse {
        types.append(body["type"])
        return DeviceResponse(status: 200, body: Data(answer.utf8))
    }
}

final class MainThreadLocatorTests: XCTestCase {
    func testReadsTheMainThreadIdFromTheSnapshot() async throws {
        let server = MainServer(answer: #"{"payload":{"thread":{"threadId":"thread-main","title":"主对话"},"snapshotRef":"s1","generatedAt":"2026-11-25T00:00:00Z"}}"#)
        let locator = MainThreadLocator(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        let id = try await locator.mainThreadId()
        XCTAssertEqual(id, "thread-main")
        let types = await server.types
        XCTAssertEqual(types, [.string("thread.main")])
    }

    func testFailsWhenTheServerSendsNoThread() async {
        let server = MainServer(answer: #"{"payload":{"snapshotRef":"s1"}}"#)
        let locator = MainThreadLocator(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        do {
            _ = try await locator.mainThreadId()
            XCTFail("expected a decoding failure")
        } catch {}
    }
}
