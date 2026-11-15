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

private actor ConflictTransport: DeviceTransport {
    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        switch body["type"] {
        case "login.devices.revoke_others":
            return DeviceResponse(status: 409, body: Data(#"{"error":{"code":"PORT_CONFLICT","reasonCode":"LOGIN_DEVICES_STILL_CHANGING"}}"#.utf8))
        case "login.device.revoke":
            return DeviceResponse(status: 409, body: Data(#"{"error":{"code":"PORT_CONFLICT"}}"#.utf8))
        default:
            return DeviceResponse(status: 200, body: Data(#"{"payload":{"devices":[],"generatedAt":"2026-11-12T00:00:00Z"}}"#.utf8))
        }
    }
}

private actor SlowSecondPageTransport: DeviceTransport {
    private var served = 0
    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        if case .object(let payload)? = body["payload"], case .string? = payload["before"] {
            try await Task.sleep(nanoseconds: 300_000_000)
            return Self.page("旧第二页", "null")
        }
        let n = await nextServed()
        return Self.page(n == 1 ? "旧第一页" : "刷新后", n == 1 ? #""page2""# : "null")
    }
    private func nextServed() -> Int { served += 1; return served }
    private static func page(_ name: String, _ next: String) -> DeviceResponse {
        let file = #"{"fileId":"\#(name)","threadId":"t1","name":"\#(name)","threadTitle":null,"kind":"pdf","origin":"generated","mediaType":"application/pdf","sizeBytes":10,"version":1,"createdAt":"2026-11-11T00:00:00Z","deleted":false,"contentPath":null}"#
        return DeviceResponse(status: 200, body: Data(#"{"payload":{"files":[\#(file)],"nextCursor":\#(next),"generatedAt":"2026-11-12T00:00:00Z"}}"#.utf8))
    }
}

private func payloadString(_ body: [String: JSONValue], _ key: String) -> String? {
    guard case .object(let payload)? = body["payload"], case .string(let value)? = payload[key] else { return nil }
    return value
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
        guard case .string(let type)? = body["type"] else { return "{}" }
        switch type {
        case "capability.list":
            return #"{"payload":{"itemRefs":["cap-calendar","cap-search","cap-old"],"nextCursor":null}}"#
        case "capability.detail":
            let ref = payloadString(body, "capabilityRef") ?? ""
            let (name, lifecycle) = switch ref {
            case "cap-calendar": ("日历", "update_proposed")
            case "cap-search": ("网页搜索", "active")
            default: ("旧的", "disabled")
            }
            var assessment = ref == "cap-calendar" ? #","updateAssessment":{"expansions":["改日程"]}"# : ""
            if lifecycle == "disabled" { assessment = #","lastInvalidation":{"lifecycle":"disabled","cancelledScheduledJobs":2,"occurredAt":"2026-11-13T06:10:00Z"}"# }
            return #"{"payload":{"capabilityRef":"\#(ref)","displayName":"\#(name)","lifecycle":"\#(lifecycle)","revision":3\#(assessment)}}"#
        case "device.list.read":
            return devices
        case "login.devices.read":
            return #"{"payload":{"devices":[{"deviceId":"login_web","label":"Mac 上的 Safari","firstSeenAt":"2026-11-01T00:00:00Z","lastSeenAt":"2026-11-12T00:00:00Z","current":true},{"deviceId":"login_old","label":"Windows 上的 Chrome","firstSeenAt":"2026-10-01T00:00:00Z","lastSeenAt":"2026-11-09T00:00:00Z","current":false}],"generatedAt":"2026-11-12T00:00:00Z"}}"#
        case "files.list.read":
            return files(origin: payloadString(body, "origin") ?? "", before: payloadString(body, "before"))
        case "server.status.read":
            return #"{"payload":{"live":true,"ready":false,"status":"not_ready","dependencies":[],"generatedAt":"2026-11-12T00:00:00Z"}}"#
        default:
            return "{}"
        }
    }

    func testOnlyWaitingAndInUseCapabilitiesAreListed() async {
        let settings = store(ScriptedTransport(answer: Self.answer))
        await settings.load()
        XCTAssertEqual(settings.phase, .loaded)
        XCTAssertEqual(settings.waitingCapabilities.map(\.displayName), ["日历"])
        XCTAssertEqual(settings.capabilitiesInUse.map(\.displayName), ["网页搜索"])
        XCTAssertEqual(settings.capabilitiesDisabled.map(\.displayName), ["旧的"])
        XCTAssertEqual(settings.waitingCapabilities.first?.updateAssessment?.expansions, ["改日程"])
        XCTAssertNil(settings.capabilitiesInUse.first?.updateAssessment)
        XCTAssertEqual(settings.capabilityCount, 3)
    }

    func testTurningACapabilityOffAsksForFaceIDWithItsRevision() async throws {
        let transport = ScriptedTransport(answer: Self.answer)
        let settings = store(transport)
        await settings.load()
        try await settings.disable(settings.capabilitiesInUse[0], reason: "停用")
        let sent = await transport.sent
        guard let index = sent.firstIndex(where: { $0["type"] == "capability.disable" }) else { return XCTFail() }
        XCTAssertEqual(sent[index - 1], [:])
        guard case .object(let payload)? = sent[index]["payload"] else { return XCTFail() }
        XCTAssertEqual(payload["capabilityRef"], .string("cap-search"))
        XCTAssertEqual(payload["expectedRevision"], .number(3))
        XCTAssertEqual(payload["reasonCode"], .string("owner_disabled"))
        XCTAssertEqual(payload["recentAuthenticationRef"], .string(ClientCapabilities.referencePlaceholder))
        XCTAssertEqual(Set(payload.keys), ["capabilityRef", "expectedRevision", "reasonCode", "recentAuthenticationRef"])
    }

    func testTurningADisabledCapabilityBackOnAsksForFaceIDAndReadsTheDisableDetail() async throws {
        let transport = ScriptedTransport(answer: Self.answer)
        let settings = store(transport)
        await settings.load()
        let disabled = settings.capabilitiesDisabled[0]
        XCTAssertEqual(disabled.lastInvalidation?.cancelledScheduledJobs, 2)
        XCTAssertEqual(disabled.lastInvalidation?.occurredAt, "2026-11-13T06:10:00Z")
        try await settings.reactivate(disabled, reason: "启用")
        let sent = await transport.sent
        guard let index = sent.firstIndex(where: { $0["type"] == "capability.reactivate" }) else { return XCTFail() }
        XCTAssertEqual(sent[index - 1], [:])
        guard case .object(let payload)? = sent[index]["payload"] else { return XCTFail() }
        XCTAssertEqual(payload["expectedRevision"], .number(3))
        XCTAssertEqual(payload["reasonCode"], .string("owner_reactivated"))
        XCTAssertEqual(Set(payload.keys), ["capabilityRef", "expectedRevision", "reasonCode", "recentAuthenticationRef"])
    }

    func testOnlyANonServerNonKeyFailureCountsAsDeclined() {
        XCTAssertFalse(SettingsStore.isDeclined(ManageGatewayError.rejected(status: 403, code: "PORT_NOT_AUTHORITATIVE")))
        XCTAssertFalse(SettingsStore.isDeclined(DeviceKeyError.keyUnreadable(.confirm)))
        XCTAssertTrue(SettingsStore.isDeclined(CancellationError()))
    }

    func testRevokedDevicesAreLeftOutAndPresenceIsNeverGuessed() async {
        let settings = store(ScriptedTransport(answer: Self.answer))
        await settings.load()
        XCTAssertEqual(settings.devices.map(\.id), ["dev_phone", "dev_watch", "dev_new"])
        XCTAssertEqual(settings.presence(settings.devices[0]), .connected)
        XCTAssertEqual(settings.presence(settings.devices[1]), .neverSeen)
        XCTAssertEqual(settings.presence(settings.devices[2]), .waitingForConfirmation)
    }

    private func reach(_ status: String?) async -> ServerReach? {
        let settings = store(ScriptedTransport(answer: { body in
            if body["type"] == "server.status.read" { return status ?? "not json" }
            return Self.answer(body)
        }))
        XCTAssertNil(settings.server)
        await settings.load()
        return settings.server
    }

    func testServerLineSaysConnectedWhenTheServerIsReady() async {
        let ready = #"{"payload":{"live":true,"ready":true,"status":"healthy","dependencies":[],"generatedAt":"2026-11-12T00:00:00Z"}}"#
        let result = await reach(ready)
        XCTAssertEqual(result, .connected)
    }

    func testServerLineSaysNotReadyWhenTheServerReportsSo() async {
        let result = await reach(#"{"payload":{"live":true,"ready":false,"status":"not_ready","dependencies":[],"generatedAt":"2026-11-12T00:00:00Z"}}"#)
        XCTAssertEqual(result, .notReady)
    }

    func testServerLineSaysCannotConnectWhenStatusCannotBeRead() async {
        let result = await reach(nil)
        XCTAssertEqual(result, .unreachable)
        XCTAssertEqual(M.serverLine(nil), M.runsOnYourServer)
        XCTAssertEqual(Set([ServerReach.connected, .notReady, .unreachable].map { M.serverLine($0) }).count, 3)
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
        XCTAssertEqual(unknown.icon, .deviceMobile)
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

    nonisolated private static func file(_ id: String, _ name: String, origin: String, deleted: Bool = false) -> String {
        #"{"fileId":"\#(id)","threadId":"t1","name":"\#(name)","threadTitle":null,"kind":"pdf","origin":"\#(origin)","mediaType":"application/pdf","sizeBytes":10,"version":1,"createdAt":"2026-11-11T00:00:00Z","deleted":\#(deleted),"contentPath":null}"#
    }

    nonisolated private static func files(origin: String, before: String?) -> String {
        let items: [String]
        let next: String
        switch (origin, before) {
        case ("generated", nil):
            items = [file("f1", "报价单 11 月.pdf", origin: origin), file("f2", "删掉的.pdf", origin: origin, deleted: true)]
            next = #""page2""#
        case ("generated", "page2"):
            items = [file("f3", "大阪行程.md", origin: origin)]
            next = "null"
        default:
            items = [file("u1", "会议白板.jpg", origin: origin)]
            next = "null"
        }
        return #"{"payload":{"files":[\#(items.joined(separator: ","))],"nextCursor":\#(next),"generatedAt":"2026-11-12T00:00:00Z"}}"#
    }

    func testFilesAreSplitByWhoMadeThemAndDeletedOnesAreLeftOut() async {
        let transport = ScriptedTransport(answer: Self.answer)
        let settings = store(transport)
        await settings.loadFiles(.generated)
        XCTAssertEqual(settings.shelf(.generated).files.map(\.name), ["报价单 11 月.pdf"])
        await settings.loadFiles(.generated, more: true)
        XCTAssertEqual(settings.shelf(.generated).files.map(\.name), ["报价单 11 月.pdf", "大阪行程.md"])
        await settings.loadFiles(.generated, more: true)
        XCTAssertEqual(settings.shelf(.generated).files.count, 2)
        await settings.loadFiles(.uploaded)
        XCTAssertEqual(settings.shelf(.uploaded).files.map(\.name), ["会议白板.jpg"])
        let reads = await transport.sent.filter { $0["type"] == "files.list.read" }
        XCTAssertEqual(reads.count, 3)
    }

    func testRefreshingWhileLoadingMoreKeepsTheRefreshedPage() async throws {
        let settings = SettingsStore(gateway: ManageGateway(transport: SlowSecondPageTransport(), makeIdentifier: { "0123456789abcdef0123" }), identity: nil)
        await settings.loadFiles(.generated)
        XCTAssertEqual(settings.shelf(.generated).files.map(\.name), ["旧第一页"])
        let more = Task { await settings.loadFiles(.generated, more: true) }
        try await Task.sleep(nanoseconds: 50_000_000)
        await settings.loadFiles(.generated)
        await more.value
        XCTAssertEqual(settings.shelf(.generated).files.map(\.name), ["刷新后"])
    }

    func testSigningOutABrowserAsksForFaceIDAndTheCurrentOneSaysInUse() async throws {
        let transport = ScriptedTransport(answer: Self.answer)
        let settings = store(transport)
        await settings.load()
        let browsers = try XCTUnwrap(settings.loginDevices)
        XCTAssertEqual(browsers.map(\.label), ["Mac 上的 Safari", "Windows 上的 Chrome"])
        XCTAssertEqual(M.loginSeen(browsers[0]), M.text("现在在用", ja: "いま使用中", en: "In use now"))
        XCTAssertNotEqual(M.loginSeen(browsers[1]), M.loginSeen(browsers[0]))
        try await settings.signOut(browsers[1], reason: "退出")
        let sent = await transport.sent
        let index = try XCTUnwrap(sent.firstIndex { $0["type"] == "login.device.revoke" })
        XCTAssertEqual(sent[index - 1], [:])
        guard case .object(let payload)? = sent[index]["payload"] else { return XCTFail() }
        XCTAssertEqual(payload["deviceId"], "login_old")
        XCTAssertEqual(payload["recentAuthenticationRef"], "device")
    }

    func testSigningOutAllOthersIsOneFaceIDAndBusyIsNotAFailure() async throws {
        let transport = ScriptedTransport(answer: Self.answer)
        let settings = store(transport)
        let outcome = try await settings.signOutOthers(reason: "退出其他")
        XCTAssertEqual(outcome, .done)
        let sent = await transport.sent
        let index = try XCTUnwrap(sent.firstIndex { $0["type"] == "login.devices.revoke_others" })
        XCTAssertEqual(sent[index - 1], [:])
        XCTAssertEqual(sent.filter { $0 == [:] }.count, 1)

        let busy = SettingsStore(
            gateway: ManageGateway(transport: ConflictTransport(), makeIdentifier: { "0123456789abcdef0123" }),
            identity: nil
        )
        let busyOutcome = try await busy.signOutOthers(reason: "退出其他")
        XCTAssertEqual(busyOutcome, .stillChanging)
        let browser = try JSONDecoder().decode(
            LoginDevice.self,
            from: Data(#"{"deviceId":"x","label":"Chrome","firstSeenAt":"2026-11-01T00:00:00Z","lastSeenAt":"2026-11-01T00:00:00Z","current":false}"#.utf8)
        )
        do {
            try await busy.signOut(browser, reason: "退出")
            XCTFail("an ordinary conflict must still fail")
        } catch {}
    }

    func testFileLineNamesTheConversationOnlyWhenItHasATitle() throws {
        let day = try XCTUnwrap(Timestamp.parse("2026-11-11T00:00:00Z"))
        let plain = M.fileLine(day: day, thread: nil)
        XCTAssertEqual(M.fileLine(day: day, thread: "  "), plain)
        let titled = M.fileLine(day: day, thread: "周五去大阪")
        XCTAssertTrue(titled.hasPrefix(plain))
        XCTAssertTrue(titled.contains("周五去大阪"))
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

    func testPairingShowsALinkThenAsksAboutTheNewDeviceOnly() async throws {
        let server = PairingServer()
        let settings = SettingsStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            identity: DeviceIdentity(deviceId: "dev_phone", origin: URL(string: "https://h.example")!, access: nil)
        )
        let session = PairingSession(store: settings, pollInterval: .milliseconds(1))
        await session.run(reason: "添加设备")
        guard case .asking(let device) = session.stage else { return XCTFail("\(session.stage)") }
        XCTAssertEqual(device.id, "dev_new")
        let started = await server.startedCode
        let code = try XCTUnwrap(started)
        XCTAssertNotNil(code.range(of: "^[A-Za-z0-9_-]{21}[AQgw]$", options: .regularExpression))
        try await session.confirm(device, reason: "配对")
        let confirmed = await server.confirmed
        XCTAssertEqual(confirmed, ["dev_new"])
    }

    func testExpiredPageSaysHowLongTheServerSaidTheCodeLasts() async {
        let clock = TestClock(Date(timeIntervalSince1970: 1_800_000_000))
        let expiresAt = ISO8601DateFormatter().string(from: clock.now.addingTimeInterval(7 * 60))
        let server = PairingServer(newcomerAfter: .max, expiresAt: expiresAt)
        let settings = SettingsStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            identity: DeviceIdentity(deviceId: "dev_phone", origin: URL(string: "https://h.example")!, access: nil)
        )
        let session = PairingSession(store: settings, pollInterval: .milliseconds(1), now: { clock.advance(by: 240) })
        await session.run(reason: "添加设备")
        XCTAssertEqual(session.stage, .expired(minutes: 3))
    }

    func testPairingExpiresWhenNobodyScans() async {
        let server = PairingServer(newcomerAfter: .max, expiresAt: "2000-01-01T00:00:00Z")
        let settings = SettingsStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            identity: DeviceIdentity(deviceId: "dev_phone", origin: URL(string: "https://h.example")!, access: nil)
        )
        let session = PairingSession(store: settings, pollInterval: .milliseconds(1))
        await session.run(reason: "添加设备")
        XCTAssertEqual(session.stage, .expired(minutes: nil))
        XCTAssertFalse(M.codeExpiredHint(minutes: nil).contains("10"))
        XCTAssertTrue(M.codeExpiredHint(minutes: 7).contains("7"))
    }
}

private final class TestClock: @unchecked Sendable {
    private(set) var now: Date
    private let lock = NSLock()

    init(_ now: Date) { self.now = now }

    func advance(by seconds: TimeInterval) -> Date {
        lock.withLock {
            now = now.addingTimeInterval(seconds)
            return now
        }
    }
}

private actor PairingServer: DeviceTransport {
    private(set) var startedCode: String?
    private(set) var confirmed: [String] = []
    private var listsAfterStart = 0
    private let newcomerAfter: Int
    private let expiresAt: String

    init(newcomerAfter: Int = 2, expiresAt: String = "2999-01-01T00:00:00Z") {
        self.newcomerAfter = newcomerAfter
        self.expiresAt = expiresAt
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return DeviceResponse(status: 200, body: Data(await answer(body).utf8))
    }

    private func answer(_ body: [String: JSONValue]) -> String {
        guard case .string(let type)? = body["type"], case .object(let payload)? = body["payload"] else { return "{}" }
        switch type {
        case "device.pairing.start":
            if case .string(let code)? = payload["pairingCode"] { startedCode = code }
            return "{}"
        case "device.pairing.confirm":
            if case .string(let id)? = payload["deviceId"] { confirmed.append(id) }
            return "{}"
        case "device.list.read":
            var devices = [#"{"id":"dev_stale","revision":0,"kind":"watch","name":"旧手表","releaseChannel":"direct","status":"pending","pairedAt":"2026-11-01T00:00:00Z","lastSeenAt":null,"pairingNumber":"111111"}"#]
            var pairing = "null"
            if startedCode != nil {
                listsAfterStart += 1
                pairing = #"{"expiresAt":"\#(expiresAt)","access":null}"#
                if listsAfterStart > newcomerAfter {
                    devices.append(#"{"id":"dev_new","revision":0,"kind":"mac","name":"MacBook Pro","releaseChannel":"mac_direct","status":"pending","pairedAt":"2026-11-12T00:00:00Z","lastSeenAt":null,"pairingNumber":"482913"}"#)
                }
            }
            return #"{"payload":{"devices":[\#(devices.joined(separator: ","))],"limits":[],"pairing":\#(pairing),"generatedAt":"2026-11-12T00:00:00Z"}}"#
        default:
            return "{}"
        }
    }
}
