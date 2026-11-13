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
        #expect(try decode([MessageRole].self, #"["owner","helper"]"#) == [.owner, .agent])
        #expect(try decode([MessageStatus].self, #"["partial","redacted"]"#) == [.partial, .committed])
        #expect(try decode([PairedDeviceStatus].self, #"["revoked","suspended"]"#) == [.revoked, .unrecognized])
        #expect(try decode([DeviceKind].self, #"["iphone","ipad"]"#) == [.iphone, .unrecognized])
        #expect(try decode([ReleaseChannel].self, #"["testflight","enterprise"]"#) == [.testflight, .unrecognized])
    }

    @Test func aMessageWithANewRoleStillDecodes() throws {
        let json = #"{"messageId":"m1","sequence":1,"role":"helper","contentRef":"c1","status":"redacted","turnId":null,"runId":null,"committedAt":"2026-11-13T00:00:00Z"}"#
        let message = try decode(ThreadMessage.self, json)
        #expect(message.role == .agent)
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

    @Test func aPairingWithANewDeviceStatusIsNeitherConnectedNorRemovedAndSurvivesStorage() throws {
        let json = #"{"id":"dev_1","revision":1,"kind":"ipad","name":"x","releaseChannel":"enterprise","status":"suspended","pairingNumber":"123456"}"#
        let device = try decode(PairedDeviceInfo.self, json)
        #expect(device.status == .unrecognized)
        let record = PairingRecord(origin: URL(string: "https://example.test")!, deviceId: device.id, access: nil, status: device.status, pairingNumber: "123456")
        let stored = try JSONDecoder().decode(PairingRecord.self, from: JSONEncoder().encode(record))
        #expect(stored.status == .unrecognized)
    }

    private func records(_ json: String) throws -> [ExecutionRecord] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([ExecutionRecord].self, from: Data(json.utf8))
    }

    @Test func aNewKindOfStepNeverSpinsOrAsksForApprovalWhateverItsPhase() throws {
        for phase in ["started", "completed", "waiting", "failed"] {
            let list = try records(#"[{"id":"r1","sequence":1,"itemId":"a","kind":"handoff","phase":"\#(phase)","name":"交给 Mac","text":"","occurredAt":"2026-11-13T00:00:00Z"}]"#)
            let line = ProcessLine.make(records: list, runStatus: "running")
            guard case let .working(current, _) = line else {
                Issue.record("phase \(phase) gave \(line)")
                continue
            }
            #expect(current.phase == .unrecognized)
            #expect(current.icon == .puzzle)
        }
    }

    @Test func aKnownStepWithANewPhaseStopsSpinningWhileTheRunGoesOn() throws {
        let list = try records(#"[{"id":"r1","sequence":1,"itemId":"a","kind":"tool","phase":"paused","name":"search","text":"","activity":"在查","activityIcon":"search","occurredAt":"2026-11-13T00:00:00Z"}]"#)
        guard case let .working(current, _) = ProcessLine.make(records: list, runStatus: "running") else {
            Issue.record("expected a working line")
            return
        }
        #expect(current.phase == .unrecognized)
        #expect(current.title == "在查")
    }
}
