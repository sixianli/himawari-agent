import Foundation
@testable import HimawariCore
import Testing

@Suite struct ChatAttachmentTests {
    private func config(image: Int = 1000, perMessage: Int = 3, message: Int = 65536, attachments: Bool = true) -> String {
        let limits = attachments ? #","attachments":{"textCharacters":10,"imageCharacters":\#(image),"perMessage":\#(perMessage),"messageCharacters":\#(message)}"# : ""
        return #"{"heartbeatSeconds":25,"connectionMaxSeconds":3600,"signatureToleranceSeconds":300,"limits":[],"streamConnections":2\#(limits)}"#
    }

    private func ok(_ text: String, status: Int = 200) -> HTTPExchangeResponse {
        HTTPExchangeResponse(status: status, body: Data(text.utf8))
    }

    private func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    struct Shrinker: ImageFitting {
        func fit(_ data: Data, maxBytes: Int) -> (data: Data, mimeType: String)? {
            (Data(repeating: 7, count: min(3, maxBytes)), "image/jpeg")
        }
    }

    @Test func aPhotoAndALocationAreUploadedAndJoinedUnderTheText() async throws {
        let exchange = RecordingExchange([
            ok(config()),
            ok(#"{"ref":"payload:img"}"#, status: 201),
            ok(#"{"ref":"payload:loc"}"#, status: 201),
        ])
        let composed = try await api(exchange).compose(
            text: "这是哪",
            attachments: [
                ChatAttachment(name: "照片", content: .image(data: Data([1, 2, 3]), mimeType: "image/png")),
                ChatAttachment(name: "我现在的位置", content: .text("大阪市北区梅田一丁目", kind: .text)),
            ],
            requestId: "REQ",
            images: nil
        )
        #expect(composed == "这是哪\n\n<file name=\"照片\" ref=\"payload:img\" bytes=\"26\" kind=\"image\"/>\n\n<file name=\"我现在的位置\" ref=\"payload:loc\" bytes=\"30\" kind=\"text\"/>")
        let first = try JSONSerialization.jsonObject(with: try #require(exchange.requests[1].httpBody)) as? [String: Any]
        #expect(first?["as"] as? String == "image")
        #expect(first?["content"] as? String == "data:image/png;base64,AQID")
        #expect(first?["requestId"] as? String == "REQ-0")
        let second = try JSONSerialization.jsonObject(with: try #require(exchange.requests[2].httpBody)) as? [String: Any]
        #expect(second?["requestId"] as? String == "REQ-1")
        #expect(second?["content"] as? String == "大阪市北区梅田一丁目")
    }

    @Test func aBigPhotoIsShrunkToTheServerBudgetOrRefused() async throws {
        let big = ChatAttachment(name: "照片", content: .image(data: Data(repeating: 1, count: 200), mimeType: "image/heic"))
        let shrunk = RecordingExchange([ok(config(image: 40)), ok(#"{"ref":"payload:img"}"#, status: 201)])
        let composed = try await api(shrunk).compose(text: "", attachments: [big], requestId: "R", images: Shrinker())
        #expect(composed.hasPrefix("<file name=\"照片\" ref=\"payload:img\""))
        let body = try JSONSerialization.jsonObject(with: try #require(shrunk.requests[1].httpBody)) as? [String: Any]
        #expect((body?["content"] as? String)?.hasPrefix("data:image/jpeg;base64,") == true)
        let refused = RecordingExchange([ok(config(image: 40))])
        await #expect(throws: ChatAttachmentProblem.tooLarge) {
            try await api(refused).compose(text: "", attachments: [big], requestId: "R", images: nil)
        }
        #expect(refused.requests.count == 1)
    }

    @Test func tooManyOrAnOldServerStopBeforeAnythingIsUploaded() async throws {
        let piece = ChatAttachment(name: "a", content: .text("x", kind: .text))
        let many = RecordingExchange([ok(config(perMessage: 1))])
        await #expect(throws: ChatAttachmentProblem.tooMany(limit: 1)) {
            try await api(many).compose(text: "", attachments: [piece, piece], requestId: "R", images: nil)
        }
        #expect(many.requests.count == 1)
        let old = RecordingExchange([ok(config(attachments: false))])
        await #expect(throws: ChatAttachmentProblem.serverOutdated) {
            try await api(old).compose(text: "", attachments: [piece], requestId: "R", images: nil)
        }
    }

    @Test func withoutAttachmentsNothingIsAskedOfTheServer() async throws {
        let exchange = RecordingExchange([])
        #expect(try await api(exchange).compose(text: "你好", attachments: [], requestId: "R", images: nil) == "你好")
        #expect(exchange.requests.isEmpty)
    }

    @Test func theBubbleShowsTheTextAndTheAttachmentNamesButNotTheTags() {
        let text = "这是哪\n\n<file name=\"照片\" ref=\"payload:img\" bytes=\"26\" kind=\"image\"/>\n\n<file name=\"我现在的位置\" ref=\"payload:loc\" bytes=\"30\" kind=\"text\" truncated=\"1\"/>"
        let shown = MessageAttachments.shown(text)
        #expect(shown.text == "这是哪")
        #expect(shown.attachments == [ShownAttachment(name: "照片", kind: .image), ShownAttachment(name: "我现在的位置", kind: .text)])
        #expect(MessageAttachments.shown("写 <file 标签 /> 的教程").attachments.isEmpty)
        #expect(MessageAttachments.shown("写 <file 标签 /> 的教程").text == "写 <file 标签 /> 的教程")
    }
}
