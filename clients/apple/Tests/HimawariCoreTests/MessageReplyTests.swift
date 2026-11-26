import Testing
@testable import HimawariCore

struct MessageReplyTests {
    @Test func aReplyCarriesTheIdOfTheMessageItAnswers() {
        let raw = MessageReply.compose(replyingTo: "message-01HZ", text: "要带伞吗？")
        #expect(raw == "<reply to=\"message-01HZ\"/>\n要带伞吗？")
        #expect(MessageReply.split(raw).replyTo == "message-01HZ")
        #expect(MessageReply.split(raw).text == "要带伞吗？")
    }

    @Test func aPlainMessageIsNotAReply() {
        #expect(MessageReply.compose(replyingTo: nil, text: "你好") == "你好")
        #expect(MessageReply.split("你好").replyTo == nil)
        #expect(MessageReply.split("<reply to=\"a b\"/>\n你好").replyTo == nil)
        #expect(MessageReply.split("说 <reply to=\"m1\"/> 这个").text == "说 <reply to=\"m1\"/> 这个")
    }

    @Test func theTagNeverShowsWhereTheMessageIsShownOrCopied() {
        let raw = MessageReply.compose(replyingTo: "m1", text: "看这个\n\n<file name=\"a.pdf\" ref=\"r\" bytes=\"3\" kind=\"pdf\"/>")
        #expect(MessageAttachments.shown(raw).text == "看这个")
        #expect(MessageCopy.text(MessageReply.compose(replyingTo: "m1", text: "要带伞吗？"), fromAgent: false) == "要带伞吗？")
        #expect(MessageAttachments.preview(MessageReply.compose(replyingTo: "m1", text: "要带伞吗？")) == "要带伞吗？")
    }

    @Test func theQuoteIsOnePlainLine() {
        #expect(MessageReply.quoteLine("## 明天\n**大阪**晴，见[天气](https://example.com)") == "明天 大阪晴，见天气")
        #expect(MessageReply.quoteLine("<file name=\"a.pdf\" ref=\"r\" bytes=\"3\" kind=\"pdf\"/>") == "a.pdf")
    }
}
