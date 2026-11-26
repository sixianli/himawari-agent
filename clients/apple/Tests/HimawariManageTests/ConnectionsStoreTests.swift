import Foundation
import XCTest
@testable import HimawariManage

private actor ConnectionsServer: DeviceTransport {
    private(set) var paths: [String] = []
    var status = 200
    var body = #"{"connections":[{"name":"gmail","title":"Gmail","status":"connected","account":"andy@example.com","connectedAt":"2026-11-26T08:00:00.000Z"}]}"#

    func set(status: Int? = nil, body: String? = nil) {
        if let status { self.status = status }
        if let body { self.body = body }
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        await answer(path)
    }

    private func answer(_ path: String) -> DeviceResponse {
        paths.append(path)
        return DeviceResponse(status: status, body: Data(body.utf8))
    }
}

@MainActor
final class ConnectionsStoreTests: XCTestCase {
    private func store(_ server: ConnectionsServer) -> ConnectionsStore {
        ConnectionsStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
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

    func testAConnectionThisAppHasNoPageForIsNotShown() async {
        let server = ConnectionsServer()
        await server.set(body: #"{"connections":[{"name":"dropbox","title":"Dropbox","status":"connected","account":null,"connectedAt":null}]}"#)
        let connections = store(server)
        await connections.load()
        XCTAssertEqual(connections.shown, [])
        XCTAssertFalse(connections.available)
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
