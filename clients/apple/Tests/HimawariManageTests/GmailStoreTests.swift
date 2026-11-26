import Foundation
import XCTest
@testable import HimawariManage

private actor GmailServer: DeviceTransport {
    private(set) var posts: [(path: String, body: [String: JSONValue])] = []
    var connection = #"{"status":"disconnected","account":null,"connectedAt":null}"#
    var decisions = "[]"
    var source = "gmail"
    var start = #"{"kind":"browser","authorizationUrl":"https://accounts.google.com/o/oauth2/v2/auth?state=s"}"#
    var outcome = "connected"

    func set(connection: String? = nil, decisions: String? = nil, source: String? = nil, start: String? = nil, outcome: String? = nil) {
        if let connection { self.connection = connection }
        if let decisions { self.decisions = decisions }
        if let source { self.source = source }
        if let start { self.start = start }
        if let outcome { self.outcome = outcome }
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-26T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return await answer(path, body)
    }

    private func answer(_ path: String, _ body: [String: JSONValue]) -> DeviceResponse {
        posts.append((path, body))
        switch path {
        case GmailStore.startPath:
            return DeviceResponse(status: 200, body: Data(start.utf8))
        case GmailStore.completePath:
            if outcome == "connected" {
                connection = #"{"status":"connected","account":"andy@example.com","connectedAt":"2026-11-26T08:00:00.000Z"}"#
            }
            return DeviceResponse(status: 200, body: Data(#"{"outcome":"\#(outcome)"}"#.utf8))
        default:
            if body["type"] == .string("proactive.source.manage") {
                connection = #"{"status":"disconnected","account":null,"connectedAt":null}"#
                return DeviceResponse(status: 200, body: Data(#"{"type":"command.accepted"}"#.utf8))
            }
            let overview = #"{"source":"\#(source)","connection":\#(connection),"dailyLimitReached":false,"decisions":\#(decisions)}"#
            return DeviceResponse(status: 200, body: Data(#"{"payload":\#(overview)}"#.utf8))
        }
    }
}

@MainActor
final class GmailStoreTests: XCTestCase {
    private let scheme = "win.siyi.himawari.app"

    private func store(_ server: GmailServer) -> GmailStore {
        GmailStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }), callbackScheme: scheme)
    }

    func testConnectingOpensGoogleThenFinishesWithTheStateGoogleSentBack() async {
        let server = GmailServer()
        let gmail = store(server)
        await gmail.load()
        XCTAssertEqual(gmail.status, .disconnected)
        var opened: [(URL, String)] = []
        let outcome = await gmail.connect { page, callback in
            opened.append((page, callback))
            return URL(string: "\(callback)://gmail-authorization?state=abc123")
        }
        XCTAssertEqual(outcome, .connected)
        XCTAssertEqual(opened.first?.0.host(), "accounts.google.com")
        XCTAssertEqual(opened.first?.1, scheme)
        let posts = await server.posts.filter { $0.path != ManageGateway.gatewayPath }
        XCTAssertEqual(posts.map(\.path), [GmailStore.startPath, GmailStore.completePath])
        XCTAssertEqual(posts.first?.body, ["connection": .string("gmail"), "callbackScheme": .string(scheme)])
        XCTAssertEqual(posts.last?.body, ["state": .string("abc123")])
        guard case .connected(let account, let since, _) = gmail.status else { return XCTFail("not connected") }
        XCTAssertEqual(account, "andy@example.com")
        XCTAssertNotNil(since)
    }

    func testCancellingOrAForeignReturnNeverFinishes() async {
        let server = GmailServer()
        let gmail = store(server)
        await gmail.load()
        let cancelled = await gmail.connect { _, _ in nil }
        XCTAssertEqual(cancelled, .cancelled)
        let foreign = await gmail.connect { _, _ in URL(string: "https://evil.example/gmail-authorization?state=abc123") }
        XCTAssertEqual(foreign, .failed)
        let noState = await gmail.connect { _, callback in URL(string: "\(callback)://gmail-authorization") }
        XCTAssertEqual(noState, .failed)
        let finishing = await server.posts.filter { $0.path == GmailStore.completePath }
        XCTAssertTrue(finishing.isEmpty)
        XCTAssertEqual(gmail.status, .disconnected)
    }

    func testRefusalAtGoogleIsReportedAsDenied() async {
        let server = GmailServer()
        await server.set(outcome: "denied")
        let gmail = store(server)
        let outcome = await gmail.connect { _, callback in URL(string: "\(callback)://gmail-authorization?state=abc123") }
        XCTAssertEqual(outcome, .denied)
        XCTAssertEqual(gmail.status, .disconnected)
    }

    func testDemoMailboxConnectsWithoutOpeningGoogle() async {
        let server = GmailServer()
        await server.set(start: #"{"kind":"demo"}"#)
        let gmail = store(server)
        var opened = false
        let outcome = await gmail.connect { _, _ in
            opened = true
            return nil
        }
        XCTAssertEqual(outcome, .connected)
        XCTAssertFalse(opened)
    }

    func testExpiredAccessShowsWhenMailStoppedBeingRead() async {
        let server = GmailServer()
        await server.set(
            connection: #"{"status":"needs_reconnect","account":"andy@example.com","connectedAt":"2026-11-20T00:00:00.000Z"}"#,
            decisions: #"[{"checkedAt":"2026-11-26T08:00:00.000Z","verdict":"needs_owner"},{"checkedAt":"2026-11-26T07:45:00.000Z","verdict":"needs_owner"},{"checkedAt":"2026-11-26T07:30:00.000Z","verdict":"silent"}]"#
        )
        let gmail = store(server)
        await gmail.load()
        XCTAssertEqual(gmail.status, .needsReconnect(unreadSince: Timestamp.parse("2026-11-26T07:45:00.000Z")))
    }

    func testLastReadSkipsChecksThatDidNotReadMail() async {
        let server = GmailServer()
        await server.set(
            connection: #"{"status":"connected","account":"andy@example.com","connectedAt":"2026-11-20T00:00:00.000Z"}"#,
            decisions: #"[{"checkedAt":"2026-11-26T08:00:00.000Z","verdict":"failed"},{"checkedAt":"2026-11-26T07:45:00.000Z","verdict":"silent"}]"#
        )
        let gmail = store(server)
        await gmail.load()
        guard case .connected(_, _, let lastRead) = gmail.status else { return XCTFail("not connected") }
        XCTAssertEqual(lastRead, Timestamp.parse("2026-11-26T07:45:00.000Z"))
    }

    func testDisconnectingAsksForFaceIDAndShowsDisconnected() async throws {
        let server = GmailServer()
        await server.set(connection: #"{"status":"connected","account":"andy@example.com","connectedAt":null}"#)
        let gmail = store(server)
        await gmail.load()
        try await gmail.disconnect(reason: "断开 Gmail")
        let command = await server.posts.first { $0.body["type"] == .string("proactive.source.manage") }
        XCTAssertEqual(command?.body["payload"], .object(["source": .string("gmail"), "action": .string("disconnect")]))
        XCTAssertEqual(gmail.status, .disconnected)
    }

    func testRowStaysHiddenWithoutGmailOnTheServer() async {
        let server = GmailServer()
        await server.set(source: "test_notes")
        let gmail = store(server)
        await gmail.load()
        XCTAssertFalse(gmail.available)
        XCTAssertNil(gmail.status)
        let unreachable = GmailStore(overview: nil)
        XCTAssertFalse(unreachable.available)
    }
}
