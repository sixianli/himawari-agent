import Foundation
import XCTest
@testable import HimawariManage

private actor QuietServer: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private var version = 1
    private let editable: Bool

    init(editable: Bool = true) {
        self.editable = editable
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return await answer(body)
    }

    private func answer(_ body: [String: JSONValue]) -> DeviceResponse {
        sent.append(body)
        if body["type"] == .string("quiet_hours.set") { version += 1 }
        let hours = editable
            ? #"{"version":"v\#(version)","editable":true,"enabled":true,"start":"23:00","end":"07:00","classes":["her_words"],"rules":[]}"#
            : #"{"version":"v\#(version)","editable":false,"enabled":true,"start":null,"end":null,"classes":["her_words"],"rules":[{"ruleId":"r1","summary":"工作日晚上和周末早上别推"}]}"#
        return DeviceResponse(status: 200, body: Data(#"{"payload":\#(hours)}"#.utf8))
    }
}

@MainActor
final class QuietHoursStoreTests: XCTestCase {
    private func store(_ server: QuietServer) -> QuietHoursStore {
        QuietHoursStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
    }

    func testLoadingReadsTheSingleWindow() async {
        let quiet = store(QuietServer())
        await quiet.load()
        XCTAssertEqual(quiet.phase, .loaded)
        XCTAssertEqual(ClockTime(quiet.hours?.start), ClockTime(hour: 23, minute: 0))
        XCTAssertEqual(quiet.hours.map(M.quietSummary), M.quietSummary(QuietHours(version: "v1", editable: true, enabled: true, start: "23:00", end: "07:00", classes: [], rules: [])))
    }

    func testSavingSendsTheVersionItReadAndReloads() async throws {
        let server = QuietServer()
        let quiet = store(server)
        await quiet.load()
        try await quiet.set(enabled: true, start: ClockTime(hour: 22, minute: 30), end: ClockTime(hour: 6, minute: 0), reason: "晚上不响")
        let command = await server.sent.first { $0["type"] == .string("quiet_hours.set") }
        XCTAssertEqual(command?["payload"], .object([
            "expectedVersion": .string("v1"),
            "enabled": .bool(true),
            "start": .string("22:30"),
            "end": .string("06:00"),
        ]))
        XCTAssertEqual(quiet.hours?.version, "v2")
    }

    func testTwoQuickEditsBothReachTheServer() async throws {
        let server = QuietServer()
        let quiet = store(server)
        await quiet.load()
        quiet.edit { $0.start = ClockTime(hour: 22, minute: 0) }
        quiet.edit { $0.end = ClockTime(hour: 6, minute: 30) }
        XCTAssertEqual(quiet.shown, QuietHoursStore.Choice(enabled: true, start: ClockTime(hour: 22, minute: 0), end: ClockTime(hour: 6, minute: 30)))
        try await quiet.saveDraft { _ in "晚上不响" }
        let command = await server.sent.first { $0["type"] == .string("quiet_hours.set") }
        XCTAssertEqual(command?["payload"], .object([
            "expectedVersion": .string("v1"),
            "enabled": .bool(true),
            "start": .string("22:00"),
            "end": .string("06:30"),
        ]))
        XCTAssertNil(quiet.draft)
    }

    func testRulesThatAreNotOneDailyWindowStayReadOnly() async {
        let quiet = store(QuietServer(editable: false))
        await quiet.load()
        XCTAssertEqual(quiet.hours?.editable, false)
        XCTAssertNil(ClockTime(quiet.hours?.start))
    }

    func testClockTimeRejectsMalformedText() {
        XCTAssertNil(ClockTime("24:00"))
        XCTAssertNil(ClockTime("7"))
        XCTAssertEqual(ClockTime("07:05")?.shortText, "7:05")
    }
}
