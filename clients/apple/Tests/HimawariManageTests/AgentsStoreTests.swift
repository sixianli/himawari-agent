import Foundation
import XCTest
@testable import HimawariManage

private actor AgentsServer: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private(set) var confirmed: [String] = []
    var failCommands = false
    var connections = #"[{"id":"conn-1","name":"Claude","capabilities":["mcp"],"pushPolicy":"ask","status":"active","reportedClient":null,"createdAt":"2026-11-26T08:00:00.000Z","updatedAt":"2026-11-26T08:00:00.000Z","registration":"metadata_document","clientHost":"claude.ai","lastSeenAt":null,"minute":{"reads":0,"hookReads":0},"usage":{"reads":3,"readsByTool":[],"delivered":1,"empty":2,"autoReads":0,"autoDelivered":0,"modelReads":3,"memoryPushes":2,"ruleProposals":0,"ruleProposalsRateLimited":0,"failed":0,"rateLimited":0}},{"id":"conn-2","name":"Old","capabilities":["mcp"],"pushPolicy":"ask","status":"revoked","reportedClient":null,"createdAt":"2026-11-20T08:00:00.000Z","updatedAt":"2026-11-21T08:00:00.000Z","registration":null,"clientHost":null,"lastSeenAt":null,"minute":{"reads":0,"hookReads":0},"usage":{"reads":0,"readsByTool":[],"delivered":0,"empty":0,"autoReads":0,"autoDelivered":0,"modelReads":0,"memoryPushes":0,"ruleProposals":0,"ruleProposalsRateLimited":0,"failed":0,"rateLimited":0}}]"#

    func failing() { failCommands = true }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-26T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return await answer(body, confirmed: confirm != nil)
    }

    private func answer(_ body: [String: JSONValue], confirmed isConfirmed: Bool) -> DeviceResponse {
        sent.append(body)
        guard case .string(let type) = body["type"] else { return DeviceResponse(status: 400, body: Data()) }
        if isConfirmed { confirmed.append(type) }
        switch type {
        case "mcp.connections.read":
            return DeviceResponse(status: 200, body: Data(#"{"payload":{"connections":\#(connections),"window":{"fromDay":"2026-11-20","toDay":"2026-11-26","days":7},"limits":[],"generatedAt":"2026-11-26T08:00:00.000Z"}}"#.utf8))
        case "mcp.grants.read":
            return DeviceResponse(status: 200, body: Data(#"{"payload":{"grants":[{"id":"grant-AAAAAAAAAAAAAAAAAAAAAA","clientName":"Claude","registration":"metadata_document","clientHost":"claude.ai","redirectHost":"claude.ai","localRedirect":false,"wantsWrite":true,"existingConnection":null,"createdAt":"2026-11-26T08:00:00.000Z","expiresAt":"2999-01-01T00:00:00.000Z"}],"defaults":{"pushPolicy":"ask"},"generatedAt":"2026-11-26T08:00:00.000Z"}}"#.utf8))
        default:
            if failCommands { return DeviceResponse(status: 409, body: Data(#"{"error":{"code":"MCP_GRANT_UNKNOWN"}}"#.utf8)) }
            return DeviceResponse(status: 200, body: Data(#"{"kind":"result","payload":{"status":"applied"}}"#.utf8))
        }
    }
}

@MainActor
final class AgentsStoreTests: XCTestCase {
    private func store(_ server: AgentsServer) -> AgentsStore {
        AgentsStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
    }

    func testRevokedAccessIsNotShown() async {
        let agents = store(AgentsServer())
        await agents.load()
        XCTAssertEqual(agents.phase, .loaded)
        XCTAssertEqual(agents.shown.map(\.name), ["Claude"])
        XCTAssertTrue(agents.available)
        XCTAssertEqual(agents.shown.first?.usage.memoryPushes, 2)
    }

    func testNoAccessHidesTheRow() {
        XCTAssertFalse(AgentsStore(agents: []).available)
        XCTAssertFalse(AgentsStore(agents: nil).available)
    }

    func testAGrantStartsFromTheServerDefaults() async {
        let agents = store(AgentsServer())
        await agents.loadGrants()
        guard let grant = agents.grants.first else { return XCTFail("expected a grant") }
        XCTAssertEqual(agents.choice(for: grant), AgentGrantChoice(name: "Claude", pushPolicy: .ask, write: true))
    }

    func testApprovingSendsTheChoiceWithFaceIDAndDropsTheGrant() async throws {
        let server = AgentsServer()
        let agents = store(server)
        await agents.loadGrants()
        let grant = agents.grants[0]
        var choice = agents.choice(for: grant)
        choice.name = "  我的 Claude  "
        try await agents.approve(grant, choice)
        let command = await server.sent.first { $0["type"] == .string("mcp.grant.approve") }
        XCTAssertEqual(command?["payload"], .object([
            "grantId": .string("grant-AAAAAAAAAAAAAAAAAAAAAA"),
            "name": .string("我的 Claude"),
            "pushPolicy": .string("ask"),
            "write": .bool(true),
        ]))
        let confirmed = await server.confirmed
        XCTAssertEqual(confirmed, ["mcp.grant.approve"])
        XCTAssertTrue(agents.grants.isEmpty)
    }

    func testDecliningNeedsNoFaceID() async throws {
        let server = AgentsServer()
        let agents = store(server)
        await agents.loadGrants()
        try await agents.deny(agents.grants[0])
        let command = await server.sent.first { $0["type"] == .string("mcp.grant.deny") }
        XCTAssertEqual(command?["payload"], .object(["grantId": .string("grant-AAAAAAAAAAAAAAAAAAAAAA")]))
        let confirmed = await server.confirmed
        XCTAssertTrue(confirmed.isEmpty)
        XCTAssertTrue(agents.grants.isEmpty)
    }

    func testAnExpiredGrantFailsAndStaysListed() async {
        let server = AgentsServer()
        let agents = store(server)
        await agents.loadGrants()
        await server.failing()
        let grant = agents.grants[0]
        do {
            try await agents.approve(grant, agents.choice(for: grant))
            XCTFail("expected the approval to fail")
        } catch {
            XCTAssertEqual(agents.grants.map(\.id), [grant.id])
        }
    }

    func testChangingOneSettingSendsOnlyThatField() async throws {
        let server = AgentsServer()
        let agents = store(server)
        await agents.load()
        try await agents.change(agents.shown[0], pushPolicy: .direct)
        let command = await server.sent.first { $0["type"] == .string("mcp.connection.change") }
        XCTAssertEqual(command?["payload"], .object([
            "connectionId": .string("conn-1"),
            "name": .null,
            "capabilities": .null,
            "pushPolicy": .string("direct"),
            "status": .null,
        ]))
    }
}
