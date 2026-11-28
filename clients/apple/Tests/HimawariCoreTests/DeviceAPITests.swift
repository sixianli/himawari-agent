import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct DeviceAPITests {
    private func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data = try #require(request.httpBody)
        let object = try JSONSerialization.jsonObject(with: data)
        return try #require(object as? [String: Any])
    }

    @Test func createThreadSendsOnlyRequestIdAndLocaleAndReadsTheServerThreadId() async throws {
        let response = """
        {"type":"thread.command_result","payload":{"commandType":"thread.create","commandId":"c1","threadId":"thread-device-0123456789abcdef0123456789abcdef","threadRevision":1,"resultRef":"r","replayed":false,"committedAt":"2026-11-12T00:00:00Z"}}
        """
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(response.utf8))])
        let created = try await api(exchange).createThread(requestId: "req_AAAAAAAAAAAAAAAA", answerLocale: .japanese)
        #expect(created == CreatedThread(threadId: "thread-device-0123456789abcdef0123456789abcdef", threadRevision: 1))
        let request = try #require(exchange.requests.first)
        let sent = try body(request)
        #expect(Set(sent.keys) == ["requestId", "answerLocale"])
        #expect(sent["answerLocale"] as? String == "ja")
    }

    @Test func createThreadRejectsAResultWithoutThreadId() async throws {
        let response = """
        {"type":"thread.command_result","payload":{"threadRevision":1,"replayed":false}}
        """
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(response.utf8))])
        await #expect(throws: DeviceAPIError.self) {
            _ = try await api(exchange).createThread(requestId: "req_AAAAAAAAAAAAAAAA", answerLocale: .chinese)
        }
    }

    @Test func textsSplitIntoBatchesOfAtMostOneHundredUniqueRefsAndSkipMissingOnes() async throws {
        let refs = (0..<150).map { "ref\($0)" } + ["ref0"]
        func reply(_ range: Range<Int>) -> HTTPExchangeResponse {
            var items: [String: Any] = [:]
            for index in range {
                items["ref\(index)"] = index == 3 ? NSNull() : ["text": "t\(index)", "contentType": "text/plain", "dataClassification": "personal"]
            }
            return HTTPExchangeResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: ["items": items]))
        }
        let exchange = RecordingExchange([reply(0..<100), reply(100..<150)])
        let texts = try await api(exchange).texts(for: refs)
        #expect(exchange.requests.count == 2)
        let firstBody = try body(exchange.requests[0])
        let secondBody = try body(exchange.requests[1])
        let first = try #require(firstBody["refs"] as? [String])
        let second = try #require(secondBody["refs"] as? [String])
        #expect(first.count == 100)
        #expect(second.count == 50)
        #expect(Set(first).count == 100)
        #expect(texts.count == 149)
        #expect(texts["ref3"] == nil)
        #expect(texts["ref149"] == "t149")
    }

    @Test func textsSendDeferredRefsAgainAheadOfTheRestInOrder() async throws {
        let refs = (0..<101).map { "ref\($0)" }
        func reply(_ indexes: [Int], deferred: [Int]) -> HTTPExchangeResponse {
            var items: [String: Any] = [:]
            for index in indexes { items["ref\(index)"] = ["text": "t\(index)", "contentType": "text/plain", "dataClassification": "personal"] }
            let object: [String: Any] = ["items": items, "deferred": deferred.map { "ref\($0)" }]
            return HTTPExchangeResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: object))
        }
        let exchange = RecordingExchange([
            reply(Array(0..<40), deferred: Array(40..<100)),
            reply(Array(40..<101), deferred: []),
        ])
        let texts = try await api(exchange).texts(for: refs)
        #expect(texts.count == 101)
        #expect(exchange.requests.count == 2)
        let firstBody = try body(exchange.requests[0])
        let secondBody = try body(exchange.requests[1])
        #expect((firstBody["refs"] as? [String])?.count == 100)
        #expect(secondBody["refs"] as? [String] == (40..<101).map { "ref\($0)" })
    }

    @Test func textsKeepWhatArrivedWhenTheServerDefersEveryRemainingRef() async throws {
        let first: [String: Any] = ["items": ["a": ["text": "A"]], "deferred": ["b", "c"]]
        let second: [String: Any] = ["items": [String: Any](), "deferred": ["b", "c"]]
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: first)),
            HTTPExchangeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: second)),
        ])
        let texts = try await api(exchange).texts(for: ["a", "b", "c"])
        #expect(texts == ["a": "A"])
        #expect(exchange.requests.count == 2)
    }

    @Test func expiredPairingCodeCarriesTheServerTtl() throws {
        let body = Data(#"{"error":{"code":"DEVICE_PAIRING_CODE_EXPIRED","pairingCodeTtlSeconds":600}}"#.utf8)
        #expect(throws: DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED", pairingCodeTtlSeconds: 600)) {
            _ = try DeviceHTTPClient.check(HTTPExchangeResponse(status: 410, body: body))
        }
    }

    private func detailPage(_ sequences: [Int], next: Int?, watermark: Int) -> HTTPExchangeResponse {
        let messages = sequences.map { sequence -> [String: Any] in
            ["messageId": "m\(sequence)", "sequence": sequence, "role": "owner", "contentRef": "c\(sequence)", "status": "committed", "committedAt": "2026-11-12T00:00:00Z"]
        }
        let thread: [String: Any] = ["threadId": "thread-a", "revision": watermark, "status": "active", "answerLocale": "zh-CN", "messageWatermark": watermark, "createdAt": "2026-11-12T00:00:00Z", "updatedAt": "2026-11-12T00:00:00Z"]
        var payload: [String: Any] = ["thread": thread, "messages": messages, "runs": [Any]()]
        payload["nextSequence"] = next ?? NSNull()
        return HTTPExchangeResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: ["type": "thread.detail_snapshot", "payload": payload]))
    }

    @Test func fullThreadFollowsNextSequenceUntilTheEnd() async throws {
        let exchange = RecordingExchange([detailPage([1, 2], next: 2, watermark: 5), detailPage([3, 4], next: 4, watermark: 5), detailPage([5], next: nil, watermark: 5)])
        let detail = try await api(exchange).fullThread("thread-a")
        #expect(detail.messages.map(\.sequence) == [1, 2, 3, 4, 5])
        #expect(detail.nextSequence == nil)
        let afters = exchange.requests.compactMap { $0.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.first { $0.name == "after" }?.value }
        #expect(afters == ["0", "2", "4"])
    }

    @Test func fullThreadStopsWhenNextSequenceDoesNotMoveForward() async throws {
        let exchange = RecordingExchange([detailPage([1, 2], next: 2, watermark: 9), detailPage([1, 2], next: 2, watermark: 9)])
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await api(exchange).fullThread("thread-a")
        }
    }

    @Test func fullThreadRejectsAnEmptyPageThatStillPointsFurther() async throws {
        let exchange = RecordingExchange([detailPage([1, 2], next: 2, watermark: 9), detailPage([], next: 3, watermark: 9)])
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await api(exchange).fullThread("thread-a")
        }
        #expect(exchange.requests.count == 2)
    }

    @Test func fullThreadGivesUpAfterThePageLimit() async throws {
        let pages = (1...DeviceAPI.pageLimit).map { detailPage([$0], next: $0, watermark: 999) }
        let exchange = RecordingExchange(pages)
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await api(exchange).fullThread("thread-a")
        }
        #expect(exchange.requests.count == DeviceAPI.pageLimit)
    }

    private func executionPage(_ sequences: [Int], next: Int?) -> HTTPExchangeResponse {
        let records = sequences.map { sequence -> [String: Any] in
            ["id": "r\(sequence)", "sequence": sequence, "itemId": "i\(sequence)", "kind": "tool", "phase": "completed", "name": "search", "text": "", "occurredAt": "2026-11-12T00:00:00Z"]
        }
        var payload: [String: Any] = ["records": records]
        payload["nextSequence"] = next ?? NSNull()
        return HTTPExchangeResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: ["type": "run.execution_snapshot", "payload": payload]))
    }

    private func afters(_ exchange: RecordingExchange) -> [String] {
        exchange.requests.compactMap { $0.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.first { $0.name == "after" }?.value }
    }

    @Test func executionRecordsFollowNextSequenceFromWhatIsAlreadyKnown() async throws {
        let known = ExecutionRecord(id: "r1", sequence: 1, itemId: "i1", kind: .tool, phase: .completed, name: "search", occurredAt: Date(timeIntervalSince1970: 0))
        let exchange = RecordingExchange([executionPage([2, 3], next: 3), executionPage([4], next: nil)])
        let records = try await api(exchange).executionRecords(threadId: "thread-a", runId: "run-a", known: [known])
        #expect(records.map(\.sequence) == [1, 2, 3, 4])
        #expect(afters(exchange) == ["1", "3"])
    }

    @Test func theOldConversationsARunUsedComeFromItsRecallRecordAndNothingElse() async throws {
        let lines = [
            #"{"day":"2026-11-18","conversationId":"thread-books","sequence":1,"preview":"推荐一本好看的科幻小说"}"#,
            "not json",
            #"{"day":"2026-11-20","conversationId":"thread-trip","sequence":4,"preview":"下周去京都"}"#,
        ].joined(separator: "\n")
        let records: [[String: Any]] = [
            ["id": "r1", "sequence": 1, "itemId": "c1", "kind": "status", "phase": "completed", "name": "memory.selection", "text": "2", "output": "记忆一", "occurredAt": "2026-11-12T00:00:00Z"],
            ["id": "r2", "sequence": 2, "itemId": "c2", "kind": "status", "phase": "completed", "name": "conversation.recall", "text": "2", "output": lines, "occurredAt": "2026-11-12T00:00:00Z"],
            ["id": "r3", "sequence": 3, "itemId": "c3", "kind": "tool", "phase": "completed", "name": "search", "text": "", "occurredAt": "2026-11-12T00:00:00Z"],
        ]
        let body = try JSONSerialization.data(withJSONObject: ["type": "run.execution_snapshot", "payload": ["records": records, "nextSequence": NSNull()]])
        let decoded = try await api(RecordingExchange([HTTPExchangeResponse(status: 200, body: body)])).executionRecords(threadId: "thread-a", runId: "run-a", known: [])
        #expect(RecalledConversation.used(in: decoded) == [
            RecalledConversation(day: "2026-11-18", conversationId: "thread-books", sequence: 1, preview: "推荐一本好看的科幻小说"),
            RecalledConversation(day: "2026-11-20", conversationId: "thread-trip", sequence: 4, preview: "下周去京都"),
        ])
        #expect(ProcessLine.steps(from: decoded).map(\.id) == ["c3"])
        let withoutRecall = Array(decoded.filter { $0.name != "conversation.recall" })
        #expect(RecalledConversation.used(in: withoutRecall).isEmpty)
        let older = ExecutionRecord(id: "r1", sequence: 1, itemId: "i1", kind: .tool, phase: .completed, name: "search", occurredAt: Date(timeIntervalSince1970: 0))
        #expect(RecalledConversation.used(in: [older]).isEmpty)
    }

    @Test func executionRecordsRejectAPageThatDoesNotMoveForward() async throws {
        let exchange = RecordingExchange([executionPage([1, 2], next: 2), executionPage([1, 2], next: 2)])
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await api(exchange).executionRecords(threadId: "thread-a", runId: "run-a", known: [])
        }
        #expect(exchange.requests.count == 2)
    }

    @Test func executionRecordsKeepPagingPastAPageWhoseEventsWereAllFilteredOut() async throws {
        let exchange = RecordingExchange([executionPage([], next: 5), executionPage([6], next: nil)])
        let records = try await api(exchange).executionRecords(threadId: "thread-a", runId: "run-a", known: [])
        #expect(records.map(\.sequence) == [6])
        #expect(afters(exchange) == ["0", "5"])
    }

    @Test func executionRecordsGiveUpAfterThePageLimit() async throws {
        let exchange = RecordingExchange((1...DeviceAPI.pageLimit).map { executionPage([$0], next: $0) })
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await api(exchange).executionRecords(threadId: "thread-a", runId: "run-a", known: [])
        }
        #expect(exchange.requests.count == DeviceAPI.pageLimit)
    }

    @Test func deviceNameFitsTheServerLimitInCodePointsWithoutHiddenCharacters() {
        let long = String(repeating: "葵", count: 70)
        #expect(PairingRequestLimits.deviceName("  " + long + "  ").unicodeScalars.count == 64)
        let emoji = PairingRequestLimits.deviceName(String(repeating: "🌻", count: 40))
        #expect(emoji == String(repeating: "🌻", count: 40))
        let flags = PairingRequestLimits.deviceName("a" + String(repeating: "🇯🇵", count: 40))
        #expect(flags.unicodeScalars.count == 63)
        #expect(PairingRequestLimits.deviceName("Andy\u{7}的\niPhone") == "Andy的iPhone")
        #expect(PairingRequestLimits.deviceName("A\u{202E}B\u{85}C\u{200B}D\u{FEFF}") == "ABCD")
        #expect(PairingRequestLimits.deviceName("A\u{061C}B\u{2060}C\u{2028}D\u{2029}E") == "ABCDE")
        #expect(PairingRequestLimits.deviceName("👨‍👩‍👧") == "👨👩👧")
        #expect(PairingRequestLimits.deviceName("Andy 的 iPhone") == "Andy 的 iPhone")
        #expect(PairingRequestLimits.deviceName("   ") == "iPhone")
    }

    @Test func textsWithNoRefsSendsNothing() async throws {
        let exchange = RecordingExchange([])
        #expect(try await api(exchange).texts(for: []).isEmpty)
        #expect(exchange.requests.isEmpty)
    }

    @Test func answerLocaleFollowsTheFirstSupportedPreferredLanguage() {
        #expect(AnswerLocale.matching(preferredLanguages: ["fr-FR", "ja-JP", "en-US"]) == .japanese)
        #expect(AnswerLocale.matching(preferredLanguages: ["zh-Hant-TW"]) == .chinese)
        #expect(AnswerLocale.matching(preferredLanguages: ["en-GB"]) == .english)
        #expect(AnswerLocale.matching(preferredLanguages: ["fr-FR"]) == .chinese)
    }
}
