import Foundation
import XCTest
@testable import HimawariManage

private actor ExportTransport: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private var statuses: [(Int, String)]

    init(statuses: [(Int, String)]) {
        self.statuses = statuses
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            await record([:])
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2999-01-01T00:00:00Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        await record(body)
        switch body["type"] {
        case "data.export.start":
            return DeviceResponse(status: 200, body: Data(#"{"resultRef":"data-export:AAAAAAAAAAAAAAAAAAAAAA"}"#.utf8))
        case "data.export.status.read":
            let (status, reply) = await next()
            return DeviceResponse(status: status, body: Data(reply.utf8))
        default:
            return DeviceResponse(status: 200, body: Data(#"{"resultRef":"data-export:AAAAAAAAAAAAAAAAAAAAAA"}"#.utf8))
        }
    }

    private func record(_ body: [String: JSONValue]) {
        sent.append(body)
    }

    private func next() -> (Int, String) {
        statuses.count > 1 ? statuses.removeFirst() : statuses[0]
    }
}

private func status(_ state: String, progress: String = "null", result: String = "null") -> (Int, String) {
    (200, #"{"payload":{"exportId":"data-export:AAAAAAAAAAAAAAAAAAAAAA","state":"\#(state)","startedAt":null,"finishedAt":null,"failureCode":null,"progress":\#(progress),"result":\#(result),"generatedAt":"2026-11-13T00:00:00Z"}}"#)
}

private let readyResult = #"{"downloadPath":"/api/data-export/v1/archive?exportId=data-export:AAAAAAAAAAAAAAAAAAAAAA","fileName":"a.zip","sizeBytes":2048,"sha256":"\#(String(repeating: "a", count: 64))","memories":1280,"rules":12,"withheld":0,"expiresAt":"2026-11-13T00:10:00Z"}"#

@MainActor
final class DataExportSessionTests: XCTestCase {
    private func session(_ transport: ExportTransport) -> DataExportSession {
        DataExportSession(
            gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }),
            pollInterval: .milliseconds(1)
        )
    }

    func testStartingAsksForFaceIDThenFollowsTheRealProgressUntilReady() async {
        let transport = ExportTransport(statuses: [
            status("running", progress: #"{"textsRead":0,"textsTotal":0}"#),
            status("running", progress: #"{"textsRead":214,"textsTotal":346}"#),
            status("ready", result: readyResult),
        ])
        let export = session(transport)
        await export.start(reason: "导出")
        guard case .ready(let result) = export.stage else { return XCTFail("\(export.stage)") }
        XCTAssertEqual(result.memories, 1280)
        XCTAssertEqual(result.rules, 12)
        let sent = await transport.sent
        let start = sent.firstIndex { $0["type"] == "data.export.start" }!
        XCTAssertEqual(sent[start - 1], [:])
    }

    func testProgressBarOnlyAppearsWhenThereIsATotal() {
        XCTAssertNil(DataExportProgress(textsRead: 0, textsTotal: 0).fraction)
        XCTAssertEqual(DataExportProgress(textsRead: 173, textsTotal: 346).fraction, 0.5)
    }

    func testAGoneExportReadsAsExpiredNotFailed() async {
        let transport = ExportTransport(statuses: [(404, #"{"error":{"code":"NOT_FOUND"}}"#)])
        let export = session(transport)
        await export.start(reason: "导出")
        XCTAssertEqual(export.stage, .expired)
    }

    func testCancelIsRoutineAndReturnsToBeforeTheExport() async throws {
        let transport = ExportTransport(statuses: [status("running")])
        let export = session(transport)
        let following = Task { await export.start(reason: "导出") }
        while export.stage == .idle || export.stage == .starting { await Task.yield() }
        try await export.cancel()
        await following.value
        XCTAssertEqual(export.stage, .idle)
        let sent = await transport.sent
        let cancel = sent.firstIndex { $0["type"] == "data.export.cancel" }!
        XCTAssertNotEqual(sent[cancel - 1], [:])
        guard case .object(let payload)? = sent[cancel]["payload"] else { return XCTFail() }
        XCTAssertEqual(payload["exportId"], "data-export:AAAAAAAAAAAAAAAAAAAAAA")
    }

    func testCancelledOnTheServerAlsoReturnsToBeforeTheExport() async {
        let transport = ExportTransport(statuses: [status("cancelled")])
        let export = session(transport)
        await export.start(reason: "导出")
        XCTAssertEqual(export.stage, .idle)
    }
}
