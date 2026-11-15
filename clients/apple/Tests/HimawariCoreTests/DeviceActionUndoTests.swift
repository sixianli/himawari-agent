import Foundation
import Testing

@testable import HimawariCore

@Suite struct DeviceActionUndoTests {
    let challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    func view(_ undo: String?) throws -> DeviceActionView {
        let field = undo.map { #","undo":"\#($0)""# } ?? ""
        let json = """
        {"id":"dact_1","deviceId":"dev_1","state":"succeeded","risk":"medium","ownerPresence":false,"reversible":true,
         "createdAt":"2026-11-13T05:11:00.000Z","updatedAt":"2026-11-13T05:11:04.000Z",
         "detail":{"zh-CN":"x","en":"x","ja":"x"}\(field)}
        """
        return try JSONDecoder().decode(DeviceActionView.self, from: Data(json.utf8))
    }

    func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    @Test func theServersUndoStateIsReadAndAnythingElseMeansNoUndo() throws {
        for state in ["available", "pending", "done", "failed", "none"] {
            #expect(try view(state).undo.rawValue == state)
        }
        #expect(try view(nil).undo == .none)
        #expect(try view("from_the_future").undo == .none)
    }

    @Test func aSucceededActionThatWasUndoneReadsAsUndoneAndOthersDoNot() throws {
        #expect(DeviceActionResultKind(try view("done")) == .undone)
        #expect(DeviceActionResultKind(try view("available")) == .done)
        #expect(DeviceActionResultKind(try view("failed")) == .done)
        #expect(DeviceActionResultKind(try view(nil)) == .done)
    }

    @Test func aSignedUndoAsksForTheChallengeAndPostsTheActionId() async throws {
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 201, body: Data(#"{"challenge":"\#(challenge)","expiresAt":"2026-11-13T06:40:00.000Z"}"#.utf8)),
            HTTPExchangeResponse(status: 200, body: Data(#"{"id":"dact_1","state":"queued"}"#.utf8)),
        ])
        let reply = try await api(exchange).undoAction(id: "dact_1", confirm: try SoftwareKeySigner(), reason: "r")
        #expect(reply == .recorded(state: "queued"))
        #expect(exchange.requests.count == 2)
        #expect(exchange.requests[0].url?.path.hasSuffix("approvals/challenge") == true)
        #expect(exchange.requests[1].url?.path == "/api/device/v1/actions/undo")
        let input = try #require(exchange.requests[1].value(forHTTPHeaderField: "Signature-Input"))
        #expect(input.components(separatedBy: challenge).count - 1 == 2)
        let data = try #require(exchange.requests[1].httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["id"] as? String == "dact_1")
    }

    @Test func anUndoWithoutAConfirmKeyAsksForNoChallenge() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(#"{"id":"dact_1","state":"queued"}"#.utf8))])
        _ = try await api(exchange).undoAction(id: "dact_1", confirm: nil, reason: "r")
        #expect(exchange.requests.map { $0.url?.path } == ["/api/device/v1/actions/undo"])
    }

    @Test func notFoundAndNotUndoableAreTold() async throws {
        let missing = RecordingExchange([HTTPExchangeResponse(status: 404, body: Data(#"{"error":{"code":"DEVICE_ACTION_NOT_FOUND"}}"#.utf8))])
        #expect(try await api(missing).undoAction(id: "dact_1", confirm: nil, reason: "r") == .notFound)
        let gone = RecordingExchange([HTTPExchangeResponse(status: 409, body: Data(#"{"error":{"code":"DEVICE_ACTION_NOT_UNDOABLE"}}"#.utf8))])
        #expect(try await api(gone).undoAction(id: "dact_1", confirm: nil, reason: "r") == .notUndoable)
    }

    @Test func aMadeCalendarEventPutsItsEventIdAtTheTopOfTheEvidenceAndKeepsTheOldValues() throws {
        let made: JSONObject = ["eventId": .string("ev1"), "title": .string("t")]
        let before: JSONObject = ["title": .string("old")]
        let evidence = try #require(DeviceActionExecutor.evidence(made: made, before: before))
        #expect(evidence["eventId"] == .string("ev1"))
        #expect(evidence["done"] == .object(made))
        #expect(evidence["before"] == .object(before))
    }

    @Test func evidenceWithoutAnEventIdHasNoTopLevelEventId() throws {
        let evidence = try #require(DeviceActionExecutor.evidence(made: ["lines": .number(1)]))
        #expect(evidence["eventId"] == nil)
        #expect(DeviceActionExecutor.evidence(made: ["eventId": .string("")])?["eventId"] == nil)
    }
}
