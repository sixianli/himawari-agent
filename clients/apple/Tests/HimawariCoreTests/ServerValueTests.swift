import Foundation
import Testing
@testable import HimawariCore

@Suite struct ServerValueTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func valuesTheAppDoesNotKnowYetFallBackToTheGeneralCase() throws {
        #expect(try decode([ExecutionRecordKind].self, #"["tool","handoff"]"#) == [.tool, .unrecognized])
        #expect(try decode([ExecutionPhase].self, #"["waiting","paused"]"#) == [.waiting, .unrecognized])
        #expect(try decode([ThreadStatus].self, #"["archived","snoozed"]"#) == [.archived, .active])
        #expect(try decode([MessageRole].self, #"["agent","helper"]"#) == [.agent, .system])
        #expect(try decode([MessageStatus].self, #"["partial","redacted"]"#) == [.partial, .committed])
        #expect(try decode([PairedDeviceStatus].self, #"["revoked","suspended"]"#) == [.revoked, .pending])
    }

    @Test func aMessageWithANewRoleStillDecodes() throws {
        let json = #"{"messageId":"m1","sequence":1,"role":"helper","contentRef":"c1","status":"redacted","turnId":null,"runId":null,"committedAt":"2026-11-13T00:00:00Z"}"#
        let message = try decode(ThreadMessage.self, json)
        #expect(message.role == .system)
        #expect(message.status == .committed)
    }

    @Test func aValueThatIsNotTextIsStillRejected() {
        #expect(throws: (any Error).self) { try decode([ThreadStatus].self, "[1]") }
    }

    @Test func knownValuesEncodeUnchanged() throws {
        let data = try JSONEncoder().encode([ThreadStatus.deletionPending, .active])
        #expect(String(decoding: data, as: UTF8.self) == #"["deletion_pending","active"]"#)
    }

    @Test func aThreadListWithANewStatusStillDecodesWholeAndOrdinary() throws {
        let json = #"[{"threadId":"t1","revision":1,"status":"snoozed","titleRef":null,"pinOrder":null,"answerLocale":"zh-Hans","messageWatermark":0,"createdAt":"2026-11-13T00:00:00Z","updatedAt":"2026-11-13T00:00:00Z"},{"threadId":"t2","revision":1,"status":"active","titleRef":null,"pinOrder":null,"answerLocale":"zh-Hans","messageWatermark":0,"createdAt":"2026-11-13T00:00:00Z","updatedAt":"2026-11-13T00:00:00Z"}]"#
        let threads = try decode([ThreadSummary].self, json)
        #expect(threads.map(\.status) == [.active, .active])
        #expect(threads.map(\.pinOrder) == [nil, nil])
    }

    @Test func anUnknownStepShowsAsAGeneralStepThatIsNeitherRunningNorDone() throws {
        let json = #"[{"id":"r1","sequence":1,"itemId":"a","kind":"handoff","phase":"paused","name":"交给 Mac","text":"","occurredAt":"2026-11-13T00:00:00Z"}]"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let records = try decoder.decode([ExecutionRecord].self, from: Data(json.utf8))
        let steps = ProcessLine.steps(from: records)
        #expect(steps.count == 1)
        #expect(steps.first?.icon == .puzzle)
        #expect(steps.first?.phase == .unrecognized)
        #expect(steps.first?.title == "交给 Mac")
        guard case let .finished(finished, _) = ProcessLine.make(records: records, runStatus: "completed") else {
            Issue.record("a finished run stays finished whatever its steps say")
            return
        }
        #expect(finished.count == 1)
    }

    @Test func aPairingWithANewDeviceStatusIsNotTakenAsConnected() throws {
        #expect(try decode(PairedDeviceStatus.self, #""suspended""#) != .active)
    }
}
