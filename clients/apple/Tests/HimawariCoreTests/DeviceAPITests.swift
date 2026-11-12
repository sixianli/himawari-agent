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

    @Test func textsStopWhenTheServerDefersEveryRef() async throws {
        let object: [String: Any] = ["items": [String: Any](), "deferred": ["a", "b"]]
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: object))])
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await api(exchange).texts(for: ["a", "b"])
        }
    }

    @Test func expiredPairingCodeCarriesTheServerTtl() throws {
        let body = Data(#"{"error":{"code":"DEVICE_PAIRING_CODE_EXPIRED","pairingCodeTtlSeconds":600}}"#.utf8)
        #expect(throws: DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED", pairingCodeTtlSeconds: 600)) {
            _ = try DeviceHTTPClient.check(HTTPExchangeResponse(status: 410, body: body))
        }
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
