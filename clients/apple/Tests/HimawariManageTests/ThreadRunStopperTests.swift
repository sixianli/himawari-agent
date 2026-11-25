import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor StopServer: DeviceTransport {
    private(set) var sent: [(path: String, body: [String: JSONValue])] = []

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        await record(path, body)
        if path == ManageGateway.textPath {
            return DeviceResponse(status: 200, body: Data(#"{"payloadRef":"ref-stop"}"#.utf8))
        }
        return DeviceResponse(status: 200, body: Data("{}".utf8))
    }

    private func record(_ path: String, _ body: [String: JSONValue]) {
        sent.append((path, body))
    }
}

final class ThreadRunStopperTests: XCTestCase {
    func testStoppingCancelsTheWorkingRunAtTheRevisionItSaw() async throws {
        let server = StopServer()
        let stopper = ThreadRunStopper(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        let run = try JSONDecoder().decode(ThreadRunSummary.self, from: Data(#"{"runId":"run-1","revision":3,"status":"running"}"#.utf8))
        try await stopper.stop(threadId: "thread-1", run: run)
        let sent = await server.sent
        XCTAssertEqual(sent.first?.path, ManageGateway.textPath)
        let command = sent.last?.body
        XCTAssertEqual(command?["type"], .string("thread.run.cancel"))
        XCTAssertEqual(command?["payload"], .object([
            "threadId": .string("thread-1"),
            "runId": .string("run-1"),
            "expectedRunRevision": .number(3),
            "resultRef": .string("ref-stop"),
        ]))
    }
}
