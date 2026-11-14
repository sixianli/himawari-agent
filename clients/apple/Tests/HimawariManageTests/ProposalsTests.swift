import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor ProposalTransport: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private var lists: [String]
    private let respondStatus: Int
    private let openedReply: String

    init(lists: [String], respondStatus: Int = 200, openedReply: String = "{}") {
        self.lists = lists
        self.respondStatus = respondStatus
        self.openedReply = openedReply
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return await reply(body)
    }

    private func reply(_ body: [String: JSONValue]) -> DeviceResponse {
        sent.append(body)
        if body["type"] == "proposals.read" {
            guard case .object(let payload)? = body["payload"], let open = payload["open"] else {
                return DeviceResponse(status: 400, body: Data(#"{"error":{"code":"INVALID_REQUEST"}}"#.utf8))
            }
            if case .object = open { return DeviceResponse(status: 200, body: Data(openedReply.utf8)) }
            let next = lists.count > 1 ? lists.removeFirst() : (lists.first ?? "{}")
            return DeviceResponse(status: 200, body: Data(next.utf8))
        }
        if body["type"] == "proposal.respond" {
            guard case .object(let payload)? = body["payload"],
                  payload["recentAuthenticationRef"] != nil, payload["fullReadToken"] != nil else {
                return DeviceResponse(status: 400, body: Data(#"{"error":{"code":"INVALID_REQUEST"}}"#.utf8))
            }
            return DeviceResponse(status: respondStatus, body: Data(respondStatus == 200 ? "{}".utf8 : #"{"error":{"code":"INVALID_OPERATION"}}"#.utf8))
        }
        return DeviceResponse(status: 200, body: Data("{}".utf8))
    }
}

private func proposalJSON(_ id: String, version: Int = 1, fingerprint: String = "fp", adoptable: Bool = true, requiresFullRead: Bool = false) -> String {
    #"{"proposalId":"\#(id)","version":\#(version),"fingerprint":"\#(fingerprint)","type":"rule","summary":"雨天多留 10 分钟","effect":"出门提醒提前 10 分钟","origin":"inferred","adoptable":\#(adoptable),"requiresFullRead":\#(requiresFullRead),"requiresPresence":false,"evidence":[{"kind":"observation","text":"这个月有 2 次下雨天你出门晚了","sources":[],"figures":[{"name":"出门晚了的次数","value":2,"definition":"提醒后 10 分钟内才出门"}]}],"proposedAt":"2026-11-10T00:00:00Z","expiresAt":"2026-11-24T00:00:00Z","refusedBefore":0}"#
}

private func list(_ items: [String]) -> String {
    #"{"payload":{"proposals":[\#(items.joined(separator: ","))],"pendingCount":\#(items.count),"limit":5,"expiresAfterDays":14,"opened":null,"generatedAt":"2026-11-12T00:00:00Z"}}"#
}

@MainActor
final class ProposalsTests: XCTestCase {
    private func store(_ transport: ProposalTransport) -> SettingsStore {
        SettingsStore(
            gateway: ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" }),
            identity: nil
        )
    }

    func testLoadReadsTheListWithTheServersLimitAndExpiry() async {
        let settings = store(ProposalTransport(lists: [list([proposalJSON("rule:00000000000000000000000000000001")])]))
        await settings.load()
        XCTAssertEqual(settings.proposals?.proposals.map(\.id), ["rule:00000000000000000000000000000001"])
        XCTAssertEqual(settings.proposals?.limit, 5)
        XCTAssertEqual(settings.proposals?.expiresAfterDays, 14)
        XCTAssertTrue(settings.proposals?.proposals[0].hasEvidence == true)
    }

    func testAnEmptyListIsEmptyNotMissing() async {
        let settings = store(ProposalTransport(lists: [list([])]))
        await settings.load()
        XCTAssertEqual(settings.proposals?.proposals.count, 0)
    }

    func testAnUnreadableListHidesTheRow() async {
        let settings = store(ProposalTransport(lists: ["not json"]))
        await settings.load()
        XCTAssertNil(settings.proposals)
    }

    func testAdoptSendsTheSeenVersionAndFingerprintWithOneFaceID() async throws {
        let transport = ProposalTransport(lists: [list([proposalJSON("rule:00000000000000000000000000000001", version: 3, fingerprint: "seen")]), list([])])
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        let outcome = try await settings.respond(proposal, .adopt, reason: "采纳")
        XCTAssertEqual(outcome, .done(.adopt))
        let sent = await transport.sent
        let command = try XCTUnwrap(sent.first { $0["type"] == "proposal.respond" })
        guard case .object(let payload)? = command["payload"] else { return XCTFail() }
        XCTAssertEqual(payload["proposalId"], "rule:00000000000000000000000000000001")
        XCTAssertEqual(payload["expectedVersion"], .number(3))
        XCTAssertEqual(payload["fingerprint"], "seen")
        XCTAssertEqual(payload["action"], "adopt")
        XCTAssertEqual(payload["recentAuthenticationRef"], .string("device"))
        XCTAssertEqual(payload["fullReadToken"], .null)
        XCTAssertEqual(settings.proposals?.proposals.count, 0)
    }

    func testAChangedProposalIsReloadedAndShownNotRetried() async throws {
        let transport = ProposalTransport(
            lists: [list([proposalJSON("rule:00000000000000000000000000000001")]), list([proposalJSON("rule:00000000000000000000000000000001", version: 2, fingerprint: "new")])],
            respondStatus: 409
        )
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        let outcome = try await settings.respond(proposal, .adopt, reason: "采纳")
        guard case .changed(let latest) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(latest.version, 2)
        let sent = await transport.sent
        XCTAssertEqual(sent.filter { $0["type"] == "proposal.respond" }.count, 1)
    }

    func testAProposalThatIsGoneIsReportedAsGone() async throws {
        let transport = ProposalTransport(lists: [list([proposalJSON("rule:00000000000000000000000000000001")]), list([])], respondStatus: 409)
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        let outcome = try await settings.respond(proposal, .reject, reason: "不要")
        XCTAssertEqual(outcome, .gone)
    }

    func testARejectionWithNothingChangedIsAFailureNotAChange() async throws {
        let transport = ProposalTransport(lists: [list([proposalJSON("rule:00000000000000000000000000000001")])], respondStatus: 500)
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        do {
            _ = try await settings.respond(proposal, .adopt, reason: "采纳")
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(settings.proposals?.proposals.count, 1)
        }
    }

    func testAnAdoptThatNeedsTheFullTextOpensItFirstAndSendsTheToken() async throws {
        let id = "rule:00000000000000000000000000000001"
        let opened = #"{"payload":{"proposals":[],"pendingCount":0,"limit":5,"expiresAfterDays":14,"opened":{"proposalId":"\#(id)","fullReadToken":"tok","expiresAt":"2026-11-12T00:10:00Z"},"generatedAt":"2026-11-12T00:00:00Z"}}"#
        let transport = ProposalTransport(lists: [list([proposalJSON(id, requiresFullRead: true)]), list([])], openedReply: opened)
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        XCTAssertTrue(proposal.requiresFullRead)
        let outcome = try await settings.respond(proposal, .adopt, reason: "采纳")
        XCTAssertEqual(outcome, .done(.adopt))
        let sent = await transport.sent
        let command = try XCTUnwrap(sent.first { $0["type"] == "proposal.respond" })
        guard case .object(let payload)? = command["payload"] else { return XCTFail() }
        XCTAssertEqual(payload["fullReadToken"], .string("tok"))
    }

    func testARejectionNeverOpensTheFullText() async throws {
        let id = "rule:00000000000000000000000000000001"
        let transport = ProposalTransport(lists: [list([proposalJSON(id, requiresFullRead: true)]), list([])])
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        _ = try await settings.respond(proposal, .reject, reason: "不要")
        let sent = await transport.sent
        let opens = sent.filter { message in
            guard message["type"] == "proposals.read", case .object(let payload)? = message["payload"], case .object? = payload["open"] else { return false }
            return true
        }
        XCTAssertTrue(opens.isEmpty)
    }

    func testAFailedRereadAfterARejectedCommandKeepsTheOriginalError() async throws {
        let transport = ProposalTransport(lists: [list([proposalJSON("rule:00000000000000000000000000000001")]), "not json"], respondStatus: 409)
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        do {
            _ = try await settings.respond(proposal, .adopt, reason: "采纳")
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(settings.proposals?.proposals.count, 1)
        }
    }
}
