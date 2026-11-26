import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

final class ByteExchange: HTTPExchange, @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [(status: Int, headers: [String: String], chunks: [Data])]
    private(set) var requests: [URLRequest] = []

    init(_ replies: [(status: Int, headers: [String: String], chunks: [Data])]) {
        self.replies = replies
    }

    func send(_ request: URLRequest) async throws -> HTTPExchangeResponse {
        throw HTTPExchangeError.streamingUnsupported
    }

    func stream(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<String, Error>) {
        throw HTTPExchangeError.streamingUnsupported
    }

    func bytes(_ request: URLRequest) async throws -> HTTPByteResponse {
        let next = lock.withLock {
            requests.append(request)
            return replies.removeFirst()
        }
        let chunks = AsyncThrowingStream<Data, Error> { continuation in
            for chunk in next.chunks { continuation.yield(chunk) }
            continuation.finish()
        }
        return HTTPByteResponse(status: next.status, headers: next.headers, chunks: chunks)
    }
}

@Suite struct CloudSpeechTests {
    @Test func aTurnFallsBackToLocalAfterAFailureAndTriesCloudAgainNextTurn() {
        var policy = CloudSpeechPolicy()
        #expect(policy.route("你好。") == .cloud)
        policy.failed(status: 504)
        #expect(policy.route("你好。") == .local)
        policy.newTurn()
        #expect(policy.route("你好。") == .cloud)
    }

    @Test func unavailableSpeechStaysLocalForTheWholeConversation() {
        var policy = CloudSpeechPolicy()
        policy.failed(status: 503)
        policy.newTurn()
        #expect(policy.route("你好。") == .local)
    }

    @Test func aSensitiveSentenceIsReadLocallyWithoutGivingUpOnTheTurn() {
        var policy = CloudSpeechPolicy()
        policy.failed(status: 422)
        #expect(policy.route("下一句。") == .cloud)
    }

    @Test func aSentenceLongerThanTheServerAcceptsIsReadLocally() {
        let policy = CloudSpeechPolicy()
        #expect(policy.route(String(repeating: "长", count: 601)) == .local)
        #expect(policy.route(String(repeating: "长", count: 600)) == .cloud)
    }

    @Test func littleEndianSamplesSplitAcrossChunksDecodeInOrder() {
        var decoder = PCM16Decoder()
        let first = decoder.samples(Data([0x00, 0x40, 0x00]))
        let second = decoder.samples(Data([0x80, 0xFF, 0x7F]))
        #expect(first == [0.5])
        #expect(second == [-1, Float(Int16.max) / 32768])
    }

    @Test func speechReadsTheSampleRateFromTheResponseAndStreamsTheAudio() async throws {
        let exchange = ByteExchange([(200, ["X-Himawari-Speech-Sample-Rate": "22050", "X-Himawari-Speech-First-Audio-Ms": "312"], [Data([1, 2]), Data([3, 4])])])
        let api = try api(exchange)
        let audio = try await api.speech("你好。")
        var received = Data()
        for try await chunk in audio.chunks { received.append(chunk) }
        #expect(audio.sampleRate == 22050)
        #expect(audio.firstAudioMs == 312)
        #expect(received == Data([1, 2, 3, 4]))
        let request = try #require(exchange.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/device/v1/speech")
        #expect(try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String] == ["text": "你好。"])
        #expect(request.value(forHTTPHeaderField: "Signature") != nil)
    }

    @Test func aRefusedSpeechRequestReportsTheServerStatusAndCode() async throws {
        let exchange = ByteExchange([(503, [:], [Data(#"{"code":"SPEECH_UNAVAILABLE"}"#.utf8)])])
        await #expect(throws: DeviceAPIError.server(status: 503, code: "SPEECH_UNAVAILABLE")) {
            _ = try await self.api(exchange).speech("你好。")
        }
    }

    @Test func speechWithoutASampleRateIsRejected() async throws {
        let exchange = ByteExchange([(200, [:], [Data([1, 2])])])
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await self.api(exchange).speech("你好。")
        }
    }

    @Test func aSpokenMessageTellsTheServerAndATypedOneDoesNot() async throws {
        let accepted = HTTPExchangeResponse(status: 200, body: Data(#"{"accepted":true,"threadRevision":2}"#.utf8))
        let exchange = RecordingExchange([accepted, accepted])
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test:8443/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let api = DeviceAPI(http: http)
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        _ = try? await api.send(OutgoingMessage(threadId: "thr_1", expectedRevision: 1, text: "说的", createdAt: at, spoken: true))
        _ = try? await api.send(OutgoingMessage(threadId: "thr_1", expectedRevision: 1, text: "打的", createdAt: at))
        let bodies = try exchange.requests.map { request in
            let body = try #require(request.httpBody)
            return try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        }
        #expect(bodies.count == 2)
        #expect(bodies.first?["spoken"] as? Bool == true)
        #expect(bodies.last?["spoken"] == nil)
    }

    @Test func aTurnIsReportedWithMillisecondUTCTimesAndAnExplicitNullWhenNothingWasHeard() throws {
        var timing = TalkTurnTiming()
        timing.saidAt = Date(timeIntervalSince1970: 1_800_000_000.5)
        #expect(timing.report == nil)
        timing.messageId = "msg_1"
        #expect(timing.report == nil)
        timing.firstTextAt = Date(timeIntervalSince1970: 1_800_000_001.25)
        let report = try #require(timing.report)
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? [String: Any])
        #expect(Set(body.keys) == ["messageId", "saidAt", "firstTextAt", "firstSoundAt"])
        #expect(body["messageId"] as? String == "msg_1")
        #expect(body["saidAt"] as? String == "2027-01-15T08:00:00.500Z")
        #expect(body["firstTextAt"] as? String == "2027-01-15T08:00:01.250Z")
        #expect(body["firstSoundAt"] is NSNull)
    }

    @Test func aTimingTheServerHasNoTurnForYetIsSentAgainButABadOneIsNot() async throws {
        let missing = HTTPExchangeResponse(status: 404, body: Data(#"{"code":"EXECUTION_NOT_FOUND"}"#.utf8))
        let recorded = HTTPExchangeResponse(status: 200, body: Data(#"{"recorded":true}"#.utf8))
        let rejected = HTTPExchangeResponse(status: 400, body: Data(#"{"code":"INVALID"}"#.utf8))
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let timing = VoiceTiming(messageId: "msg_1", saidAt: at, firstTextAt: at, firstSoundAt: at)

        let retried = RecordingExchange([missing, recorded])
        let retriedAPI = try api(retried)
        await retriedAPI.reportVoiceTiming(timing, sleep: { _ in })
        #expect(retried.requests.count == 2)
        #expect(retried.requests.first?.url?.path == "/api/device/v1/voice-timing")

        let refused = RecordingExchange([rejected, recorded])
        let refusedAPI = try api(refused)
        await refusedAPI.reportVoiceTiming(timing, sleep: { _ in })
        #expect(refused.requests.count == 1)

        let gone = RecordingExchange(Array(repeating: missing, count: 10))
        let goneAPI = try api(gone)
        await goneAPI.reportVoiceTiming(timing, sleep: { _ in })
        #expect(gone.requests.count == VoiceTiming.retryDelays.count + 1)
    }

    private func api(_ exchange: some HTTPExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test:8443/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }
}
