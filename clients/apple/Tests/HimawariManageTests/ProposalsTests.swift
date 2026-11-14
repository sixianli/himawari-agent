import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor ProposalTransport: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private var lists: [String]
    private let respondStatus: Int

    init(lists: [String], respondStatus: Int = 200) {
        self.lists = lists
        self.respondStatus = respondStatus
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
            let next = lists.count > 1 ? lists.removeFirst() : (lists.first ?? "{}")
            return DeviceResponse(status: 200, body: Data(next.utf8))
        }
        if body["type"] == "proposal.respond" {
            return DeviceResponse(status: respondStatus, body: Data(respondStatus == 200 ? "{}".utf8 : #"{"error":{"code":"INVALID_OPERATION"}}"#.utf8))
        }
        return DeviceResponse(status: 200, body: Data("{}".utf8))
    }
}

private func proposalJSON(_ id: String, version: Int = 1, fingerprint: String = "fp", adoptable: Bool = true) -> String {
    #"{"proposalId":"\#(id)","version":\#(version),"fingerprint":"\#(fingerprint)","type":"rule","summary":"雨天多留 10 分钟","effect":"出门提醒提前 10 分钟","origin":"inferred","adoptable":\#(adoptable),"evidence":[{"kind":"observation","text":"这个月有 2 次下雨天你出门晚了","sources":[],"figures":[{"name":"出门晚了的次数","value":2,"definition":"提醒后 10 分钟内才出门"}]}],"proposedAt":"2026-11-10T00:00:00Z","expiresAt":"2026-11-24T00:00:00Z","refusedBefore":0}"#
}

private func list(_ items: [String]) -> String {
    #"{"payload":{"proposals":[\#(items.joined(separator: ","))],"pendingCount":\#(items.count),"limit":5,"expiresAfterDays":14,"generatedAt":"2026-11-12T00:00:00Z"}}"#
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
        let settings = store(ProposalTransport(lists: [list([proposalJSON("a:1")])]))
        await settings.load()
        XCTAssertEqual(settings.proposals?.proposals.map(\.id), ["a:1"])
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
        let transport = ProposalTransport(lists: [list([proposalJSON("a:1", version: 3, fingerprint: "seen")]), list([])])
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        let outcome = try await settings.respond(proposal, .adopt, reason: "采纳")
        XCTAssertEqual(outcome, .done(.adopt))
        let sent = await transport.sent
        let command = try XCTUnwrap(sent.first { $0["type"] == "proposal.respond" })
        guard case .object(let payload)? = command["payload"] else { return XCTFail() }
        XCTAssertEqual(payload["proposalId"], "a:1")
        XCTAssertEqual(payload["expectedVersion"], .number(3))
        XCTAssertEqual(payload["fingerprint"], "seen")
        XCTAssertEqual(payload["action"], "adopt")
        XCTAssertEqual(settings.proposals?.proposals.count, 0)
    }

    func testAChangedProposalIsReloadedAndShownNotRetried() async throws {
        let transport = ProposalTransport(
            lists: [list([proposalJSON("a:1")]), list([proposalJSON("a:1", version: 2, fingerprint: "new")])],
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
        let transport = ProposalTransport(lists: [list([proposalJSON("a:1")]), list([])], respondStatus: 409)
        let settings = store(transport)
        await settings.load()
        let proposal = try XCTUnwrap(settings.proposals?.proposals.first)
        let outcome = try await settings.respond(proposal, .reject, reason: "不要")
        XCTAssertEqual(outcome, .gone)
    }

    func testARejectionWithNothingChangedIsAFailureNotAChange() async throws {
        let transport = ProposalTransport(lists: [list([proposalJSON("a:1")])], respondStatus: 500)
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
