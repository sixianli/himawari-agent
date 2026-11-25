import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct ApprovalAllowanceTests {
    let challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    func approval(intent: String = #""intentId":"owner-scope:send-mail","actionKind":"COMMUNICATE","estimatedCostMicros":0,"credentialOrAccessChange":false,"deterministicFactCodes":[]"#) throws -> PendingApproval {
        let json = """
        {"approvalRequestId":"apr_1","revision":1,"status":"pending","semanticSnapshotHash":"h","finalRisk":"high",
         "recentAuthenticationRequired":false,"requestedAt":"2026-11-13T06:38:00.000Z","expiresAt":"2026-11-13T06:48:00.000Z","decidedAt":null,
         "display":{"displayTitle":"t","askedBecause":{"kind":"no_rule_allows"}},
         "intent":{"capabilityRef":"mail","operation":"mail.send","threadId":"thr_1","runId":"run_1",\(intent)}}
        """
        return try JSONDecoder().decode(PendingApproval.self, from: Data(json.utf8))
    }

    func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    func body(_ request: URLRequest) throws -> [String: Any] {
        let data = try #require(request.httpBody)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    var challengeReply: HTTPExchangeResponse {
        HTTPExchangeResponse(status: 201, body: Data(#"{"challenge":"\#(challenge)","expiresAt":"2026-11-13T06:40:00.000Z"}"#.utf8))
    }

    var ok: HTTPExchangeResponse { HTTPExchangeResponse(status: 200, body: Data(#"{"payload":{}}"#.utf8)) }

    @Test func anOwnerScopeActionOffersEveryChoice() throws {
        #expect(try approval().allowanceChoices == [.once, .thisTask, .days, .always])
        #expect(try approval().allowanceLimit == nil)
    }

    @Test func spendingCredentialsPresenceAndOtherActionsOnlyAllowOnce() throws {
        let cases: [(String, ApprovalAllowanceLimit)] = [
            (#""intentId":"owner-scope:a","estimatedCostMicros":800000"#, .spending),
            (#""intentId":"owner-scope:a","actionKind":"PURCHASE_OR_FUNDS""#, .spending),
            (#""intentId":"owner-scope:a","credentialOrAccessChange":true"#, .credential),
            (#""intentId":"owner-scope:a","deterministicFactCodes":["owner_presence_required"]"#, .ownerPresence),
            (#""intentId":"code:write-file""#, .asksEveryTime),
            (#""actionKind":"COMMUNICATE""#, .asksEveryTime),
        ]
        for (intent, limit) in cases {
            let found = try approval(intent: intent)
            #expect(found.allowanceLimit == limit)
            #expect(found.allowanceChoices == [.once])
        }
    }

    @Test func approvingForSevenDaysRecordsTheScopeAfterTheApproval() async throws {
        let exchange = RecordingExchange([challengeReply, ok, challengeReply, ok])
        let reply = try await api(exchange).respond(to: approval(), approved: true, allowFor: .days, confirm: try SoftwareKeySigner(), reason: "r")
        #expect(reply == .recorded(status: "approved"))
        let gateway = exchange.requests.filter { $0.url?.path == "/api/device/v1/gateway" }
        #expect(try gateway.map { try body($0)["type"] as? String } == ["approval.respond", "approval.allowance.set"])
        let sent = try body(gateway[1])
        #expect(sent["risk"] as? String == "medium")
        let payload = try #require(sent["payload"] as? [String: Any])
        #expect(payload["approvalRequestId"] as? String == "apr_1")
        #expect(payload["allowFor"] as? String == "days")
        #expect(payload["days"] as? Int == ApprovalAllowFor.defaultDays)
    }

    @Test func allowingForThisTaskSendsNullDays() async throws {
        let exchange = RecordingExchange([challengeReply, ok, challengeReply, ok])
        _ = try await api(exchange).respond(to: approval(), approved: true, allowFor: .thisTask, confirm: try SoftwareKeySigner(), reason: "r")
        let payload = try #require(try body(exchange.requests[3])["payload"] as? [String: Any])
        #expect(payload["allowFor"] as? String == "this_task")
        #expect(payload["days"] is NSNull)
    }

    @Test func onlyThisTimeSendsNoScope() async throws {
        let exchange = RecordingExchange([challengeReply, ok])
        let reply = try await api(exchange).respond(to: approval(), approved: true, allowFor: .once, confirm: try SoftwareKeySigner(), reason: "r")
        #expect(reply == .recorded(status: "approved"))
        #expect(exchange.requests.count == 2)
    }

    @Test func decliningOrAnOnceOnlyCardSendsNoScopeWhateverWasPicked() async throws {
        let declined = RecordingExchange([challengeReply, ok])
        _ = try await api(declined).respond(to: approval(), approved: false, allowFor: .always, confirm: try SoftwareKeySigner(), reason: "r")
        #expect(declined.requests.count == 2)
        let spending = RecordingExchange([challengeReply, ok])
        _ = try await api(spending).respond(to: approval(intent: #""intentId":"owner-scope:a","estimatedCostMicros":1"#), approved: true, allowFor: .always, confirm: try SoftwareKeySigner(), reason: "r")
        #expect(spending.requests.count == 2)
    }

    @Test func aFailedScopeStillCountsTheApproval() async throws {
        let exchange = RecordingExchange([challengeReply, ok, challengeReply, HTTPExchangeResponse(status: 400, body: Data(#"{"error":{"code":"ALLOWANCE_ACTION_ASKS_EVERY_TIME"}}"#.utf8))])
        let reply = try await api(exchange).respond(to: approval(), approved: true, allowFor: .always, confirm: try SoftwareKeySigner(), reason: "r")
        #expect(reply == .allowanceNotSaved)
    }
}
