import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor Recorder: DeviceTransport {
    private(set) var gatewayBodies: [[String: JSONValue]] = []
    private(set) var challenges = 0

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            await countChallenge()
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        if path == ManageGateway.textPath {
            return DeviceResponse(status: 200, body: Data(#"{"payloadRef":"ref-1"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        await record(body)
        if case .string("memory.classify.read")? = body["type"] {
            let item = #"{"contentRef":"ref-1","category":"health","classification":"private","topic":null,"failed":false}"#
            return DeviceResponse(status: 200, body: Data(#"{"payload":{"items":[\#(item)]}}"#.utf8))
        }
        return DeviceResponse(status: 200, body: Data(#"{"payload":{}}"#.utf8))
    }

    private func record(_ body: [String: JSONValue]) { gatewayBodies.append(body) }
    private func countChallenge() { challenges += 1 }
}

@MainActor
final class MemoryDecisionTests: XCTestCase {
    private func store(_ recorder: Recorder) -> MemoryStore {
        MemoryStore(gateway: ManageGateway(transport: recorder, makeIdentifier: { "0123456789abcdef0123" }))
    }

    private func proposal() throws -> MemoryExternalProposal {
        let body = #"{"proposalId":"p1","text":"喜欢靠窗","category":"preference","dataClassification":"private","client":"Codex","receivedAt":"2026-11-15T01:00:00.000Z"}"#
        return try JSONDecoder().decode(MemoryExternalProposal.self, from: Data(body.utf8))
    }

    func testDecliningAnExternalProposalNeedsNoConfirmationButKeepingDoes() async throws {
        let recorder = Recorder()
        let memory = store(recorder)
        try await memory.answer(try proposal(), keep: false)
        let afterDecline = await recorder.challenges
        XCTAssertEqual(afterDecline, 0)
        try await memory.answer(try proposal(), keep: true)
        let afterKeep = await recorder.challenges
        XCTAssertEqual(afterKeep, 1)
    }

    func testExternalDecisionCarriesEditedTextAsNull() {
        let payload = MemoryDecision.externalPayload(proposalId: "p1", keep: true)
        XCTAssertEqual(
            payload,
            ["items": .array([["proposalId": "p1", "decision": "keep", "editedText": nil]])]
        )
    }

    func testApprovalPayloadUsesTheServersResolutionNames() {
        XCTAssertEqual(
            MemoryDecision.approvalPayload(requestId: "r1", approved: false),
            ["requestId": "r1", "resolution": "rejected", "editedText": nil]
        )
    }

    func testCreatingAHealthMemoryUploadsItAsSensitiveWithTheHealthTopic() async throws {
        let recorder = Recorder()
        try await store(recorder).create("对花生过敏")
        let bodies = await recorder.gatewayBodies
        let create = bodies.first { $0["type"] == .string("memory.create") }
        guard case .object(let payload)? = create?["payload"] else { return XCTFail("memory.create was not sent") }
        XCTAssertEqual(payload["category"], .string("health"))
        XCTAssertEqual(payload["topic"], .string("health"))
        XCTAssertEqual(payload["pinned"], .bool(false))
    }
}
