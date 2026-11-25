import Foundation
import Testing
@testable import HimawariCore

@Suite struct AnswerLinksTests {
    @Test func copyingYourOwnMessageLeavesOutAttachmentTags() {
        let raw = "看看这个\n\n<file name=\"a.pdf\" ref=\"r1\" bytes=\"10\" kind=\"pdf\"/>"
        #expect(MessageCopy.text(raw, fromAgent: false) == "看看这个")
        #expect(MessageCopy.text("**粗体** `code`", fromAgent: true) == "**粗体** `code`")
    }

    #if canImport(Darwin)
    @Test func bareWebAddressesBecomeLinks() {
        let linked = AnswerLinks.linkingBareURLs(AttributedString("看 https://example.com/a?b=1 吧"))
        let links = linked.runs.compactMap(\.link)
        #expect(links == [URL(string: "https://example.com/a?b=1")!])
    }

    @Test func arithmeticAndDottedWordsAreNotLinks() {
        let linked = AnswerLinks.linkingBareURLs(AttributedString("5*3 等于 15，a.b 是字段名，example.com 不带协议"))
        #expect(linked.runs.allSatisfy { $0.link == nil })
    }

    @Test func existingMarkdownLinksAreKept() throws {
        let source = try AttributedString(markdown: "[官网](https://apple.com)")
        let linked = AnswerLinks.linkingBareURLs(source)
        #expect(linked.runs.compactMap(\.link) == [URL(string: "https://apple.com")!])
    }
    #endif
}
