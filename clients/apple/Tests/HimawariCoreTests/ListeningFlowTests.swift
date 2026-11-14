import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct UtteranceFlowTests {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private let names = NameCall(names: ["Himawari", "向日葵"])

    private func speech(_ text: String, score: Int? = 640) -> HeardSpeech {
        HeardSpeech(text: text, startedAt: t0, duration: 2.5, language: "zh-CN", confidence: 0.9, source: .deviceMicrophone, ownerScore: score)
    }

    @Test func sendsTheWholeSentenceOnceItsNameIsHeard() {
        var flow = UtteranceFlow(names: names, policy: SpokenRequestPolicy(partialInterval: 0.4, partialMinimumCharacters: 2, followUpSeconds: 8))
        flow.begin(.heard, at: t0, utteranceId: "utt-1")
        #expect(flow.partial("今天", at: t0).isEmpty)
        #expect(flow.partial("Himawari", at: t0) == [.heardName])
        #expect(flow.partial("Himawari，帮我", at: t0.addingTimeInterval(0.1)) == [.prepare(utteranceId: "utt-1", text: "Himawari，帮我")])
        #expect(flow.partial("Himawari，帮我约", at: t0.addingTimeInterval(0.2)).isEmpty)
        #expect(flow.partial("Himawari，帮我约田中", at: t0.addingTimeInterval(0.6)) == [.prepare(utteranceId: "utt-1", text: "Himawari，帮我约田中")])
        #expect(flow.partial("Himawari，帮我约田中", at: t0.addingTimeInterval(1.2)).isEmpty)
        guard case let .command(request, heard, touched, heardName) = flow.finish(speech("Himawari，帮我约田中十点"), mode: .full, at: t0) else {
            Issue.record("expected a command")
            return
        }
        #expect(request == "Himawari，帮我约田中十点")
        #expect(heardName == "Himawari")
        #expect(heard.utteranceId == "utt-1")
        #expect(heard.speaker == HeardSpeaker(kind: .owner, score: 640))
        #expect(!touched)
        #expect(flow.utteranceId != "utt-1")
    }

    @Test func sendsTheSentenceWhenTheNameComesLast() {
        var flow = UtteranceFlow(names: names)
        flow.begin(.heard, at: t0, utteranceId: "utt-5")
        #expect(flow.partial("帮我订个会议室", at: t0).isEmpty)
        guard case let .command(request, _, _, heardName) = flow.finish(speech("帮我订个会议室，向日葵"), mode: .nameOnly, at: t0) else {
            Issue.record("expected a command")
            return
        }
        #expect(request == "帮我订个会议室，向日葵")
        #expect(heardName == "向日葵")
    }

    @Test func treatsEverythingAsTheRequestWhenTheOwnerTouchedIt() {
        var flow = UtteranceFlow(names: names)
        flow.begin(.ownerTouched, at: t0, utteranceId: "utt-2")
        #expect(flow.partial("帮我订会议室", at: t0) == [.prepare(utteranceId: "utt-2", text: "帮我订会议室")])
        #expect(flow.finish(speech("帮我订会议室"), mode: .nameOnly, at: t0) == .command(
            request: "帮我订会议室",
            heard: HeardUtterance(utteranceId: "utt-2", text: "帮我订会议室", startedAt: t0, duration: 2.5, language: "zh-CN", confidence: 0.9, source: .deviceMicrophone, speaker: HeardSpeaker(kind: .owner, score: 640)),
            touched: true,
            heardName: nil
        ))
    }

    @Test func takesTheNextSentenceAsTheRequestAfterAPauseFollowingTheName() {
        var flow = UtteranceFlow(names: names)
        flow.begin(.heard, at: t0)
        guard case .calledOnly = flow.finish(speech("向日葵"), mode: .full, at: t0) else {
            Issue.record("expected only the name")
            return
        }
        flow.begin(.heard, at: t0.addingTimeInterval(3), utteranceId: "utt-3")
        #expect(flow.isCommandCandidate)
        #expect(flow.partial("几点了", at: t0.addingTimeInterval(3)) == [.prepare(utteranceId: "utt-3", text: "向日葵\n几点了")])
        guard case let .command(request, _, _, heardName) = flow.finish(speech("几点了"), mode: .full, at: t0.addingTimeInterval(4)) else {
            Issue.record("expected a command")
            return
        }
        #expect(request == "向日葵\n几点了")
        #expect(heardName == "向日葵")
    }

    @Test func forgetsTheNameWhenTheNextSentenceComesTooLate() {
        var flow = UtteranceFlow(names: names, policy: SpokenRequestPolicy(partialInterval: 0.4, partialMinimumCharacters: 2, followUpSeconds: 8))
        flow.begin(.heard, at: t0)
        _ = flow.finish(speech("向日葵"), mode: .full, at: t0)
        flow.begin(.heard, at: t0.addingTimeInterval(9))
        #expect(!flow.isCommandCandidate)
        guard case .record = flow.finish(speech("几点了"), mode: .full, at: t0.addingTimeInterval(10)) else {
            Issue.record("late sentence should be ordinary talk")
            return
        }
    }

    @Test func keepsOrdinaryTalkOnlyWhenListeningFully() {
        var flow = UtteranceFlow(names: names)
        flow.begin(.heard, at: t0, utteranceId: "utt-4")
        guard case let .record(heard) = flow.finish(speech("下午三点开会", score: nil), mode: .full, at: t0) else {
            Issue.record("expected a record")
            return
        }
        #expect(heard.speaker == HeardSpeaker(kind: .unknown, score: nil))
        flow.begin(.heard, at: t0)
        #expect(flow.finish(speech("下午三点开会"), mode: .nameOnly, at: t0) == .nothing)
        flow.begin(.heard, at: t0)
        #expect(flow.finish(speech("   "), mode: .full, at: t0) == .nothing)
    }
}

