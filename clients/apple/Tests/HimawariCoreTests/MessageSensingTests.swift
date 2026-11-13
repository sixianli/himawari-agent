import Foundation
@testable import HimawariCore
import Testing

@Suite struct MessageSensingTests {
    let row = MessageRow(rowId: 41, guid: "p:0/ABC-123", text: "周五的会改到 15:00", appleDate: 784_000_000_000_000_000, fromMe: false, service: "iMessage", sender: "+81 90-1234-5678")

    @Test func anIMessageBecomesOneSensitiveMessageTextRecordWithTheServerShape() throws {
        let record = try #require(MessageSensing.record(row))
        #expect(record.type == "message.text")
        #expect(record.captureSource == "system_api")
        #expect(record.text == "周五的会改到 15:00")
        #expect(record.evidence == ["service": "imessage", "direction": "incoming", "sender": "+81 90-1234-5678"])
        #expect(record.id.range(of: #"^perception:[A-Za-z0-9_-]{16,64}$"#, options: .regularExpression) != nil)
        #expect(record.occurredAt.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) != nil)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any])
        #expect(Set(json.keys) == ["id", "type", "captureSource", "occurredAt", "confidence", "text", "evidence"])
    }

    @Test func theSameMessageAlwaysGetsTheSameIdSoARetryIsADuplicateNotACopy() throws {
        let first = try #require(MessageSensing.record(row))
        let again = try #require(MessageSensing.record(MessageRow(rowId: 99, guid: row.guid, text: "x", appleDate: 0, fromMe: true, service: "SMS", sender: nil)))
        #expect(first.id == again.id)
        #expect(first.id != MessageSensing.record(MessageRow(rowId: 41, guid: "other", text: "x", appleDate: 0, fromMe: false, service: "SMS", sender: nil))?.id)
    }

    @Test func nanosecondAndSecondDatesBothCountFrom2001() {
        #expect(MessageSensing.date(784_000_000_000_000_000) == Date(timeIntervalSinceReferenceDate: 784_000_000))
        #expect(MessageSensing.date(500_000_000) == Date(timeIntervalSinceReferenceDate: 500_000_000))
        #expect(MessageSensing.timestamp(Date(timeIntervalSinceReferenceDate: 0)) == "2001-01-01T00:00:00.000Z")
    }

    @Test func smsAndRcsAreSmsOtherServicesAndEmptyTextAreSkipped() {
        #expect(MessageSensing.record(MessageRow(rowId: 1, guid: "a", text: "hi", appleDate: 0, fromMe: true, service: "SMS", sender: nil))?.evidence == ["service": "sms", "direction": "outgoing"])
        #expect(MessageSensing.record(MessageRow(rowId: 1, guid: "a", text: "hi", appleDate: 0, fromMe: false, service: "RCS", sender: nil))?.evidence["service"] == "sms")
        #expect(MessageSensing.record(MessageRow(rowId: 1, guid: "a", text: "hi", appleDate: 0, fromMe: false, service: "Satellite", sender: nil)) == nil)
        #expect(MessageSensing.record(MessageRow(rowId: 1, guid: "a", text: " \n", appleDate: 0, fromMe: false, service: "iMessage", sender: nil)) == nil)
        #expect(MessageSensing.record(MessageRow(rowId: 1, guid: "a", text: nil, appleDate: 0, fromMe: false, service: "iMessage", sender: nil)) == nil)
    }

    @Test func longTextAndSenderAreCutByUtf16LengthWithoutSplittingAnEmoji() throws {
        let text = String(repeating: "a", count: MessageSensing.textLimit - 1) + "😀"
        let record = try #require(MessageSensing.record(MessageRow(rowId: 1, guid: "a", text: text, appleDate: 0, fromMe: false, service: "iMessage", sender: String(repeating: "😀", count: 100))))
        #expect(record.text?.utf16.count == MessageSensing.textLimit - 1)
        #expect(record.evidence["sender"]?.utf16.count == MessageSensing.senderLimit)
    }

    @Test func turningItOnStartsAtTheNewestMessageAndNeverReadsOlderOnes() {
        #expect(MessageSensing.startingRow(enabled: true, saved: nil, newest: 5000) == 5000)
        #expect(MessageSensing.startingRow(enabled: true, saved: 4800, newest: 5000) == 4800)
        #expect(MessageSensing.startingRow(enabled: false, saved: 4800, newest: 5000) == nil)
    }

    @Test func turningItOffForgetsWhereItWasSoTurningItBackOnSkipsTheGap() {
        var settings = MacAccessSettings(seesMessages: true)
        settings.messagesAfterRow = 4800
        let decoded = try? JSONDecoder().decode(MacAccessSettings.self, from: JSONEncoder().encode(settings))
        #expect(decoded?.messagesAfterRow == 4800)
        let old = try? JSONDecoder().decode(MacAccessSettings.self, from: Data(#"{"folders":[],"apps":[],"seesFrontmost":true,"seesMessages":false,"shortcut":{"keyCode":49,"modifiers":2048,"key":"space"}}"#.utf8))
        #expect(old?.messagesAfterRow == nil)
    }

    @Test func aBatchTheServerRejectsIsRetriedOneByOneAndOnlyTheBadRecordIsSkipped() async throws {
        let records = try [row, MessageRow(rowId: 42, guid: "b", text: "ok", appleDate: 0, fromMe: true, service: "SMS", sender: nil)].map { try #require(MessageSensing.record($0)) }
        let reply = #"{"outcomes":[],"reached":[]}"#
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 400, body: Data(#"{"error":{"code":"PERCEPTION_INVALID"}}"#.utf8)),
            HTTPExchangeResponse(status: 400, body: Data(#"{"error":{"code":"PERCEPTION_INVALID"}}"#.utf8)),
            HTTPExchangeResponse(status: 200, body: Data(reply.utf8)),
        ])
        let api = DeviceAPI(http: try uploadClient(exchange))
        let skipped = try await api.perceiveSkippingInvalid(records)
        #expect(skipped == [records[0].id])
        #expect(exchange.requests.count == 3)
        #expect(exchange.requests.allSatisfy { $0.url?.path.hasSuffix("/perception") == true && $0.httpMethod == "POST" })
        let body = try #require(exchange.requests[0].httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect((sent["records"] as? [Any])?.count == 2)
    }

    @Test func aServerOrNetworkFailureIsNotSkippedSoTheCursorStaysPut() async throws {
        let record = try #require(MessageSensing.record(row))
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 503, body: Data())])
        let api = DeviceAPI(http: try uploadClient(exchange))
        await #expect(throws: DeviceAPIError.self) { try await api.perceiveSkippingInvalid([record]) }
    }
}
