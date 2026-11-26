import Foundation
import Testing
@testable import HimawariCore

@MainActor
final class SlowFinish {
    private var waiting: CheckedContinuation<String, Never>?
    let said: String

    init(said: String) {
        self.said = said
    }

    func finish() async -> String {
        await withCheckedContinuation { waiting = $0 }
    }

    func deliver() {
        waiting?.resume(returning: said)
        waiting = nil
    }

    var pending: Bool { waiting != nil }
}

@MainActor
@Suite struct DictationDraftTests {
    private func settle(_ finish: SlowFinish) async {
        for _ in 0..<100 where !finish.pending { await Task.yield() }
    }

    @Test func sendingWhileListeningSendsTheFinalWordsOnce() async {
        let dictation = DictationDraft()
        dictation.begin(draft: "")
        #expect(dictation.live("我在纠结") == "我在纠结")
        let finish = SlowFinish(said: "我在纠结要不要去上课")
        async let sent = dictation.submit(draft: "我在纠结") { await finish.finish() }
        await settle(finish)
        #expect(dictation.live("我在纠结要不要") == nil)
        finish.deliver()
        #expect(await sent == "我在纠结要不要去上课")
    }

    @Test func aStopThatFinishesAfterTheMessageWasSentDoesNotRefillTheInput() async {
        let dictation = DictationDraft()
        dictation.begin(draft: "")
        let finish = SlowFinish(said: "我在纠结要不要去上课")
        async let refill = dictation.stop { await finish.finish() }
        await settle(finish)
        #expect(await dictation.submit(draft: "我在纠结要不要去上课") { "" } == "我在纠结要不要去上课")
        finish.deliver()
        #expect(await refill == nil)
    }

    @Test func stoppingWithoutSendingPutsTheWordsAfterWhatWasTyped() async {
        let dictation = DictationDraft()
        dictation.begin(draft: "明天")
        #expect(await dictation.stop { "去上课" } == "明天 去上课")
    }

    @Test func sendingWhenNotListeningSendsTheTypedText() async {
        let dictation = DictationDraft()
        #expect(await dictation.submit(draft: "直接打的字") { "不该用到" } == "直接打的字")
    }

    @Test func silenceKeepsWhatWasShown() async {
        let dictation = DictationDraft()
        dictation.begin(draft: "")
        #expect(await dictation.submit(draft: "已经显示的字") { "" } == "已经显示的字")
    }
}
