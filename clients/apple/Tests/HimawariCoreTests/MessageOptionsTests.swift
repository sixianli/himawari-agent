import Foundation
import Testing

@testable import HimawariCore

@Suite struct MessageOptionsTests {
    private func decode(_ json: String) throws -> ThreadMessage {
        try JSONDecoder().decode(ThreadMessage.self, from: Data(json.utf8))
    }

    private let base = #""messageId":"m1","sequence":3,"role":"agent","contentRef":"text:m1","status":"committed","committedAt":"2026-11-25T02:00:00Z""#

    @Test func readsTheServersOptionsInOrder() throws {
        let message = try decode("""
        {\(base),"options":{"setId":"s1","items":[
          {"optionId":"o1","label":"回复 田中：周四 15:00 可以","reason":null,"action":{"tool":"mail.reply","summary":"给田中回邮件"},"state":"open"},
          {"optionId":"o2","label":"先记进日历","reason":"你周四下午空着","action":null,"state":"open"},
          {"optionId":"dismiss","label":"不用了","reason":null,"action":null,"state":"open"}]}}
        """)
        let options = try #require(message.options)
        #expect(options.setId == "s1")
        #expect(options.items.map(\.label) == ["回复 田中：周四 15:00 可以", "先记进日历", "不用了"])
        #expect(options.items.map { $0.action != nil } == [true, false, false])
        #expect(options.items.map(\.isDismiss) == [false, false, true])
        #expect(options.items[1].reason == "你周四下午空着")
        #expect(options.items.map(\.isOpen) == [true, true, true])
    }

    @Test func onlyTheChosenOrStaleOptionStopsBeingTappable() throws {
        for state in ["chosen", "stale", "something-new"] {
            let message = try decode("""
            {\(base),"options":{"setId":"s1","items":[
              {"optionId":"o1","label":"查哪家最便宜","reason":null,"action":null,"state":"\(state)"},
              {"optionId":"dismiss","label":"不用了","reason":null,"action":null,"state":"open"}]}}
            """)
            #expect(message.options?.items.map(\.isOpen) == [false, true])
        }
    }

    @Test func aMessageWithoutOptionsStillDecodes() throws {
        let message = try decode("{\(base)}")
        #expect(message.options == nil)
        #expect(message.chosenFrom == nil)
    }

    @Test func optionsTheAppCannotReadAreDroppedAndTheMessageStillShows() throws {
        let broken = [
            #""options":{"setId":"s1","items":[{"optionId":"o1","label":"查哪家最便宜","action":null}]}"#,
            #""options":{"setId":"s1","items":[{"optionId":"o1","label":"回复","action":{"tool":"mail.reply"},"state":"open"}]}"#,
            #""options":{"setId":"s1","items":"nope"}"#,
            #""options":null,"chosenFrom":{"setId":7}"#,
        ]
        for extra in broken {
            let message = try decode("{\(base),\(extra)}")
            #expect(message.messageId == "m1")
            #expect(message.options == nil)
            #expect(message.chosenFrom == nil)
        }
        #expect(throws: DecodingError.self) { try decode(#"{"messageId":"m1","options":{"setId":"s1","items":[]}}"#) }
    }

    @Test func anActionOptionKeepsOneKeySoARetryRunsItOnce() throws {
        let message = try decode("""
        {\(base),"options":{"setId":"s1","items":[
          {"optionId":"o1","label":"回复 田中：周四 15:00 可以","reason":null,"action":{"tool":"mail.reply","summary":"给田中回邮件"},"state":"open"},
          {"optionId":"o2","label":"先记进日历","reason":null,"action":{"tool":"calendar.add","summary":"记进日历"},"state":"open"},
          {"optionId":"dismiss","label":"不用了","reason":null,"action":null,"state":"open"}]}}
        """)
        let options = try #require(message.options)
        let first = try #require(options.choiceKey(threadId: "t1", messageId: "m1", item: options.items[0]))
        #expect(options.choiceKey(threadId: "t1", messageId: "m1", item: options.items[0]) == first)
        #expect(options.choiceKey(threadId: "t1", messageId: "m1", item: options.items[1]) != first)
        #expect(options.choiceKey(threadId: "t2", messageId: "m1", item: options.items[0]) != first)
        #expect(options.choiceKey(threadId: "t1", messageId: "m1", item: options.items[2]) == nil)
        #expect(first.count <= 128)
        #expect(first.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]*$"#, options: .regularExpression) != nil)
    }

    @Test func theOwnersPickPointsBackToItsOption() throws {
        let owner = base.replacingOccurrences(of: #""role":"agent""#, with: #""role":"owner""#)
        let message = try decode(#"{\#(owner),"chosenFrom":{"setId":"s1","optionId":"o1"}}"#)
        #expect(message.chosenFrom == ChosenOption(setId: "s1", optionId: "o1"))
    }
}
