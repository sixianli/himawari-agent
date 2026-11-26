import Foundation
import Testing
@testable import HimawariCore

@Suite struct VoiceTimingLogTests {
    private func record(_ id: String, said: Double, text: Double, sound: Double?) -> VoiceTimingRecord {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        return VoiceTimingRecord(
            messageId: id,
            saidAt: base.addingTimeInterval(said),
            firstTextAt: base.addingTimeInterval(text),
            firstSoundAt: sound.map { base.addingTimeInterval($0) },
            emittedAt: nil
        )
    }

    @Test func readsTheServerListNewestFirstWithMillisecondsAndNulls() async throws {
        let body = #"{"items":[{"messageId":"a","saidAt":"2026-11-26T03:00:00.000Z","firstTextAt":"2026-11-26T03:00:01.250Z","firstSoundAt":null,"emittedAt":"2026-11-26T03:00:01.100Z"},{"messageId":"b","saidAt":"2026-11-26T04:00:00.000Z","firstTextAt":"2026-11-26T04:00:00.500Z","firstSoundAt":"2026-11-26T04:00:01.500Z","emittedAt":null}]}"#
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(body.utf8))])
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test:8443/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let records = try await DeviceAPI(http: http).voiceTimings()
        #expect(exchange.requests.first?.url?.path == "/api/device/v1/voice-timing")
        #expect(exchange.requests.first?.url?.query == "limit=20")
        #expect(records.map(\.messageId) == ["b", "a"])
        #expect(records[0].soundGap == 1)
        #expect(records[1].textGap == 1.25)
        #expect(records[1].soundGap == nil)
        #expect(records[1].emittedAt != nil)
    }

    @Test func halfAndNinetyAreTheSmallestTimesThatCoverThatShareOfTurns() {
        let values: [TimeInterval] = [5, 1, 4, 2, 3, 10, 6, 7, 8, 9]
        #expect(VoiceTimingSummary.atOrBelow(0.5, of: values) == 5)
        #expect(VoiceTimingSummary.atOrBelow(0.9, of: values) == 9)
        #expect(VoiceTimingSummary.atOrBelow(0.5, of: [3]) == 3)
        #expect(VoiceTimingSummary.atOrBelow(0.5, of: []) == nil)
    }

    @Test func fewerThanFiveTurnsShowNoNumberAndSilentTurnsDoNotCountForSound() {
        let four = (0..<4).map { record("r\($0)", said: 0, text: 1, sound: 2) }
        #expect(VoiceTimingSummary(four).textGap == nil)
        let mixed = (0..<6).map { record("r\($0)", said: 0, text: Double($0 + 1), sound: $0 < 3 ? Double($0 + 2) : nil) }
        let summary = VoiceTimingSummary(mixed)
        #expect(summary.rounds == 6)
        #expect(summary.textGap == VoiceTimingSummary.Spread(half: 3, ninety: 6))
        #expect(summary.soundRounds == 3)
        #expect(summary.soundGap == nil)
    }
}
