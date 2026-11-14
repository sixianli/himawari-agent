import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct HandoverTests {
    private let moment = Date(timeIntervalSince1970: 1_800_000_000)

    private func configuration(attachments: AttachmentLimits? = AttachmentLimits(textCharacters: 40, imageCharacters: 80, perMessage: 10, messageCharacters: 65536), textLimit: Int? = 12) -> DeviceConfiguration {
        let types: [String: PerceptionTypeRule] = [
            "web.page": PerceptionTypeRule(sense: "reading", text: "optional", evidence: [
                "url": PerceptionFieldRule(kind: "string", maximum: 30, optional: nil),
                "title": PerceptionFieldRule(kind: "string", maximum: 5, optional: true),
            ]),
            "share.item": PerceptionTypeRule(sense: "vision", text: "optional", evidence: [
                "url": PerceptionFieldRule(kind: "string", maximum: 30, optional: true),
                "title": PerceptionFieldRule(kind: "string", maximum: 5, optional: true),
                "sourceApp": PerceptionFieldRule(kind: "string", maximum: 4, optional: true),
            ]),
        ]
        return DeviceConfiguration(
            heartbeatSeconds: 25,
            connectionMaxSeconds: 3600,
            signatureToleranceSeconds: 300,
            limits: [],
            streamConnections: 2,
            attachments: attachments,
            perception: PerceptionSummary(recordTextCharacters: textLimit, recordTypes: types)
        )
    }

    private func handover(_ content: HandoverContent, request: String? = nil, entry: HandoverEntry = .safari, sourceApp: String? = nil) -> Handover {
        Handover(id: "AAAAAAAAAAAAAAAAAAAAAAAA", entry: entry, content: content, request: request, sourceApp: sourceApp, createdAt: moment, answerLocale: .japanese)
    }

    @Test func aHandedPageJoinsTheRequestInTheWebAttachmentFormat() {
        let tag = MessageAttachment(name: "a\"b<c>\nd", ref: "payload:1", bytes: 12, kind: .text, truncated: true)
        #expect(MessageAttachments.compose(text: "帮我挑", attachments: [tag]) == "帮我挑\n\n<file name=\"abcd\" ref=\"payload:1\" bytes=\"12\" kind=\"text\" truncated=\"1\"/>")
        #expect(MessageAttachments.compose(text: "", attachments: [tag]) == tag.tag)
        #expect(MessageAttachment(name: "  ", ref: "r", bytes: 1, kind: .image, truncated: false).name == "file")
    }

    @Test func truncationCountsUTF16LikeTheServerAndNeverSplitsACharacter() {
        let (kept, truncated) = MessageAttachments.clip("ab😀c", characters: 3)
        #expect(kept == "ab")
        #expect(truncated)
        #expect(MessageAttachments.clip("ab😀c", characters: 5) == ("ab😀c", false))
        #expect(TextBudget.scalarPrefix("日本語です", limit: 3) == "日本語")
    }

    @Test func aRequestTurnsThePageIntoOneTextAttachmentCutAtTheServerLimit() throws {
        let item = handover(.page(url: "https://tabelog.com/a", title: "十选", text: String(repeating: "店", count: 100)), request: "挑一家")
        let plan = try HandoverPlanner.plan(item, configuration: configuration())
        guard case let .conversation(attachment, kind, name, truncated) = plan else { Issue.record("not a conversation"); return }
        #expect(kind == .text)
        #expect(name == "十选")
        #expect(truncated)
        #expect(attachment.utf16.count == 40)
        #expect(attachment.hasPrefix("十选\nhttps://tabelog.com/a\n\n店"))
    }

    @Test func withoutARequestThePageBecomesAWebPageRecordWithServerFieldLimits() throws {
        let item = handover(.page(url: "https://tabelog.com/a", title: "新大阪站周边午餐", text: String(repeating: "x", count: 20)))
        guard case let .record(record) = try HandoverPlanner.plan(item, configuration: configuration()) else { Issue.record("not a record"); return }
        #expect(record.type == "web.page")
        #expect(record.id == "perception:AAAAAAAAAAAAAAAAAAAAAAAA")
        #expect(record.captureSource == "safari_extension")
        #expect(record.evidence == ["url": .string("https://tabelog.com/a"), "title": .string("新大阪站周")])
        #expect(record.text?.count == 12)
        #expect(record.occurredAt == "2027-01-15T08:00:00.000Z")
    }

    @Test func sharedTextBecomesAShareItemNamedBySourceApp() throws {
        let item = handover(.text("一段话"), entry: .share, sourceApp: "Notes App")
        guard case let .record(record) = try HandoverPlanner.plan(item, configuration: configuration()) else { Issue.record("not a record"); return }
        #expect(record.type == "share.item")
        #expect(record.captureSource == "share_extension")
        #expect(record.evidence == ["sourceApp": .string("Note")])
        #expect(record.text == "一段话")
    }

    @Test func aUrlLongerThanTheServerAllowsIsRefusedInsteadOfCut() {
        let item = handover(.page(url: "https://example.com/" + String(repeating: "a", count: 40), title: nil, text: nil))
        #expect(throws: HandoverPlanError.self) { try HandoverPlanner.plan(item, configuration: configuration()) }
    }

    @Test func anOldServerWithoutLimitsIsReportedNotGuessed() {
        let asked = handover(.text("x"), request: "看看")
        #expect(throws: HandoverPlanError.self) { try HandoverPlanner.plan(asked, configuration: configuration(attachments: nil)) }
    }

    @Test func anImageTooBigForADataURLIsRefused() {
        let item = handover(.image(data: Data(repeating: 1, count: 100), mimeType: "image/png", name: nil), request: "这是什么")
        #expect(throws: HandoverPlanError.self) { try HandoverPlanner.plan(item, configuration: configuration()) }
    }

    @Test func anImageWithoutARequestGoesToTheMediaUpload() throws {
        let item = handover(.image(data: Data([1, 2]), mimeType: "image/jpeg", name: nil), entry: .share)
        #expect(try HandoverPlanner.plan(item, configuration: configuration()) == .media(kind: "image", contentType: "image/jpeg"))
    }

    private func configJSON() -> String {
        """
        {"heartbeatSeconds":25,"connectionMaxSeconds":3600,"signatureToleranceSeconds":300,"limits":[],"streamConnections":2,
         "attachments":{"textCharacters":1000,"imageCharacters":1000,"perMessage":10,"messageCharacters":65536},
         "perception":{"recordTextCharacters":1000,"recordTypes":{"share.item":{"sense":"vision","text":"optional","evidence":{"url":{"kind":"string","maximum":2048,"optional":true}}}}}}
        """
    }

    private func courier(_ exchange: RecordingExchange) throws -> HandoverCourier {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return HandoverCourier(api: DeviceAPI(http: http))
    }

    private func ok(_ text: String) -> HTTPExchangeResponse {
        HTTPExchangeResponse(status: 200, body: Data(text.utf8))
    }

    @Test func aRequestStoresTheAttachmentOpensAThreadAndSendsTheJoinedDraft() async throws {
        let exchange = RecordingExchange([
            ok(configJSON()),
            HTTPExchangeResponse(status: 201, body: Data(#"{"ref":"payload:abc"}"#.utf8)),
            ok(#"{"type":"thread.command_result","payload":{"threadId":"thread-device-1","threadRevision":1,"replayed":false}}"#),
            ok(#"{"type":"thread.command_result","payload":{"threadRevision":2,"replayed":false}}"#),
        ])
        let item = handover(.link(url: "https://a.example/x", title: "店"), request: "挑一家")
        let outcome = await (try courier(exchange)).deliver(item)
        #expect(outcome == .delivered(answered: true))
        let paths = exchange.requests.map { $0.url?.path ?? "" }
        #expect(paths == ["/api/device/v1/config", "/api/device/v1/attachments", "/api/device/v1/threads", "/api/device/v1/messages"])
        let stored = try JSONSerialization.jsonObject(with: try #require(exchange.requests[1].httpBody)) as? [String: Any]
        #expect(stored?["requestId"] as? String == "AAAAAAAAAAAAAAAAAAAAAAAA-attachment")
        #expect(stored?["as"] as? String == "text")
        #expect(stored?["content"] as? String == "店\nhttps://a.example/x")
        let sent = try JSONSerialization.jsonObject(with: try #require(exchange.requests[3].httpBody)) as? [String: Any]
        #expect(sent?["text"] as? String == "挑一家\n\n<file name=\"店\" ref=\"payload:abc\" bytes=\"23\" kind=\"text\"/>")
        #expect(sent?["threadId"] as? String == "thread-device-1")
        #expect(sent?["messageId"] as? String == "AAAAAAAAAAAAAAAAAAAAAAAA-message")
    }

    @Test func outcomesFollowTheServerAnswer() async throws {
        let stored = RecordingExchange([ok(configJSON()), ok(#"{"outcomes":[{"id":"perception:AAAAAAAAAAAAAAAAAAAAAAAA","outcome":"stored"}],"reached":[]}"#)])
        let storedOutcome = await (try courier(stored)).deliver(handover(.text("x"), entry: .share))
        #expect(storedOutcome == .delivered(answered: false))
        let off = RecordingExchange([ok(configJSON()), ok(#"{"outcomes":[{"id":"perception:AAAAAAAAAAAAAAAAAAAAAAAA","outcome":"sense_off"}],"reached":[]}"#)])
        let offOutcome = await (try courier(off)).deliver(handover(.text("x"), entry: .share))
        #expect(offOutcome == .entryOff(.share))
        let revoked = RecordingExchange([HTTPExchangeResponse(status: 401, body: Data(#"{"error":{"code":"DEVICE_REVOKED"}}"#.utf8))])
        let revokedOutcome = await (try courier(revoked)).deliver(handover(.text("x")))
        #expect(revokedOutcome == .deviceRemoved)
        let down = RecordingExchange([HTTPExchangeResponse(status: 503, body: Data())])
        let downOutcome = await (try courier(down)).deliver(handover(.text("x")))
        #expect(downOutcome == .queued)
        let refused = RecordingExchange([HTTPExchangeResponse(status: 400, body: Data(#"{"error":{"code":"DEVICE_REQUEST_INVALID"}}"#.utf8))])
        let refusedOutcome = await (try courier(refused)).deliver(handover(.text("x")))
        #expect(refusedOutcome == .failed(.rejected))
    }

    @Test func aBigImageWithoutARequestOnAServerWithoutUploadsIsReportedAsOutdated() async throws {
        let exchange = RecordingExchange([ok(configJSON()), HTTPExchangeResponse(status: 404, body: Data())])
        let item = handover(.image(data: Data([1, 2, 3]), mimeType: "image/png", name: nil), entry: .share)
        let outcome = await (try courier(exchange)).deliver(item)
        #expect(outcome == .failed(.serverOutdated))
    }

    @Test func aRequestLongerThanAMessageIsRefusedBeforeAThreadIsOpened() async throws {
        let limited = #"{"heartbeatSeconds":25,"connectionMaxSeconds":3600,"signatureToleranceSeconds":300,"limits":[],"streamConnections":2,"attachments":{"textCharacters":1000,"imageCharacters":1000,"perMessage":10,"messageCharacters":50}}"#
        let exchange = RecordingExchange([ok(limited), HTTPExchangeResponse(status: 201, body: Data(#"{"ref":"payload:abc"}"#.utf8))])
        let item = handover(.text("短"), request: String(repeating: "问", count: 80))
        let outcome = await (try courier(exchange)).deliver(item)
        #expect(outcome == .failed(.tooLarge))
        #expect(exchange.requests.map { $0.url?.path ?? "" } == ["/api/device/v1/config", "/api/device/v1/attachments"])
    }

    @Test func theQueueSurvivesTwoWritersThatNeverSawEachOthersIndex() throws {
        let store = MemoryLocalStore()
        let extensionSide = HandoverQueue(store: store)
        let appSide = HandoverQueue(store: store)
        let first = Handover(id: "BBBBBBBBBBBBBBBBBBBBBBBB", entry: .share, content: .text("a"), request: nil, sourceApp: nil, createdAt: moment, answerLocale: .chinese)
        let second = Handover(id: "CCCCCCCCCCCCCCCCCCCCCCCC", entry: .share, content: .text("b"), request: nil, sourceApp: nil, createdAt: moment.addingTimeInterval(1), answerLocale: .chinese)
        try extensionSide.add(first)
        try appSide.remove(first.id)
        try extensionSide.add(second)
        #expect(appSide.pending().map(\.id) == [second.id])
        try HandoverSettings().save(to: store)
        #expect(appSide.pending().map(\.id) == [second.id])
    }

    @Test func theQueueKeepsWhatCouldNotBeSentAndDropsWhatWasDelivered() async throws {
        let queue = HandoverQueue(store: MemoryLocalStore())
        let first = Handover(id: "BBBBBBBBBBBBBBBBBBBBBBBB", entry: .share, content: .text("a"), request: nil, sourceApp: nil, createdAt: moment, answerLocale: .chinese)
        let second = Handover(id: "CCCCCCCCCCCCCCCCCCCCCCCC", entry: .share, content: .text("b"), request: nil, sourceApp: nil, createdAt: moment, answerLocale: .chinese)
        try queue.add(first)
        try queue.add(second)
        try queue.add(first)
        #expect(queue.pending().map(\.id) == [first.id, second.id])
        let exchange = RecordingExchange([
            ok(configJSON()), ok(#"{"outcomes":[{"id":"perception:BBBBBBBBBBBBBBBBBBBBBBBB","outcome":"stored"}],"reached":[]}"#),
            HTTPExchangeResponse(status: 502, body: Data()),
        ])
        let sender = try courier(exchange)
        let results = await queue.drain(using: sender)
        #expect(results[first.id] == .delivered(answered: false))
        #expect(results[second.id] == .queued)
        #expect(queue.pending().map(\.id) == [second.id])
    }

    @Test func theQueueKeepsWhatAnOutdatedServerCouldNotTakeYet() async throws {
        let queue = HandoverQueue(store: MemoryLocalStore())
        let item = Handover(id: "BBBBBBBBBBBBBBBBBBBBBBBB", entry: .share, content: .text("a"), request: "问", sourceApp: nil, createdAt: moment, answerLocale: .chinese)
        try queue.add(item)
        let old = #"{"heartbeatSeconds":25,"connectionMaxSeconds":3600,"signatureToleranceSeconds":300,"limits":[],"streamConnections":2}"#
        let results = await queue.drain(using: try courier(RecordingExchange([ok(old)])))
        #expect(results[item.id] == .failed(.serverOutdated))
        #expect(queue.pending().map(\.id) == [item.id])
    }

    @Test func manyWritersThatNeverSawEachOthersWorkAllKeepTheirItems() async throws {
        let store = MemoryLocalStore()
        let queues = [HandoverQueue(store: store), HandoverQueue(store: store)]
        let ids = (0..<60).map { String(format: "%024d", $0) }
        await withTaskGroup(of: Void.self) { group in
            for (offset, id) in ids.enumerated() {
                group.addTask {
                    let item = Handover(id: id, entry: .share, content: .text("a"), request: nil, sourceApp: nil, createdAt: moment.addingTimeInterval(Double(offset)), answerLocale: .chinese)
                    try? queues[offset % 2].add(item)
                }
            }
        }
        #expect(queues[0].pending().map(\.id) == ids)
    }

    @Test func theDeskRefusesASwitchedOffEntryAndQueuesWhenTheServerIsUnreachable() async throws {
        let store = MemoryLocalStore()
        var settings = HandoverSettings()
        settings.set(.share, on: false)
        try settings.save(to: store)
        let idle = RecordingExchange([])
        let off = HandoverDesk(store: store, courier: try courier(idle), now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let refused = await off.hand(handover(.text("x"), entry: .share))
        #expect(refused == .entryOff(.share))
        #expect(idle.requests.isEmpty)

        #expect(HandoverSettings.load(from: store).state(.safari) == .notSetUp)
        let down = RecordingExchange([HTTPExchangeResponse(status: 503, body: Data())])
        let desk = HandoverDesk(store: store, courier: try courier(down), now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let queued = await desk.hand(handover(.page(url: "https://a.example", title: nil, text: nil)))
        #expect(queued == .queued)
        #expect(desk.queue.pending().map(\.id) == ["AAAAAAAAAAAAAAAAAAAAAAAA"])
        #expect(HandoverSettings.load(from: store).state(.safari) == .on)
        #expect(HandoverSettings.load(from: store).state(.share) == .off)
    }

    struct HalvingFitter: ImageFitting {
        func fit(_ data: Data, maxBytes: Int) -> (data: Data, mimeType: String)? {
            (Data(data.prefix(maxBytes)), "image/jpeg")
        }
    }

    @Test func aLargeImageIsShrunkToWhatTheServerAcceptsBeforePlanning() throws {
        let item = handover(.image(data: Data(repeating: 7, count: 500), mimeType: "image/png", name: "截图"), request: "这是什么")
        let config = configuration(attachments: AttachmentLimits(textCharacters: 40, imageCharacters: 123, perMessage: 10, messageCharacters: 65536))
        let http = DeviceHTTPClient(exchange: RecordingExchange([]))
        let fitted = HandoverCourier(api: DeviceAPI(http: http), images: HalvingFitter()).fitted(item, configuration: config)
        guard case let .image(data, mimeType, name) = fitted.content else { Issue.record("not an image"); return }
        #expect(mimeType == "image/jpeg")
        #expect(name == "截图")
        #expect(data.count == (123 - "data:image/jpeg;base64,".count) / 4 * 3)
        guard case let .conversation(url, kind, _, _) = try HandoverPlanner.plan(fitted, configuration: config) else { Issue.record("no plan"); return }
        #expect(kind == .image)
        #expect(url.utf16.count <= 123)
    }

    @Test func whatTheSafariPanelReadsBecomesAPageOnlyForWebAddresses() {
        #expect(HandoverContent.page(from: ["url": "https://tabelog.com/a", "title": "午餐 10 选", "text": "正文"]) == .page(url: "https://tabelog.com/a", title: "午餐 10 选", text: "正文"))
        #expect(HandoverContent.page(from: ["url": "http://a.example", "title": "", "text": ""]) == .page(url: "http://a.example", title: nil, text: nil))
        #expect(HandoverContent.page(from: ["url": "about:blank", "title": "x"]) == nil)
        #expect(HandoverContent.page(from: ["url": "file:///etc/passwd"]) == nil)
        #expect(HandoverContent.page(from: ["title": "没有地址"]) == nil)
        #expect(HandoverContent.page(from: ["url": 42]) == nil)
    }

    @Test func theCardSaysFullTextOnlyWhenThePageTextWasReadAndStillGoesToHimawari() {
        let words = "这一页的全文"
        let read = HandoverContent.page(url: "https://tabelog.com/a", title: "午餐 10 选", text: "从车站走路 5 分钟")
        #expect(read.pageSubtitle(fullText: words, outcome: nil, paired: true) == "tabelog.com · 这一页的全文")
        #expect(read.pageSubtitle(fullText: words, outcome: .delivered(answered: true), paired: true) == "tabelog.com · 这一页的全文")
        #expect(read.pageSubtitle(fullText: words, outcome: .queued, paired: true) == "tabelog.com · 这一页的全文")
        let onlyAddress = HandoverContent.page(url: "https://tabelog.com/a", title: "午餐 10 选", text: nil)
        let emptyText = HandoverContent.page(url: "https://tabelog.com/a", title: nil, text: "")
        for subtitle in [
            onlyAddress.pageSubtitle(fullText: words, outcome: nil, paired: true),
            emptyText.pageSubtitle(fullText: words, outcome: nil, paired: true),
            read.pageSubtitle(fullText: words, outcome: .entryOff(.share), paired: true),
            read.pageSubtitle(fullText: words, outcome: .deviceRemoved, paired: true),
            read.pageSubtitle(fullText: words, outcome: nil, paired: false),
        ] {
            #expect(subtitle == "tabelog.com")
            #expect(subtitle?.contains(words) == false)
        }
        #expect(read.pageSubtitle(fullText: words, outcome: .failed(.serverOutdated), paired: true) == "tabelog.com")
        #expect(HandoverContent.link(url: "https://tabelog.com/a", title: nil).pageSubtitle(fullText: words, outcome: nil, paired: true) == nil)
    }
}
