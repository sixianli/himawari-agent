import Foundation
import XCTest
@testable import HimawariManage

private actor ConnectionsServer: DeviceTransport {
    private(set) var paths: [String] = []
    private(set) var bodies: [String: [String: JSONValue]] = [:]
    var status = 200
    var body = #"{"connections":[{"name":"gmail","title":"Gmail","status":"connected","account":"andy@example.com","connectedAt":"2026-11-26T08:00:00.000Z"}]}"#
    var outcome = "connected"

    func set(status: Int? = nil, body: String? = nil, outcome: String? = nil) {
        if let status { self.status = status }
        if let body { self.body = body }
        if let outcome { self.outcome = outcome }
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        let decoded = (try? JSONDecoder().decode([String: JSONValue].self, from: json)) ?? [:]
        return await answer(path, decoded)
    }

    private func answer(_ path: String, _ decoded: [String: JSONValue]) -> DeviceResponse {
        paths.append(path)
        bodies[path] = decoded
        switch path {
        case ConnectionAuthorization.startPath:
            return DeviceResponse(status: 200, body: Data(#"{"kind":"browser","authorizationUrl":"https://github.com/login/oauth/authorize?state=s"}"#.utf8))
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
}
