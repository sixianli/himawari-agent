import Foundation
import Testing
@testable import HimawariCore

@Suite struct ScrollCostTests {
    private static let longAnswer = (1...40).map { "## 第 \($0) 段\n\n这是**一段**很长的回答，带 `code` 和 [链接](https://example.com/\($0))。\n\n- 一条\n- 两条\n\n```swift\nlet value = \($0)\n```" }.joined(separator: "\n\n")

    @Test func aSettledAnswerIsParsedOnceNoMatterHowOftenItsRowIsRedrawn() {
        let memo = TextMemo<Int>(limit: 10)
        var made = 0
        for _ in 0..<50 {
            _ = memo.value(for: Self.longAnswer) { text in
                made += 1
                return text.count
            }
        }
        #expect(made == 1)
    }

    @Test func redrawingASettledAnswerReusesTheParsedBlocks() {
        let first = AnswerMarkdown.blocks(Self.longAnswer)
        let started = Date()
        for _ in 0..<200 { _ = AnswerMarkdown.blocks(Self.longAnswer) }
        let cached = Date().timeIntervalSince(started) / 200
        #expect(AnswerMarkdown.blocks(Self.longAnswer) == first)
        #expect(cached < 0.0005)
    }

    @Test func aStreamingAnswerIsStillParsedFreshEachTime() {
        #expect(AnswerMarkdown.blocks("正在写**粗", streaming: true) == [.paragraph("正在写**粗**")])
        #expect(AnswerMarkdown.blocks("正在写**粗体**", streaming: true) == [.paragraph("正在写**粗体**")])
    }

    @Test func aFinishedRunThatIsAlreadyLoadedIsNotFetchedAgainWhenItsRowReappears() {
        #expect(!ExecutionRefresh.needed(loaded: true, runStatus: "completed"))
        #expect(!ExecutionRefresh.needed(loaded: true, runStatus: "failed"))
        #expect(!ExecutionRefresh.needed(loaded: true, runStatus: "cancelled"))
        #expect(ExecutionRefresh.needed(loaded: true, runStatus: "running"))
        #expect(ExecutionRefresh.needed(loaded: false, runStatus: "completed"))
        #expect(ExecutionRefresh.needed(loaded: true, runStatus: nil))
    }
}
