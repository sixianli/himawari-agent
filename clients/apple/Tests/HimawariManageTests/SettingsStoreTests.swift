import Foundation
import HimawariCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import HimawariManage

private final class DirectoryServer: HTTPExchange, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [URLRequest] = []

    static let roster = #"""
    {"thisDeviceId":"dev_phone","devices":[
      {"id":"dev_phone","revision":1,"kind":"iphone","name":"Andy 的 iPhone","releaseChannel":"testflight","status":"active","pairedAt":"2026-11-26T00:00:00.000Z","lastSeenAt":"2026-11-26T00:00:00.000Z"},
      {"id":"dev_watch","revision":2,"kind":"watch","name":"Apple Watch","releaseChannel":"direct","status":"active","pairedAt":"2026-11-02T00:00:00.000Z","lastSeenAt":null},
      {"id":"dev_mac","revision":4,"kind":"mac","name":"MacBook Air","releaseChannel":"mac_direct","status":"active","pairedAt":"2026-11-25T00:00:00.000Z","lastSeenAt":"2026-11-26T01:00:00.000Z","online":true},
      {"id":"dev_old","revision":5,"kind":"mac","name":"旧 Mac","releaseChannel":"mac_direct","status":"revoked","pairedAt":"2026-10-02T00:00:00.000Z","lastSeenAt":null}
    ],"server":{"origin":"https://h.example","since":"2026-11-26T00:00:00.000Z"}}
    """#

    func send(_ request: URLRequest) async throws -> HTTPExchangeResponse {
        lock.withLock { requests.append(request) }
        switch request.url?.path {
        case "/api/device/v1/devices": return HTTPExchangeResponse(status: 200, body: Data(Self.roster.utf8))
        case "/api/device/v1/approvals/challenge": return HTTPExchangeResponse(status: 201, body: Data(#"{"challenge":"nonce-1"}"#.utf8))
        default: return HTTPExchangeResponse(status: 200, body: Data(#"{"device":{}}"#.utf8))
        }
    }

    func stream(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<String, Error>) {
        throw HTTPExchangeError.streamingUnsupported
    }

    var paths: [String] { lock.withLock { requests.compactMap { $0.url?.path } } }

    func body(at index: Int) throws -> [String: Any] {
        let request = lock.withLock { requests[index] }
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    }

    func signatureInput(at index: Int) -> String? {
        lock.withLock { requests[index].value(forHTTPHeaderField: "Signature-Input") }
    }
}

@MainActor
final class SettingsStoreTests: XCTestCase {
    private func store(_ server: DirectoryServer) throws -> SettingsStore {
        let http = DeviceHTTPClient(exchange: server)
        http.use(DeviceCredentials(origin: URL(string: "https://h.example")!, deviceId: "dev_phone", access: nil, deviceKey: try SoftwareKeySigner()))
        return SettingsStore(directory: SignedDeviceDirectory(http: http, confirmKey: try SoftwareKeySigner()))
    }

    func testListShowsThisDeviceFirstThenOthersByLastSeenAndLeavesOutRemovedOnes() async throws {
        let settings = try store(DirectoryServer())
        await settings.load()
        XCTAssertEqual(settings.phase, .loaded)
        XCTAssertEqual(settings.thisDevice?.id, "dev_phone")
        XCTAssertEqual(settings.otherDevices.map(\.id), ["dev_mac", "dev_watch"])
        XCTAssertEqual(settings.server?.origin, "https://h.example")
        XCTAssertEqual(settings.presence(try XCTUnwrap(settings.thisDevice)), .connected)
        XCTAssertEqual(settings.presence(settings.otherDevices[0]), .connected)
        XCTAssertEqual(settings.presence(settings.otherDevices[1]), .neverSeen)
    }

    func testOtherDevicesShowWhenTheyWereLastSeenNotConnected() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(DevicePresence.of(lastSeenAt: now.addingTimeInterval(-30), now: now), .justNow)
        XCTAssertEqual(DevicePresence.of(lastSeenAt: now.addingTimeInterval(-90), now: now), .seen(now.addingTimeInterval(-90)))
        XCTAssertEqual(DevicePresence.of(lastSeenAt: nil, now: now), .neverSeen)
    }

    func testUnknownKindsAndChannelsNeverShowMachineCodes() {
        let unknown = PairedDevice(
            id: "dev_x", revision: 0, kind: "glasses", name: "眼镜", releaseChannel: "side_load", status: "active",
            pairedAt: "2026-11-12T00:00:00Z", lastSeenAt: nil, online: nil
        )
        XCTAssertNil(M.channel(unknown.releaseChannel))
        XCTAssertEqual(DevicePresence.of(unknown, isThisDevice: false), .neverSeen)
    }

    func testDeviceNamesFollowTheServerRules() {
        XCTAssertEqual(DeviceName.accepted("  手表  "), "手表")
        XCTAssertEqual(DeviceName.accepted(String(repeating: "a", count: 64))?.count, 64)
        XCTAssertNil(DeviceName.accepted(String(repeating: "a", count: 65)))
        XCTAssertNil(DeviceName.accepted("   "))
        for hidden in ["\u{200B}", "\u{202E}", "\u{061C}", "\u{2028}", "\u{2029}", "\u{0007}"] {
            XCTAssertNil(DeviceName.accepted("手\(hidden)表"), hidden.unicodeScalars.first.map { String($0.value, radix: 16) } ?? "")
        }
    }

    func testRemovingAnotherDeviceIsSignedWithTheConfirmKeyOverTheServersChallenge() async throws {
        let server = DirectoryServer()
        let settings = try store(server)
        await settings.load()
        let mac = try XCTUnwrap(settings.otherDevices.first)
        try await settings.revoke(mac, reason: "移除 MacBook Air")
        XCTAssertEqual(Array(server.paths.dropFirst()), ["/api/device/v1/approvals/challenge", "/api/device/v1/devices/revoke", "/api/device/v1/devices"])
        let body = try server.body(at: 2)
        XCTAssertEqual(body["deviceId"] as? String, "dev_mac")
        XCTAssertEqual(body["expectedRevision"] as? Int, 4)
        let input = try XCTUnwrap(server.signatureInput(at: 2))
        XCTAssertTrue(input.contains("confirm=("))
        XCTAssertTrue(input.contains("nonce=\"nonce-1\""))
    }

    func testSigningOutRemovesThisDeviceWithItsOwnKeyAndDoesNotAskForFaceID() async throws {
        let server = DirectoryServer()
        let settings = try store(server)
        await settings.load()
        try await settings.revoke(try XCTUnwrap(settings.thisDevice), reason: "退出登录")
        XCTAssertEqual(Array(server.paths.dropFirst()), ["/api/device/v1/devices/revoke"])
        XCTAssertEqual(try server.body(at: 1)["deviceId"] as? String, "dev_phone")
        XCTAssertFalse(try XCTUnwrap(server.signatureInput(at: 1)).contains("confirm=("))
    }

    func testRenameSendsTrimmedNameAndRevision() async throws {
        let server = DirectoryServer()
        let settings = try store(server)
        await settings.load()
        try await settings.rename(settings.otherDevices[1], to: "  手表  ")
        XCTAssertEqual(server.paths[1], "/api/device/v1/devices/rename")
        let body = try server.body(at: 1)
        XCTAssertEqual(body["name"] as? String, "手表")
        XCTAssertEqual(body["expectedRevision"] as? Int, 2)
    }
}
