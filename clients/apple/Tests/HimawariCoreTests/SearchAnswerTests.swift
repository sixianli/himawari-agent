import Foundation
import HimawariCore
import Testing

struct SearchAnswerTests {
    private func decode(_ json: String) throws -> SearchAnswer {
        try SearchAnswer.decode(Data(json.utf8))
    }

    @Test func decodesAnAnsweredPayloadWithEveryBasisKind() throws {
        let answer = try decode("""
        {"payload":{"state":"answered","query":"我对什么过敏","answer":"花生。","notFoundText":null,
        "basis":[{"kind":"memory","memoryId":"m1","label":"你记下的一条"},
        {"kind":"conversation","threadId":"t1","at":"2026-10-21T01:00:00Z","label":"10 月 21 日的对话"},
        {"kind":"perception","recordId":"r1","label":"感知到的一条"}],"asks":[],"generatedAt":"2026-11-15T00:00:00Z"}}
        """)
        #expect(answer.shownAnswer == "花生。")
        #expect(answer.shownBasis.map(\.kind) == [.memory, .conversation, .perception])
        #expect(answer.shownBasis[1].threadId == "t1")
        #expect(answer.shownBasis[2].recordId == "r1")
    }

    @Test func notFoundShowsTheServerSentenceAndNoBasis() throws {
        let answer = try decode(#"{"payload":{"state":"not_found","query":"q","answer":null,"notFoundText":"没有找到相关的内容。","basis":[{"kind":"memory","memoryId":"m","label":"x"}],"asks":[]}}"#)
        #expect(answer.state == .notFound)
        #expect(answer.shownAnswer == nil)
        #expect(answer.shownBasis.isEmpty)
        #expect(answer.notFoundText == "没有找到相关的内容。")
    }

    @Test func missingBasisAndAsksDefaultToEmpty() throws {
        let answer = try decode(#"{"payload":{"state":"suggestions","query":null}}"#)
        #expect(answer.asks.isEmpty)
        #expect(answer.basis.isEmpty)
    }

    @Test func blankAnswerCountsAsNoAnswer() throws {
        let answer = try decode(#"{"payload":{"state":"answered","query":"q","answer":"  \n","basis":[{"kind":"memory","memoryId":"m","label":"x"}]}}"#)
        #expect(answer.shownAnswer == nil)
        #expect(answer.shownBasis.isEmpty)
    }

    @Test func unknownStateFailsToDecode() {
        #expect(throws: (any Error).self) { try decode(#"{"payload":{"state":"weird","query":null}}"#) }
    }

    @Test func blankQuestionIsNeverSent() {
        #expect(SearchQuestion.trimmed("   \n") == nil)
        #expect(SearchQuestion.trimmed(" 我对什么过敏 ") == "我对什么过敏")
    }
}
