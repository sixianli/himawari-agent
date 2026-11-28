import Foundation
import Testing
@testable import HimawariCore

@Suite struct TranscriptLayoutTests {
    private func message(_ id: String, _ sequence: Int, _ role: MessageRole, run: String?) -> ThreadMessage {
        ThreadMessage(messageId: id, sequence: sequence, role: role, contentRef: "ref-\(id)", status: .committed, turnId: nil, runId: run, committedAt: "2026-11-28T02:00:00Z")
    }

    private func run(_ id: String, _ status: String) -> ThreadRunSummary {
        ThreadRunSummary(runId: id, revision: 1, status: status)
    }

    @Test func aRunThatFailedWithoutAnyReplyShowsRightUnderTheQuestionInsteadOfVanishing() {
        let question = message("q", 1, .owner, run: "r1")
        let later = message("q2", 2, .owner, run: "r2")
        let answer = message("a2", 3, .agent, run: "r2")
        let entries = TranscriptLayout.entries(messages: [question, later, answer], runs: [run("r1", "failed"), run("r2", "completed")])
        #expect(entries == [.message(question), .process(runId: "r1"), .message(later), .process(runId: "r2"), .message(answer)])
        #expect(TranscriptLayout.line(records: nil, runStatus: "failed") == .failed(steps: [], seconds: 0))
    }

    @Test func aStoppedRunWithoutAReplySaysItStopped() {
        let question = message("q", 1, .owner, run: "r1")
        let entries = TranscriptLayout.entries(messages: [question], runs: [run("r1", "cancelled")])
        #expect(entries == [.message(question), .process(runId: "r1")])
        #expect(TranscriptLayout.line(records: nil, runStatus: "cancelled") == .stopped(steps: [], seconds: 0))
    }

    @Test func aCompletedRunWithoutAReplyStillShowsNothing() {
        let question = message("q", 1, .owner, run: "r1")
        #expect(TranscriptLayout.entries(messages: [question], runs: [run("r1", "completed")]) == [.message(question)])
        #expect(TranscriptLayout.line(records: nil, runStatus: "completed") == nil)
    }

    @Test func aFailedRunThatDidReplyShowsItsRowOnceAboveTheReply() {
        let question = message("q", 1, .owner, run: "r1")
        let answer = message("a", 2, .agent, run: "r1")
        let entries = TranscriptLayout.entries(messages: [question, answer], runs: [run("r1", "failed")])
        #expect(entries == [.message(question), .process(runId: "r1"), .message(answer)])
    }

    @Test func aRunStillWorkingShowsThinkingAtTheBottom() {
        let question = message("q", 1, .owner, run: "r1")
        let entries = TranscriptLayout.entries(messages: [question], runs: [run("r1", "accepted")])
        #expect(entries == [.message(question), .process(runId: "r1")])
        #expect(TranscriptLayout.line(records: nil, runStatus: "accepted") == .thinking)
    }

    @Test func aMessageTheServerAcceptedShowsThinkingBeforeItsRunArrives() {
        #expect(TranscriptLayout.awaitsReply(runs: [], acceptedNotShown: true))
        #expect(TranscriptLayout.awaitsReply(runs: [run("r0", "completed")], acceptedNotShown: true))
    }

    @Test func thinkingIsNotShownTwiceOnceTheRunIsListed() {
        #expect(!TranscriptLayout.awaitsReply(runs: [run("r1", "accepted")], acceptedNotShown: true))
        #expect(!TranscriptLayout.awaitsReply(runs: [run("r1", "waiting_for_owner")], acceptedNotShown: true))
    }

    @Test func nothingSentMeansNoThinkingRow() {
        #expect(!TranscriptLayout.awaitsReply(runs: [], acceptedNotShown: false))
        #expect(!TranscriptLayout.awaitsReply(runs: [run("r0", "failed")], acceptedNotShown: false))
    }
}
