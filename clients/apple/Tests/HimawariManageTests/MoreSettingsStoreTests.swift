import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor MoreTransport: DeviceTransport {
    struct Sent: Sendable {
        let body: [String: JSONValue]
        let confirmed: Bool
    }

    private(set) var sent: [Sent] = []
    private let answers: [String: String]

    init(answers: [String: String]) {
        self.answers = answers
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        let type: String
        if case .string(let value)? = body["type"] { type = value } else { type = "" }
        await record(Sent(body: body, confirmed: confirm != nil))
        return DeviceResponse(status: 200, body: Data((answers[type] ?? "{}").utf8))
    }

    private func record(_ item: Sent) {
        sent.append(item)
    }

    func last(_ type: String) -> Sent? {
        sent.last { if case .string(let value)? = $0.body["type"] { value == type } else { false } }
    }
}

private func payload(_ sent: MoreTransport.Sent?) -> [String: JSONValue] {
    guard case .object(let fields)? = sent?.body["payload"] else { return [:] }
    return fields
}

private func risk(_ sent: MoreTransport.Sent?) -> JSONValue? { sent?.body["risk"] }

@MainActor
final class MoreSettingsStoreTests: XCTestCase {
    private func makeStore(_ transport: MoreTransport) -> MoreSettingsStore {
        MoreSettingsStore(gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }))
    }

    private static let search = #"{"payload":{"revision":2,"enabled":false,"providersChanged":false,"available":true,"recipients":["https://a.example.com"],"generatedAt":"2026-11-12T00:00:00Z"}}"#
    private static let push = #"{"payload":{"available":true,"kinds":["reminder"],"subscriptions":[]}}"#
    private static let preferences = #"{"payload":{"name":"Andy","locale":"ja","accent":"teal","theme":"dark","modelRef":null,"thinkingLevel":"high","revision":4,"updatedAt":"2026-11-12T00:00:00Z"}}"#

    func testSearchAuthorizationIsSentAtHighRiskWithConfirmation() async throws {
        let transport = MoreTransport(answers: ["search.authorization.read": Self.search])
        let store = makeStore(transport)
        await store.loadSearch()
        try await store.setSearch(enabled: true, reason: "r")
        let sent = await transport.last("search.authorization.set")
        XCTAssertEqual(risk(sent), .string("high"))
        XCTAssertEqual(sent?.confirmed, true)
        XCTAssertEqual(payload(sent)["expectedRevision"], .number(2))
        XCTAssertEqual(payload(sent)["enabled"], .bool(true))
        XCTAssertEqual(payload(sent)["recipients"], .array([.string("https://a.example.com")]))
    }

    func testPushKindOffNeedsNoConfirmationAndOnDoes() async throws {
        let transport = MoreTransport(answers: ["push.status.read": Self.push])
        let store = makeStore(transport)
        await store.loadPush()
        try await store.setPushKind("reminder", enabled: false, reason: "r")
        let off = await transport.last("push.kind.set")
        XCTAssertEqual(off?.confirmed, false)
        try await store.setPushKind("approval", enabled: true, reason: "r")
        let on = await transport.last("push.kind.set")
        XCTAssertEqual(on?.confirmed, true)
        XCTAssertEqual(payload(on)["kind"], .string("approval"))
    }

    func testPreferencesSaveKeepsFieldsThePhoneDoesNotEdit() async throws {
        let transport = MoreTransport(answers: ["owner.preferences.read": Self.preferences])
        let store = makeStore(transport)
        await store.loadPreferences()
        try await store.savePreferences(name: "Sixian", locale: .en, reason: "r")
        let fields = payload(await transport.last("owner.preferences.set"))
        XCTAssertEqual(fields["name"], .string("Sixian"))
        XCTAssertEqual(fields["locale"], .string("en"))
        XCTAssertEqual(fields["accent"], .string("teal"))
        XCTAssertEqual(fields["theme"], .string("dark"))
        XCTAssertEqual(fields["modelRef"], .null)
        XCTAssertEqual(fields["thinkingLevel"], .string("high"))
        XCTAssertEqual(fields["expectedRevision"], .number(4))
    }

    func testUnchangedPreferencesSendNothing() async throws {
        let transport = MoreTransport(answers: ["owner.preferences.read": Self.preferences])
        let store = makeStore(transport)
        await store.loadPreferences()
        try await store.savePreferences(name: "Andy", locale: .ja, reason: "r")
        let sent = await transport.last("owner.preferences.set")
        XCTAssertNil(sent)
    }

    func testMcpChangeSendsExplicitNulls() async throws {
        let transport = MoreTransport(answers: [:])
        let store = makeStore(transport)
        let change = McpConnectionChange(connectionId: "c1", name: nil, readCeiling: "public", status: nil)
        try await store.changeMcp(change, reason: "r")
        let fields = payload(await transport.last("mcp.connection.change"))
        XCTAssertEqual(fields["connectionId"], .string("c1"))
        XCTAssertEqual(fields["readCeiling"], .string("public"))
        XCTAssertEqual(fields["name"], .null)
        XCTAssertEqual(fields["status"], .null)
        XCTAssertEqual(fields["capabilities"], .null)
        XCTAssertEqual(fields["pushPolicy"], .null)
    }

    func testNextSensitivePageSendsTheCursor() async throws {
        let first = #"{"payload":{"counts":{"masked":1,"withheld":0,"notSaved":0},"items":[{"id":"a","threadId":null,"source":"chat","part":"mail","category":"password","outcome":"masked","firstSeenAt":"2026-11-12T00:00:00Z","seenCount":1}],"next":{"firstSeenAt":"2026-11-12T00:00:00Z","id":"a"}}}"#
        let transport = MoreTransport(answers: ["sensitive.interceptions.read": first])
        let store = makeStore(transport)
        await store.loadSensitive()
        await store.loadSensitive(more: true)
        let before = payload(await transport.last("sensitive.interceptions.read"))["before"]
        XCTAssertEqual(before, .object(["firstSeenAt": .string("2026-11-12T00:00:00Z"), "id": .string("a")]))
        XCTAssertEqual(store.sensitiveItems.count, 1)
    }
}
