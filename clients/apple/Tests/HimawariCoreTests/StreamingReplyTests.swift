import Foundation
import Testing
@testable import HimawariCore

@Suite struct StreamingReplyTests {
    private func chunk(_ item: String, _ offset: Int, _ text: String, run: String = "r1") -> ExecutionText {
        ExecutionText(threadId: "t1", runId: run, itemId: item, offset: offset, text: text)
    }

    @Test func assemblesOutOfOrderChunksByOffset() {
        var reply = StreamingReply(runId: "r1")
        reply.apply(chunk("i1", 3, "大阪"))
        #expect(reply.text.isEmpty)
        reply.apply(chunk("i1", 0, "周五去"))
        #expect(reply.text == "周五去大阪")
    }

    @Test func overlappingResendDoesNotDuplicate() {
        var reply = StreamingReply(runId: "r1")
        reply.apply(chunk("i1", 0, "abc"))
        reply.apply(chunk("i1", 1, "bcdef"))
        #expect(reply.text == "abcdef")
    }

    @Test func offsetsCountUTF16UnitsLikeTheServer() {
        var reply = StreamingReply(runId: "r1")
        reply.apply(chunk("i1", 0, "🌻"))
        reply.apply(chunk("i1", 2, "好"))
        #expect(reply.text == "🌻好")
    }

    @Test func otherRunsAreIgnoredAndItemsKeepArrivalOrder() {
        var reply = StreamingReply(runId: "r1")
        reply.apply(chunk("i2", 0, "第二段"))
        reply.apply(chunk("i1", 0, "第一段"))
        reply.apply(chunk("i1", 0, "别的", run: "r2"))
        #expect(reply.text == "第二段\n\n第一段")
    }

    private func detail(_ runs: [(String, String)]) throws -> ThreadDetail {
        let thread = ThreadSummary(threadId: "t1", revision: 1, status: .active, titleRef: nil, pinOrder: nil, answerLocale: "zh-CN", messageWatermark: 0, createdAt: "", updatedAt: "")
        let runList = try runs.map { runId, status in
            try JSONDecoder().decode(ThreadRunSummary.self, from: Data(#"{"runId":"\#(runId)","revision":1,"status":"\#(status)"}"#.utf8))
        }
        return ThreadDetail(thread: thread, messages: [], runs: runList, nextSequence: nil)
    }

    @Test func theLastAnswersTextIsSettledOnceANewQuestionStartsTheNextRun() throws {
        var reply = StreamingReply(runId: "r1")
        reply.apply(chunk("i1", 0, "2。"))
        #expect(reply.isSettled(in: try detail([("r1", "completed"), ("r2", "accepted")])))
        #expect(reply.isSettled(in: try detail([("r1", "failed"), ("r2", "running")])))
    }

    @Test func aRunStillWorkingOrNotYetLoadedKeepsItsText() throws {
        let reply = StreamingReply(runId: "r2")
        #expect(!reply.isSettled(in: try detail([("r1", "completed"), ("r2", "running")])))
        #expect(!reply.isSettled(in: try detail([("r1", "completed")])))
        #expect(!reply.isSettled(in: nil))
    }
}
