import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor ScriptedTransport: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private let answer: @Sendable ([String: JSONValue]) -> String

    init(answer: @escaping @Sendable ([String: JSONValue]) -> String) {
        self.answer = answer
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        let reply = await record(path == ManageGateway.challengePath ? [:] : body)
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        return DeviceResponse(status: 200, body: Data(reply.utf8))
    }

    private func record(_ body: [String: JSONValue]) -> String {
        sent.append(body)
        return answer(body)
    }
}

@MainActor
final class SettingsStoreTests: XCTestCase {
    private func store(_ transport: ScriptedTransport) -> SettingsStore {
        SettingsStore(
            gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }),
            identity: DeviceIdentity(deviceId: "dev_phone", origin: URL(string: "https://h.example")!, access: nil)
        )
    }

    nonisolated private static let devices = #"""
    {"payload":{"devices":[
      {"id":"dev_phone","revision":1,"kind":"iphone","name":"Andy 的 iPhone","releaseChannel":"direct","status":"active","pairedAt":"2026-11-02T00:00:00Z","lastSeenAt":"2026-11-12T00:00:00Z","pairingNumber":null},
      {"id":"dev_watch","revision":2,"kind":"watch","name":"Apple Watch","releaseChannel":"direct","status":"active","pairedAt":"2026-11-02T00:00:00Z","lastSeenAt":null,"pairingNumber":null},
      {"id":"dev_old","revision":5,"kind":"mac","name":"旧 Mac","releaseChannel":"mac_direct","status":"revoked","pairedAt":"2026-10-02T00:00:00Z","lastSeenAt":null,"pairingNumber":null},
      {"id":"dev_new","revision":0,"kind":"mac","name":"MacBook Pro","releaseChannel":"mac_direct","status":"pending","pairedAt":"2026-11-12T00:00:00Z","lastSeenAt":null,"pairingNumber":"482913"}
    ],"limits":[],"pairing":null,"generatedAt":"2026-11-12T00:00:00Z"}}
    """#

    nonisolated private static func answer(_ body: [String: JSONValue]) -> String {
        body["type"] == "device.list.read" ? devices : "{}"
    }

    func testRevokedDevicesAreLeftOutAndPresenceIsNeverGuessed() async {
        let settings = store(ScriptedTransport(answer: Self.answer))
        await settings.load()
        XCTAssertEqual(settings.devices.map(\.id), ["dev_phone", "dev_watch", "dev_new"])
        XCTAssertEqual(settings.presence(settings.devices[0]), .connected)
        XCTAssertEqual(settings.presence(settings.devices[1]), .neverSeen)
        XCTAssertEqual(settings.presence(settings.devices[2]), .waitingForConfirmation)
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
            pairedAt: "2026-11-12T00:00:00Z", lastSeenAt: nil, pairingNumber: nil
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

    func testRenameAndRemoveBothAskForFaceID() async throws {
        let transport = ScriptedTransport(answer: Self.answer)
        let settings = store(transport)
        await settings.load()
        let watch = settings.devices[1]
        try await settings.rename(watch, to: "  手表  ", reason: "改名")
        try await settings.revoke(watch, reason: "移除")
        let sent = await transport.sent
        let commands = sent.enumerated().filter { $0.element["type"] == "device.rename" || $0.element["type"] == "device.revoke" }
        XCTAssertEqual(commands.count, 2)
        for (index, _) in commands { XCTAssertEqual(sent[index - 1], [:]) }
        guard case .object(let rename)? = commands[0].element["payload"] else { return XCTFail() }
        XCTAssertEqual(rename["name"], "手表")
        XCTAssertEqual(rename["expectedRevision"], .number(2))
    }

    func testRemovingThisPhoneAsksForFaceIDAndDoesNotReadTheListAgain() async throws {
        let transport = ScriptedTransport(answer: Self.answer)
        let settings = store(transport)
        await settings.load()
        let phone = try XCTUnwrap(settings.devices.first { settings.isThisDevice($0) })
        let before = await transport.sent.count
        try await settings.revoke(phone, reason: "移除")
        let after = Array(await transport.sent.dropFirst(before))
        XCTAssertEqual(after.count, 2)
        XCTAssertEqual(after[0], [:])
        XCTAssertEqual(after[1]["type"], "device.revoke")
    }
}
