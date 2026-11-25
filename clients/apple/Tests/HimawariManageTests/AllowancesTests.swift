import Foundation
import XCTest
@testable import HimawariManage

private actor AllowanceServer: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private let refuseRevoke: Bool

    init(refuseRevoke: Bool) {
        self.refuseRevoke = refuseRevoke
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        await record(body)
        switch body["type"] {
        case .string("memory.overview.read"):
            return DeviceResponse(status: 200, body: Data(#"{"payload":{"memories":[],"imports":[],"capturePaused":false}}"#.utf8))
        case .string("memory.rules.read"):
            return DeviceResponse(status: 200, body: Data(Self.rules.utf8))
        case .string("memory.rule.respond") where refuseRevoke:
            return DeviceResponse(status: 409, body: Data(#"{"error":{"code":"PORT_CONFLICT"}}"#.utf8))
        default:
            return DeviceResponse(status: 200, body: Data("{}".utf8))
        }
    }

    private func record(_ body: [String: JSONValue]) {
        sent.append(body)
    }

    static let rules = #"""
    {"payload":{"rules":[],"allowances":[
      {"allowanceId":"allowance:a1","allowFor":"always","title":"给 田中 发邮件","operation":"mail.send","recipients":["tanaka@example.co.jp"],"threadId":null,"expiresAt":null,"createdAt":"2026-11-24T03:00:00.000Z"},
      {"allowanceId":"allowance:a2","allowFor":"days","title":"改日历里的工作日程","operation":"calendar.update","recipients":[],"threadId":null,"expiresAt":"2026-12-02T03:00:00.000Z","createdAt":"2026-11-25T03:00:00.000Z"}
    ]}}
    """#
}

@MainActor
final class AllowancesTests: XCTestCase {
    private func store(_ server: AllowanceServer) async -> MemoryStore {
        let store = MemoryStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        await store.load()
        return store
    }

    func testTheRuleBookCarriesTheAllowancesTheOwnerGave() async throws {
        let store = await store(AllowanceServer(refuseRevoke: false))
        XCTAssertEqual(store.allowances.map(\.allowanceId), ["allowance:a1", "allowance:a2"])
        XCTAssertEqual(store.allowances.map(\.title), ["给 田中 发邮件", "改日历里的工作日程"])
    }

    func testAnOlderServerWithoutAllowancesShowsNone() throws {
        let book = try JSONDecoder().decode(RuleBook.self, from: Data(#"{"rules":[]}"#.utf8))
        XCTAssertNil(book.allowances)
    }

    func testRevokingSendsTheAllowanceIdAndRemovesTheRow() async throws {
        let server = AllowanceServer(refuseRevoke: false)
        let store = await store(server)
        let first = try XCTUnwrap(store.allowances.first)
        try await store.revoke(first, reason: first.title)
        XCTAssertEqual(store.allowances.map(\.allowanceId), ["allowance:a2"])
        let command = await server.sent.first { $0["type"] == .string("memory.rule.respond") }
        XCTAssertEqual(command?["payload"], .object(["target": .string("allowance:a1"), "action": .string("revoke")]))
    }

    func testAFailedRevokePutsTheRowBackWhereItWas() async throws {
        let store = await store(AllowanceServer(refuseRevoke: true))
        let first = try XCTUnwrap(store.allowances.first)
        do {
            try await store.revoke(first, reason: first.title)
            XCTFail("revoke should fail")
        } catch {}
        XCTAssertEqual(store.allowances.map(\.allowanceId), ["allowance:a1", "allowance:a2"])
    }
}
