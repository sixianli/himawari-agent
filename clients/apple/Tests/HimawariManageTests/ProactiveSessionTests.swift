import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor ProactiveTransport: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private(set) var nonces: [String?] = []

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        await record(body, nonce)
        return DeviceResponse(status: 200, body: Data(ProactiveTransport.reply(body["type"]).utf8))
    }

    private func record(_ body: [String: JSONValue], _ nonce: String?) {
        sent.append(body)
        nonces.append(nonce)
    }

    private static func reply(_ type: JSONValue?) -> String {
        switch type {
        case .string("proactive.overview.read"):
            return #"{"payload":{"source":"gmail","connection":{"status":"connected","account":"a@example.com","connectedAt":null},"enabled":true,"quietHours":[{"days":[1,2],"start":"23:00","end":"07:00"}],"importantSenders":["boss@example.com"],"dailyLimitReached":false,"backoff":[],"insights":[],"decisions":[]}}"#
        case .string("proactive.sources.read"):
            return #"{"payload":{"sources":[{"source":"gmail","intake":"reader","trust":"external","enabled":true,"perDay":{"limit":100,"defaultLimit":100,"minimum":10,"maximum":500,"used":3,"resetsAt":"2026-11-13T00:00:00.000Z","onReach":"hold_until_reset"},"perCheck":{"limit":20,"defaultLimit":20,"minimum":1,"maximum":100,"onReach":"hold_until_next_check"},"dailyLimitReached":false,"updatedAt":null}]}}"#
        default:
            return "{}"
        }
    }

    func commands() -> [[String: JSONValue]] {
        sent.filter { body in
            if case .string(let type)? = body["type"] { return !type.hasSuffix(".read") }
            return false
        }
    }

    func commandNonces() -> [String?] {
        zip(sent, nonces).compactMap { body, nonce in
            if case .string(let type)? = body["type"], !type.hasSuffix(".read") { return .some(nonce) }
            return nil
        }
    }
}

@MainActor
final class ProactiveSessionTests: XCTestCase {
    private func session(_ transport: ProactiveTransport) -> ProactiveSession {
        ProactiveSession(gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }))
    }

    private func payload(_ command: [String: JSONValue]) -> [String: JSONValue] {
        guard case .object(let fields)? = command["payload"] else { return [:] }
        return fields
    }

    func testOverviewAndSourcesLoad() async {
        let proactive = session(ProactiveTransport())
        await proactive.reloadOverview()
        await proactive.reloadSources()
        XCTAssertEqual(proactive.overview?.enabled, true)
        XCTAssertEqual(proactive.sources?.map(\.id), ["gmail"])
        XCTAssertEqual(proactive.overviewLoad, .loaded)
    }

    func testTurningOffUsesPauseWithoutAFaceCheck() async throws {
        let transport = ProactiveTransport()
        let proactive = session(transport)
        await proactive.reloadOverview()
        try await proactive.setEnabled(false, reason: "r")
        let sent = await transport.commands()
        XCTAssertEqual(sent.first?["type"], "proactive.pause")
        let nonces = await transport.commandNonces()
        XCTAssertNil(nonces[0])
    }

    func testTurningOnKeepsQuietHoursAndSendersAndNeedsAFaceCheck() async throws {
        let transport = ProactiveTransport()
        let proactive = session(transport)
        await proactive.reloadOverview()
        try await proactive.setEnabled(true, reason: "r")
        let sent = await transport.commands()
        let command = try XCTUnwrap(sent.first)
        XCTAssertEqual(command["type"], "proactive.settings.set")
        let fields = payload(command)
        XCTAssertEqual(fields["enabled"], .bool(true))
        XCTAssertEqual(fields["importantSenders"], .array([.string("boss@example.com")]))
        XCTAssertEqual(
            fields["quietHours"],
            .array([.object(["days": .array([.number(1), .number(2)]), "start": .string("23:00"), "end": .string("07:00")])])
        )
        let nonces = await transport.commandNonces()
        XCTAssertEqual(nonces[0], "c")
    }

    func testSwitchingASourceOffUsesTheTightenOperation() async throws {
        let transport = ProactiveTransport()
        let proactive = session(transport)
        await proactive.reloadSources()
        let source = try XCTUnwrap(proactive.sources?.first)
        try await proactive.change(source, enabled: false, perDay: 100, perCheck: 20, reason: "r")
        let sent = await transport.commands()
        let command = try XCTUnwrap(sent.first)
        XCTAssertEqual(command["type"], "proactive.source.switch_off")
        XCTAssertEqual(payload(command), ["source": .string("gmail")])
    }

    func testChangingALimitUsesSettingsSetWithAllFields() async throws {
        let transport = ProactiveTransport()
        let proactive = session(transport)
        await proactive.reloadSources()
        let source = try XCTUnwrap(proactive.sources?.first)
        try await proactive.change(source, enabled: true, perDay: 150, perCheck: 20, reason: "r")
        let sent = await transport.commands()
        let command = try XCTUnwrap(sent.first)
        XCTAssertEqual(command["type"], "proactive.source.settings.set")
        XCTAssertEqual(
            payload(command),
            ["source": .string("gmail"), "enabled": .bool(true), "perDay": .number(150), "perCheck": .number(20)]
        )
    }

    func testSwitchingOffAndChangingALimitTogetherIsNotATightenOnlyChange() async throws {
        let transport = ProactiveTransport()
        let proactive = session(transport)
        await proactive.reloadSources()
        let source = try XCTUnwrap(proactive.sources?.first)
        try await proactive.change(source, enabled: false, perDay: 200, perCheck: 20, reason: "r")
        let sent = await transport.commands()
        let command = try XCTUnwrap(sent.first)
        XCTAssertEqual(command["type"], "proactive.source.settings.set")
    }

    func testClearingADecisionRatingSendsNull() async throws {
        let transport = ProactiveTransport()
        let proactive = session(transport)
        let decision = try JSONDecoder().decode(
            ProactiveDecision.self,
            from: Data(#"{"id":"d1","checkedAt":"2026-11-14T01:00:00.000Z","verdict":"pushed","reasonCode":"OK","counts":{"fetched":1,"skipped":0,"judged":1,"act":1,"know":0,"check":0,"ignore":0,"floorRaised":0,"pushed":1},"opened":false,"rating":"useful"}"#.utf8)
        )
        try await proactive.rate(decision, nil, reason: "r")
        let sent = await transport.commands()
        let command = try XCTUnwrap(sent.first)
        XCTAssertEqual(command["type"], "proactive.decision.rate")
        XCTAssertEqual(payload(command), ["decisionId": .string("d1"), "rating": .null])
    }

    func testAnInsightRatingCarriesTheActionAndTheRating() async throws {
        let transport = ProactiveTransport()
        let proactive = session(transport)
        let insight = try JSONDecoder().decode(
            ProactiveInsight.self,
            from: Data(#"{"id":"i1","result":"act","summary":"s","reason":"r","from":"x","dueAt":null,"priority":null,"status":"open","pushed":false,"pushReaction":null,"rating":null,"updatedAt":"2026-11-10T00:00:00.000Z"}"#.utf8)
        )
        try await proactive.respond(insight, .rate, rating: .unneeded, reason: "r")
        let sent = await transport.commands()
        let command = try XCTUnwrap(sent.first)
        XCTAssertEqual(command["type"], "proactive.insight.respond")
        XCTAssertEqual(payload(command), ["insightId": .string("i1"), "action": .string("rate"), "rating": .string("unneeded")])
    }
}
