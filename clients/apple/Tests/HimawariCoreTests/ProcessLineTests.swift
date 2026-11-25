import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct ProcessLineTests {
    private func record(_ sequence: Int, _ item: String, _ phase: ExecutionPhase, at second: TimeInterval, kind: ExecutionRecordKind = .tool, activity: String? = nil, icon: String? = nil) -> ExecutionRecord {
        ExecutionRecord(
            id: "r\(sequence)",
            sequence: sequence,
            itemId: item,
            kind: kind,
            phase: phase,
            name: "tool_\(item)",
            occurredAt: Date(timeIntervalSince1970: 1_800_000_000 + second),
            activity: activity,
            activityIcon: icon
        )
    }

    @Test func aFinishedAnswerThatDidNothingShowsNoProcessRow() {
        #expect(ProcessLine.make(records: [], runStatus: "completed").hasNothingToShow)
        #expect(ProcessLine.make(records: [record(1, "s", .started, at: 0, kind: .message)], runStatus: "completed").hasNothingToShow)
        #expect(!ProcessLine.make(records: [record(1, "a", .completed, at: 0)], runStatus: "completed").hasNothingToShow)
        #expect(!ProcessLine.make(records: [], runStatus: "failed").hasNothingToShow)
        #expect(!ProcessLine.make(records: [], runStatus: "cancelled").hasNothingToShow)
        #expect(!ProcessLine.make(records: [], runStatus: "running").hasNothingToShow)
    }

    @Test func noToolStepYetIsThinking() {
        #expect(ProcessLine.make(records: [record(1, "m", .started, at: 0, kind: .message)], runStatus: "running") == .thinking)
    }

    @Test func showsOnlyTheLatestStepAndKeepsTheModelsSentenceAndIcon() {
        let records = [
            record(1, "a", .started, at: 0, activity: "正在看日历", icon: "calendar"),
            record(2, "a", .completed, at: 1),
            record(3, "b", .started, at: 2, activity: "正在查周五早上的新干线", icon: "train"),
        ]
        guard case let .working(current, setback) = ProcessLine.make(records: records, runStatus: "running") else {
            Issue.record("expected working")
            return
        }
        #expect(current.title == "正在查周五早上的新干线")
        #expect(current.icon == .train)
        #expect(setback == nil)
    }

    @Test func aFailedStepStaysAboveTheNextOne() {
        let records = [
            record(1, "a", .started, at: 0),
            record(2, "a", .failed, at: 1, activity: "时刻表没打开，换个地方查"),
            record(3, "b", .started, at: 2),
        ]
        guard case let .working(current, setback) = ProcessLine.make(records: records, runStatus: "running") else {
            Issue.record("expected working")
            return
        }
        #expect(current.id == "b")
        #expect(setback?.title == "时刻表没打开，换个地方查")
    }

    @Test func iconsOutsideTheTableOrOutcomeIconsFallBackToTools() {
        #expect(ProcessIcon.chosen("rocket") == .puzzle)
        #expect(ProcessIcon.chosen(nil) == .puzzle)
        #expect(ProcessIcon.chosen("check") == .puzzle)
        #expect(ProcessIcon.chosen("hand-stop") == .puzzle)
        #expect(ProcessIcon.chosen("world-search") == .worldSearch)
        #expect(ProcessIcon.allCases.count == 40)
    }

    @Test func emptyValuesOnLaterRecordsDoNotEraseTheSentence() {
        let steps = ProcessLine.steps(from: [
            record(1, "a", .started, at: 0, activity: "正在上网查时刻表", icon: "world-search"),
            record(2, "a", .completed, at: 1, activity: "", icon: ""),
        ])
        #expect(steps.first?.title == "正在上网查时刻表")
        #expect(steps.first?.icon == .worldSearch)
        #expect(steps.first?.phase == .completed)
    }

    @Test func withoutASentenceTheStepNameIsShown() {
        let steps = ProcessLine.steps(from: [record(1, "a", .started, at: 0, activity: "  ")])
        #expect(steps.first?.title == "tool_a")
    }

    @Test func waitingShowsWhileItIsTheLatestRecord() {
        let records = [record(1, "a", .started, at: 0, activity: "正在写邮件", icon: "mail"), record(2, "a", .waiting, at: 2, activity: "要给田中发邮件，等你点头", icon: "mail")]
        guard case let .waiting(step) = ProcessLine.make(records: records, runStatus: "running") else {
            Issue.record("expected waiting")
            return
        }
        #expect(step.id == "a")
        #expect(step.title == "要给田中发邮件，等你点头")
        #expect(step.icon == .mail)
    }

    @Test func aRunSuspendedForApprovalWaitsOnItsLastStep() {
        let records = [record(1, "a", .started, at: 0, activity: "要给田中发邮件", icon: "mail"), record(2, "run", .waiting, at: 1, kind: .status)]
        guard case let .waiting(step) = ProcessLine.make(records: records, runStatus: "running") else {
            Issue.record("expected waiting")
            return
        }
        #expect(step.id == "a")
        #expect(step.phase == .waiting)
    }

    @Test func aRunSuspendedBeforeAnyStepStillWaits() {
        let records = [record(1, "run", .started, at: 0, kind: .status), record(2, "run", .waiting, at: 1, kind: .status)]
        guard case let .waiting(step) = ProcessLine.make(records: records, runStatus: "running") else {
            Issue.record("expected waiting")
            return
        }
        #expect(step.title == "")
        #expect(step.phase == .waiting)
    }

    @Test func aWaitingMessageRecordIsNotAnApproval() {
        let records = [record(1, "a", .started, at: 0, activity: "正在写邮件"), record(2, "m", .waiting, at: 1, kind: .message)]
        guard case .working = ProcessLine.make(records: records, runStatus: "running") else {
            Issue.record("expected working")
            return
        }
    }

    @Test func aNewerRecordEndsTheWait() {
        let records = [record(1, "a", .waiting, at: 0, activity: "要给田中发邮件，等你点头", icon: "mail"), record(2, "b", .started, at: 1, activity: "正在发邮件")]
        guard case let .working(current, _) = ProcessLine.make(records: records, runStatus: "running") else {
            Issue.record("expected working")
            return
        }
        #expect(current.id == "b")
    }

    @Test func finishedRunCollapsesWithItsDuration() {
        let records = [record(1, "a", .started, at: 0), record(2, "a", .completed, at: 3), record(3, "m", .completed, at: 8, kind: .message)]
        guard case let .finished(steps, seconds) = ProcessLine.make(records: records, runStatus: "completed") else {
            Issue.record("expected finished")
            return
        }
        #expect(steps.map(\.id) == ["a"])
        #expect(seconds == 8)
        guard case .failed = ProcessLine.make(records: records, runStatus: "failed") else {
            Issue.record("expected failed")
            return
        }
        guard case .stopped = ProcessLine.make(records: records, runStatus: "cancelled") else {
            Issue.record("expected stopped")
            return
        }
    }

    @Test func executionPageDecodesServerRecords() async throws {
        let response = """
        {"type":"thread.execution_snapshot","payload":{"threadId":"t1","runId":"run1","records":[{"id":"x1","sequence":1,"itemId":"i1","kind":"tool","phase":"started","name":"web_search","text":"","input":"{}","output":"","activity":"","activityIcon":"","occurredAt":"2026-11-12T00:00:00.123Z"}],"nextSequence":null,"generatedAt":"2026-11-12T00:00:01Z"}}
        """
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(response.utf8))])
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let page = try await DeviceAPI(http: http).execution(threadId: "t1", runId: "run:0a1b", afterSequence: 4)
        #expect(page.records.first?.name == "web_search")
        #expect(page.records.first?.activityIcon == "")
        #expect(page.nextSequence == nil)
        #expect(exchange.requests.first?.url?.absoluteString == "https://himawari.example.test/api/device/v1/threads/t1/runs/run:0a1b/execution?after=4")
    }
}
