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
        #expect(options.isOpen)
    }

    @Test func aChosenOrStaleSetIsNoLongerOpen() throws {
        for state in ["chosen", "stale", "something-new"] {
            let message = try decode("""
            {\(base),"options":{"setId":"s1","items":[
              {"optionId":"o1","label":"查哪家最便宜","reason":null,"action":null,"state":"\(state)"},
              {"optionId":"dismiss","label":"不用了","reason":null,"action":null,"state":"open"}]}}
            """)
            #expect(message.options?.isOpen == false)
        }
    }

    @Test func aMessageWithoutOptionsStillDecodes() throws {
        let message = try decode("{\(base)}")
        #expect(message.options == nil)
        #expect(message.chosenFrom == nil)
    }

    @Test func theOwnersPickPointsBackToItsOption() throws {
        let owner = base.replacingOccurrences(of: #""role":"agent""#, with: #""role":"owner""#)
        let message = try decode(#"{\#(owner),"chosenFrom":{"setId":"s1","optionId":"o1"}}"#)
        #expect(message.chosenFrom == ChosenOption(setId: "s1", optionId: "o1"))
    }
}