@Suite struct ListeningUsageTests {
    private func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    @Test func countsOnlyTheBatteryUsedWhileListeningOffTheCharger() {
        var meter = ListeningBatteryMeter(day: "2026-11-13")
        meter.sample(level: 0.80, charging: false, listening: true, day: "2026-11-13")
        meter.sample(level: 0.77, charging: false, listening: true, day: "2026-11-13")
        meter.sample(level: 0.70, charging: false, listening: false, day: "2026-11-13")
        meter.sample(level: 0.60, charging: false, listening: true, day: "2026-11-13")
        meter.sample(level: 0.65, charging: true, listening: true, day: "2026-11-13")
        meter.sample(level: 0.64, charging: false, listening: true, day: "2026-11-13")
        meter.sample(level: 0.615, charging: false, listening: true, day: "2026-11-13")
        #expect(meter.usedPercent == 5)
        meter.sample(level: 0.5, charging: false, listening: true, day: "2026-11-14")
        #expect(meter.usedPercent == 0)
        meter.sample(level: nil, charging: false, listening: true, day: "2026-11-14")
        meter.sample(level: 0.4, charging: false, listening: true, day: "2026-11-14")
        #expect(meter.usedPercent == 0)
    }

    @Test func readsTheTwoListeningLimitsAndReportsBatteryAsAWholePercent() async throws {
        let usage = """
        {"day":"2026-11-13","resetsAt":"2026-11-13T15:00:00.000Z","warnPermille":800,"limits":[
        {"key":"perception.audio.daily","unit":"milliseconds","limit":57600000,"used":57600000,"resetsAt":"2026-11-13T15:00:00.000Z"},
        {"key":"device.battery.listening","unit":"percent","limit":null,"used":3,"resetsAt":"2026-11-13T15:00:00.000Z"},
        {"key":"perception.records.daily","unit":"records","limit":20000,"used":5}]}
        """
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 200, body: Data(usage.utf8)),
            HTTPExchangeResponse(status: 200, body: Data(#"{"accepted":true}"#.utf8)),
        ])
        let api = try api(exchange)
        let limits = try await api.listeningLimits()
        #expect(limits.audioSpent)
        #expect(limits.audio?.resetsAt == Date(timeIntervalSince1970: 1_794_582_000))
        #expect(!limits.batterySpent(usedPercent: 99))
        #expect(ListeningLimits(audio: nil, battery: .init(limit: 10, used: 0, resetsAt: nil)).batterySpent(usedPercent: 10))
        try await api.reportListeningBattery(usedPercent: 140)
        let sent = try #require(exchange.requests.last)
        #expect(sent.url?.path == "/api/device/v1/usage/report")
        let data = try #require(sent.httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Int])
        #expect(body == ["device.battery.listening": 100])
    }

    @Test func stopsOnTheAudioLimitOrWhenTheServerSaysHearingIsOff() async throws {
        let response = #"{"outcomes":[{"id":"perception:a","outcome":"stored"}],"reached":["perception.audio.daily"]}"#
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(response.utf8))])
        let result = try await api(exchange).upload(heard: [])
        #expect(result.outcomes == ["perception:a": .stored])
        #expect(result.refusal == .dailyAudioLimit)
        #expect(HeardUploadResult(outcomes: ["a": .senseOff], reached: []).refusal == .senseOff)
        #expect(HeardUploadResult(outcomes: ["a": .stored], reached: []).refusal == nil)
    }

    @Test func listensOnlyForItsNameOnceTheBatteryBudgetIsSpent() {
        let t0 = Date(timeIntervalSince1970: 0)
        var session = ListeningSession()
        session.handle(.ownerStarted(at: t0))
        let spent = session.handle(.power(batteryPercent: 80, charging: false, hot: false, budgetSpent: true))
        #expect(spent.state == .listening(since: t0, mode: .nameOnly, downgrade: .batteryBudget))
        #expect(spent.notice == .downgraded(.batteryBudget))
    }
}
