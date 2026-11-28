import Foundation
import XCTest
@testable import HimawariManage

private actor ConnectionsServer: DeviceTransport {
    private(set) var paths: [String] = []
    private(set) var bodies: [String: [String: JSONValue]] = [:]
    private(set) var confirmed: [String: String] = [:]
    var started = #"{"kind":"browser","authorizationUrl":"https://github.com/login/oauth/authorize?state=s"}"#
    var addAnswer = (200, #"{"outcome":"added","connection":{"name":"app_0123456789ab","title":"Linear","status":"disconnected","account":null,"connectedAt":null,"added":true}}"#)
    var status = 200
    var body = #"{"connections":[{"name":"gmail","title":"Gmail","status":"connected","account":"andy@example.com","connectedAt":"2026-11-26T08:00:00.000Z"}]}"#
    var outcome = "connected"

    func set(started: String? = nil, addAnswer: (Int, String)? = nil) {
        if let started { self.started = started }
        if let addAnswer { self.addAnswer = addAnswer }
    }

    func set(status: Int? = nil, body: String? = nil, outcome: String? = nil) {
        if let status { self.status = status }
        if let body { self.body = body }
        if let outcome { self.outcome = outcome }
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        let decoded = (try? JSONDecoder().decode([String: JSONValue].self, from: json)) ?? [:]
        return await answer(path, decoded, nonce: nonce, confirm: confirm)
    }

    private func answer(_ path: String, _ decoded: [String: JSONValue], nonce: String?, confirm: ConfirmPrompt?) -> DeviceResponse {
        paths.append(path)
        bodies[path] = decoded
        if let nonce, let confirm { confirmed[path] = "\(nonce)|\(confirm.reason)" }
        switch path {
        case ManageGateway.challengePath:
            return DeviceResponse(status: 200, body: Data(#"{"challenge":"nonce-1"}"#.utf8))
        case ConnectionsStore.addPath:
            if addAnswer.0 == 200, addAnswer.1.contains(#""added""#) {
                body = #"{"connections":[{"name":"app_0123456789ab","title":"Linear","status":"disconnected","account":null,"connectedAt":null,"added":true}]}"#
            }
            return DeviceResponse(status: addAnswer.0, body: Data(addAnswer.1.utf8))
        case ConnectionsStore.removePath:
            body = #"{"connections":[]}"#
            return DeviceResponse(status: 200, body: Data(#"{"removed":true}"#.utf8))
        case ConnectionAuthorization.startPath:
            return DeviceResponse(status: 200, body: Data(started.utf8))
        case ConnectionAuthorization.completePath:
            if outcome == "connected" {
                body = #"{"connections":[{"name":"github","title":"GitHub","status":"connected","account":null,"connectedAt":"2026-11-26T08:00:00.000Z"}]}"#
            }
            return DeviceResponse(status: 200, body: Data(#"{"outcome":"\#(outcome)"}"#.utf8))
        case ConnectionsStore.disconnectPath:
            body = #"{"connections":[{"name":"github","title":"GitHub","status":"disconnected","account":null,"connectedAt":null}]}"#
            return DeviceResponse(status: 200, body: Data(#"{"disconnected":true}"#.utf8))
        default:
            return DeviceResponse(status: status, body: Data(body.utf8))
        }
    }
}

@MainActor
final class ConnectionsStoreTests: XCTestCase {
    private let scheme = "win.siyi.himawari.app"

    private func store(_ server: ConnectionsServer) -> ConnectionsStore {
        ConnectionsStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }), callbackScheme: scheme)
    }

    func testListsTheConnectionsTheServerOffersWithGmailFirst() async {
        let server = ConnectionsServer()
        let connections = store(server)
        await connections.load()
        let paths = await server.paths
        XCTAssertEqual(paths, [ConnectionsStore.listPath])
        XCTAssertTrue(connections.available)
        XCTAssertEqual(connections.shown.map(\.name), ["gmail"])
        XCTAssertEqual(connections.shown.first?.account, "andy@example.com")
        XCTAssertEqual(connections.connectedTitles, ["Gmail"])
        XCTAssertFalse(connections.needsReconnect)
    }

    func testExpiredGmailIsFlaggedAndNotCountedAsConnected() async {
        let server = ConnectionsServer()
        await server.set(body: #"{"connections":[{"name":"gmail","title":"Gmail","status":"needs_reconnect","account":"andy@example.com","connectedAt":null}]}"#)
        let connections = store(server)
        await connections.load()
        XCTAssertTrue(connections.needsReconnect)
        XCTAssertEqual(connections.connectedTitles, [])
    }

    func testEveryAppTheServerOffersIsShownWithItsOwnPage() async {
        let server = ConnectionsServer()
        await server.set(body: #"{"connections":[{"name":"gmail","title":"Gmail","status":"disconnected","account":null,"connectedAt":null},{"name":"github","title":"GitHub","status":"connected","account":null,"connectedAt":null}]}"#)
        let connections = store(server)
        await connections.load()
        XCTAssertEqual(connections.shown.map(\.name), ["gmail", "github"])
        XCTAssertTrue(connections.available)
        XCTAssertEqual(connections.connectedTitles, ["GitHub"])
        XCTAssertEqual(connections.connection(named: "github")?.title, "GitHub")
    }

    func testConnectingAnAppSignsInThroughTheServerAndFinishesWithTheReturnedState() async {
        let server = ConnectionsServer()
        await server.set(body: #"{"connections":[{"name":"github","title":"GitHub","status":"disconnected","account":null,"connectedAt":null}]}"#)
        let connections = store(server)
        await connections.load()
        var opened: [(URL, String)] = []
        let outcome = await connections.connect("github") { page, callback in
            opened.append((page, callback))
            return URL(string: "\(callback)://connection-authorization?state=abc123")
        }
        XCTAssertEqual(outcome, .connected)
        XCTAssertEqual(opened.first?.0.host(), "github.com")
        XCTAssertEqual(opened.first?.1, scheme)
        let bodies = await server.bodies
        XCTAssertEqual(bodies[ConnectionAuthorization.startPath], ["connection": .string("github"), "callbackScheme": .string(scheme)])
        XCTAssertEqual(bodies[ConnectionAuthorization.completePath], ["state": .string("abc123")])
        XCTAssertEqual(connections.connection(named: "github")?.status, "connected")
        XCTAssertNil(connections.connecting)
    }

    func testAReturnForGmailOrAnotherSiteOrACancelNeverFinishesAnAppSignIn() async {
        let server = ConnectionsServer()
        let connections = store(server)
        let gmailReturn = await connections.connect("github") { _, callback in URL(string: "\(callback)://gmail-authorization?state=abc123") }
        XCTAssertEqual(gmailReturn, .failed)
        let foreign = await connections.connect("github") { _, _ in URL(string: "https://evil.example/connection-authorization?state=abc123") }
        XCTAssertEqual(foreign, .failed)
        let cancelled = await connections.connect("github") { _, _ in nil }
        XCTAssertEqual(cancelled, .cancelled)
        let paths = await server.paths
        XCTAssertFalse(paths.contains(ConnectionAuthorization.completePath))
    }

    func testARefusalIsReportedAsDenied() async {
        let server = ConnectionsServer()
        await server.set(outcome: "denied")
        let connections = store(server)
        let outcome = await connections.connect("github") { _, callback in URL(string: "\(callback)://connection-authorization?state=abc123") }
        XCTAssertEqual(outcome, .denied)
    }

    func testDisconnectingAnAppAsksTheServerAndReloads() async throws {
        let server = ConnectionsServer()
        await server.set(body: #"{"connections":[{"name":"github","title":"GitHub","status":"connected","account":null,"connectedAt":null}]}"#)
        let connections = store(server)
        await connections.load()
        try await connections.disconnect("github")
        let bodies = await server.bodies
        XCTAssertEqual(bodies[ConnectionsStore.disconnectPath], ["connection": .string("github")])
        XCTAssertEqual(connections.connection(named: "github")?.status, "disconnected")
        XCTAssertEqual(connections.connectedTitles, [])
    }

    func testTheRowStaysHiddenWhenTheServerHasNoConnections() async {
        let server = ConnectionsServer()
        await server.set(status: 404, body: #"{"error":{"code":"NOT_FOUND"}}"#)
        let connections = store(server)
        await connections.load()
        XCTAssertEqual(connections.phase, .unavailable)
        XCTAssertFalse(connections.available)
        XCTAssertFalse(ConnectionsStore(connections: nil).available)
    }

    func testAddingAnAppAsksForFaceIDSendsOnlyWhatWasTypedAndListsItAsAdded() async {
        let server = ConnectionsServer()
        let connections = store(server)
        let outcome = await connections.add(
            NewAppConnection(serverUrl: "  https://mcp.linear.app/mcp ", title: "Linear", clientId: "", clientSecret: ""),
            reason: "Add an app"
        )
        guard case .added(let connection) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(connection.name, "app_0123456789ab")
        XCTAssertTrue(connection.added)
        let bodies = await server.bodies
        XCTAssertEqual(bodies[ConnectionsStore.addPath], ["serverUrl": .string("https://mcp.linear.app/mcp"), "title": .string("Linear")])
        let confirmed = await server.confirmed
        XCTAssertEqual(confirmed[ConnectionsStore.addPath], "nonce-1|Add an app")
        XCTAssertEqual(connections.connection(named: "app_0123456789ab")?.added, true)
        XCTAssertFalse(connections.adding)
    }

    func testARefusedOrUnreachableAddressIsReportedAndNothingIsSentWithoutAnAddress() async {
        let server = ConnectionsServer()
        let connections = store(server)
        await server.set(addAnswer: (200, #"{"outcome":"invalid_address"}"#))
        let refused = await connections.add(NewAppConnection(serverUrl: "http://10.0.0.8/mcp"), reason: "Add")
        XCTAssertEqual(refused, .invalidAddress)
        await server.set(addAnswer: (200, #"{"outcome":"unreachable"}"#))
        let unreachable = await connections.add(NewAppConnection(serverUrl: "https://nothing.example/mcp"), reason: "Add")
        XCTAssertEqual(unreachable, .unreachable)
        await server.set(addAnswer: (403, #"{"error":{"code":"DEVICE_OWNER_PRESENCE_REQUIRED"}}"#))
        let unconfirmed = await connections.add(NewAppConnection(serverUrl: "https://mcp.linear.app/mcp"), reason: "Add")
        XCTAssertEqual(unconfirmed, .failed)
        let before = await server.paths.count
        let blank = await connections.add(NewAppConnection(serverUrl: "   "), reason: "Add")
        let secretOnly = await connections.add(NewAppConnection(serverUrl: "https://mcp.linear.app/mcp", clientSecret: "s"), reason: "Add")
        XCTAssertEqual(blank, .failed)
        XCTAssertEqual(secretOnly, .failed)
        let after = await server.paths.count
        XCTAssertEqual(before, after)
        XCTAssertEqual(connections.shown, [])
    }

    func testRemovingAnAddedAppAsksTheServerAndReloads() async throws {
        let server = ConnectionsServer()
        await server.set(body: #"{"connections":[{"name":"app_0123456789ab","title":"Linear","status":"connected","account":null,"connectedAt":null,"added":true}]}"#)
        let connections = store(server)
        await connections.load()
        try await connections.remove("app_0123456789ab")
        let bodies = await server.bodies
        XCTAssertEqual(bodies[ConnectionsStore.removePath], ["connection": .string("app_0123456789ab")])
        XCTAssertNil(connections.connection(named: "app_0123456789ab"))
    }

    func testAServerThatCannotIssueAClientAsksForOneWithTheCallbackAndNeverOpensASignIn() async {
        let server = ConnectionsServer()
        await server.set(started: #"{"kind":"client_required","redirectUri":"https://himawari.example/api/connections/v1/callback"}"#)
        let connections = store(server)
        var opened = false
        let outcome = await connections.connect("app_0123456789ab") { _, _ in
            opened = true
            return nil
        }
        XCTAssertEqual(outcome, .clientRequired(redirectUri: "https://himawari.example/api/connections/v1/callback"))
        XCTAssertFalse(opened)
        XCTAssertEqual(connections.connection(named: "gmail")?.added, false)
    }
}
