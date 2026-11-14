import Foundation
import Testing
@testable import HimawariCore

@Suite(.serialized) struct ServerValueTests {
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

    @Test func aStatusRecordWithANewPhaseStopsTheThinkingSpinner() throws {
        let list = try records(#"[{"id":"r1","sequence":1,"itemId":"s","kind":"status","phase":"waiting_for_input","name":"等你补充","text":"","occurredAt":"2026-11-13T00:00:00Z"}]"#)
        guard case let .working(current, _) = ProcessLine.make(records: list, runStatus: "running") else {
            Issue.record("expected a still line, not thinking")
            return
        }
        #expect(current.phase == .unrecognized)
        #expect(current.title == "等你补充")
        #expect(current.icon == .puzzle)
        let followed = try records(#"[{"id":"r1","sequence":1,"itemId":"s","kind":"status","phase":"waiting_for_input","name":"等你补充","text":"","occurredAt":"2026-11-13T00:00:00Z"},{"id":"r2","sequence":2,"itemId":"m","kind":"message","phase":"updated","name":"answer","text":"","occurredAt":"2026-11-13T00:00:01Z"}]"#)
        guard case let .working(later, _) = ProcessLine.make(records: followed, runStatus: "running") else {
            Issue.record("a later message must not bring the thinking spinner back")
            return
        }
        #expect(later.phase == .unrecognized)
    }

    @Test func waitingForAnUnknownDeviceStatusStopsOnlyWhenTheServerClearlyRefuses() {
        let refused = DeviceAPIError.server(status: 403, code: "DEVICE_SUSPENDED")
        #expect(ConfirmationWait.givesUp(waitingAs: .unrecognized, after: refused))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 403, code: "DEVICE_PENDING")))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 503, code: nil)))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 429, code: nil)))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: URLError(.timedOut)))
        #expect(!ConfirmationWait.givesUp(waitingAs: .pending, after: refused))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 408, code: nil)))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 401, code: "DEVICE_SIGNATURE_INVALID")))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 404, code: "NOT_FOUND")))
        #expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 403, code: nil)))
    }

    @Test func recheckingAnUnknownStateOnlyLeavesThePageOnAClearAnswer() {
        #expect(UnknownStateRecheck.outcome(of: nil) == .connected)
        #expect(UnknownStateRecheck.outcome(of: DeviceAPIError.server(status: 403, code: "DEVICE_REVOKED")) == .removed)
        #expect(UnknownStateRecheck.outcome(of: DeviceAPIError.server(status: 403, code: "DEVICE_PENDING")) == .waiting)
        #expect(UnknownStateRecheck.outcome(of: DeviceAPIError.server(status: 403, code: "DEVICE_SUSPENDED")) == .stillUnknown)
        #expect(UnknownStateRecheck.outcome(of: URLError(.timedOut)) == .stillUnknown)
    }

    @Test func eachNewValueIsReportedOnceAndKnownValuesNeverAre() throws {
        let reports = Reports()
        ServerValueDiagnostics.shared.reset()
        ServerValueDiagnostics.shared.observe { reports.add($0) }
        defer { ServerValueDiagnostics.shared.observe(nil) }
        _ = try decode([ThreadStatus].self, #"["active","zz-diag-new","zz-diag-new","archived"]"#)
        _ = try decode([MessageRole].self, #"["zz-diag-new","owner"]"#)
        let mine = reports.all.filter { $0.raw == "zz-diag-new" }
        #expect(mine == [UnknownServerValue(type: "ThreadStatus", raw: "zz-diag-new"), UnknownServerValue(type: "MessageRole", raw: "zz-diag-new")])
        #expect(!reports.all.contains { $0.raw == "active" || $0.raw == "owner" || $0.raw == "archived" })
    }

    @Test func aLongValueIsCutAndWithoutAnObserverNothingHappens() throws {
        let reports = Reports()
        ServerValueDiagnostics.shared.reset()
        ServerValueDiagnostics.shared.observe(nil)
        _ = try decode([ThreadStatus].self, #"["zz-diag-silent"]"#)
        ServerValueDiagnostics.shared.observe { reports.add($0) }
        defer { ServerValueDiagnostics.shared.observe(nil) }
        let long = "zz-diag-long-" + String(repeating: "x", count: 200)
        _ = try decode([ThreadStatus].self, "[\"\(long)\",\"zz-diag-silent\"]")
        #expect(reports.all.first { $0.raw.hasPrefix("zz-diag-long-") }?.raw.count == 64)
        #expect(reports.all.contains { $0.raw == "zz-diag-silent" })
    }

    @Test func longValuesSharingTheirFirstCharactersCountOnce() throws {
        let reports = Reports()
        ServerValueDiagnostics.shared.reset()
        ServerValueDiagnostics.shared.observe { reports.add($0) }
        defer { ServerValueDiagnostics.shared.observe(nil) }
        let head = "zz-diag-same-" + String(repeating: "y", count: ServerValueDiagnostics.rawLimit)
        _ = try decode([ThreadStatus].self, "[\"\(head)a\",\"\(head)b\"]")
        #expect(reports.all.filter { $0.raw.hasPrefix("zz-diag-same-") }.count == 1)
    }

    @Test func atMostTheDistinctLimitOfValuesIsReported() throws {
        let reports = Reports()
        ServerValueDiagnostics.shared.reset()
        ServerValueDiagnostics.shared.observe { reports.add($0) }
        defer { ServerValueDiagnostics.shared.observe(nil); ServerValueDiagnostics.shared.reset() }
        let values = (0..<(ServerValueDiagnostics.distinctLimit + 1)).map { "\"zz-diag-many-\($0)\"" }.joined(separator: ",")
        _ = try decode([ThreadStatus].self, "[\(values)]")
        #expect(reports.all.filter { $0.raw.hasPrefix("zz-diag-many-") }.count == ServerValueDiagnostics.distinctLimit)
    }
}

private final class Reports: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [UnknownServerValue] = []

    func add(_ item: UnknownServerValue) { lock.withLock { items.append(item) } }
    var all: [UnknownServerValue] { lock.withLock { items } }
}
