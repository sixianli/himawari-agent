import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct SpokenCommandTests {
    private func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data = try #require(request.httpBody)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private let accepted = """
    {"type":"thread.command_result","payload":{"threadRevision":2,"replayed":false}}
    """

    private func spoken(_ voice: VoiceEvidence) -> SpokenMessage {
        SpokenMessage(
            message: OutgoingMessage(messageId: "msg_AAAAAAAAAAAAAAAAAAAAAA", threadId: "thread-a", expectedRevision: 1, text: "帮我把明天的会改到下午", createdAt: Date(timeIntervalSince1970: 0)),
            utteranceId: "utt_AAAAAAAAAAAAAAAA",
            voice: voice
        )
    }

    @Test func sendsTheEvidenceButNeverAVerdict() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(accepted.utf8))])
        let outcome = try await api(exchange).send(spoken(VoiceEvidence(trigger: .airpodsName, speakerScore: 420, inputRoute: .airpods, inEar: true, loudnessScore: 810)))
        #expect(outcome == .sent(.accepted(threadRevision: 2, replayed: false)))
        let request = try #require(exchange.requests.first)
        let sent = try body(request)
        #expect(Set(sent.keys) == ["messageId", "threadId", "expectedRevision", "text", "utteranceId", "voice"])
        let voice = try #require(sent["voice"] as? [String: Any])
        #expect(Set(voice.keys) == ["trigger", "speakerScore", "inputRoute", "inEar", "loudnessScore"])
        #expect(voice["trigger"] as? String == "airpods_name")
        #expect(voice["inputRoute"] as? String == "airpods")
    }

    @Test func leavesOutEvidenceThatWasNotMeasured() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(accepted.utf8))])
        _ = try await api(exchange).send(spoken(VoiceEvidence(trigger: .handsOn)))
        let request = try #require(exchange.requests.first)
        let sent = try body(request)
        let voice = try #require(sent["voice"] as? [String: Any])
        #expect(Set(voice.keys) == ["trigger"])
    }

    @Test func turnsTheServersRefusalIntoAQuestionWithItsReason() async throws {
        let refusal = #"{"error":{"code":"VOICE_COMMAND_UNCONFIRMED","reason":"speaker_unconfirmed"}}"#
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 409, body: Data(refusal.utf8))])
        let outcome = try await api(exchange).send(spoken(VoiceEvidence(trigger: .ambientName, speakerScore: 990)))
        #expect(outcome == .askFirst(.speakerUnconfirmed))
    }

    @Test func readsTheDecisionModelsThreeRefusalsAndOnlyAsksWhenItShould() async throws {
        for (reason, expected, asks) in [
            ("not_addressed", SpokenCommandRefusal.notAddressed, false),
            ("addressed_unsure", .addressedUnsure, true),
            ("addressed_budget", .addressedBudget, true),
        ] {
            let refusal = #"{"error":{"code":"VOICE_COMMAND_UNCONFIRMED","reason":""# + reason + #""}}"#
            let exchange = RecordingExchange([HTTPExchangeResponse(status: 409, body: Data(refusal.utf8))])
            let outcome = try await api(exchange).send(spoken(VoiceEvidence(trigger: .ambientName, speakerScore: 990, heardName: "Himawari")))
            #expect(outcome == .askFirst(expected))
            #expect(expected.asksOwner == asks)
        }
        #expect(SpokenCommandRefusal.speakerUnconfirmed.asksOwner)
    }

    @Test func otherConflictsAreStillErrors() async throws {
        let other = #"{"error":{"code":"THREAD_REVISION_CONFLICT"}}"#
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 409, body: Data(other.utf8))])
        await #expect(throws: DeviceAPIError.self) {
            _ = try await api(exchange).send(spoken(VoiceEvidence(trigger: .handsOn)))
        }
    }

    @Test func clampsScoresIntoTheServersRange() {
        #expect(VoiceEvidence(trigger: .ambientName, speakerScore: 1500).speakerScore == 1000)
        #expect(VoiceEvidence(trigger: .ambientName, speakerScore: -3).speakerScore == 0)
        #expect(VoiceScore.fromUnit(0.8234) == 823)
        #expect(VoiceScore.fromUnit(.nan) == 0)
        #expect(VoiceScore.loudness(dbfs: -30) == 700)
        #expect(VoiceScore.loudness(dbfs: -120) == 0)
        #expect(VoiceScore.loudness(dbfs: 3) == 1000)
    }

    @Test func picksTheTriggerFromHowTheOwnerCalled() {
        #expect(SpokenTrigger.evidence(for: .ownerTouched, speakerScore: nil) == VoiceEvidence(trigger: .handsOn))
        #expect(SpokenTrigger.evidence(for: .heardName(route: .airpods, inEar: true, loudnessScore: 800), speakerScore: 300) == VoiceEvidence(trigger: .airpodsName, speakerScore: 300, inputRoute: .airpods, inEar: true, loudnessScore: 800))
        #expect(SpokenTrigger.evidence(for: .heardName(route: .deviceMicrophone, inEar: nil, loudnessScore: 500), speakerScore: 700) == VoiceEvidence(trigger: .ambientName, speakerScore: 700, inputRoute: .deviceMicrophone, loudnessScore: 500))
        #expect(SpokenTrigger.evidence(for: .heardName(route: .deviceMicrophone, inEar: nil, loudnessScore: 500), speakerScore: 700, heardName: "Himawari").heardName == "Himawari")
        #expect(SpokenTrigger.evidence(for: .ownerTouched, speakerScore: 700, heardName: "Himawari").heardName == nil)
        #expect(VoiceEvidence(trigger: .ambientName, heardName: String(repeating: "a", count: 80)).heardName?.count == VoiceEvidence.heardNameMaximumCharacters)
        #expect(VoiceEvidence(trigger: .ambientName, heardName: String(repeating: "\u{1F1EF}\u{1F1F5}", count: 40)).heardName?.unicodeScalars.count == VoiceEvidence.heardNameMaximumCharacters)
        #expect(VoiceEvidence(trigger: .ambientName, heardName: "Hima\u{200D}wari").heardName == "Himawari")
    }

    @Test func halfSentencesGoToTheirOwnRoute() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(#"{"prepared":false,"reason":"limit_reached"}"#.utf8))])
        let prepared = try await api(exchange).prepare(utteranceId: "utt_AAAAAAAAAAAAAAAA", partialText: "帮我把明天")
        #expect(prepared == PartialPreparation(prepared: false, reason: "limit_reached"))
        let request = try #require(exchange.requests.first)
        #expect(request.url?.path.hasSuffix("/api/device/v1/utterances/partial") == true)
        let sent = try body(request)
        #expect(Set(sent.keys) == ["utteranceId", "text"])
    }
}

@Suite struct HeardUtteranceTests {
    private func heard(text: String = "我明天下午去牙医", speaker: HeardSpeaker? = HeardSpeaker(kind: .owner, score: 640)) -> HeardUtterance {
        HeardUtterance(utteranceId: "utt_AAAAAAAAAAAAAAAA", text: text, startedAt: Date(timeIntervalSince1970: 1_800_000_000.25), duration: 2.4, language: "zh-Hans-CN-extra-long-tag", confidence: 0.912, source: .deviceMicrophone, speaker: speaker)
    }

    @Test func buildsARecordTheServerAccepts() throws {
        let upload = SpeechUtteranceUpload(heard(), textLimit: nil)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(upload)) as? [String: Any])
        #expect(Set(json.keys) == ["id", "type", "captureSource", "occurredAt", "confidence", "text", "speaker", "evidence"])
        #expect(json["id"] as? String == "perception:utt_AAAAAAAAAAAAAAAA")
        #expect(json["type"] as? String == "speech.utterance")
        #expect(json["captureSource"] as? String == "device_microphone")
        #expect(json["occurredAt"] as? String == "2027-01-15T08:00:00.250Z")
        #expect(json["confidence"] as? Int == 912)
        let evidence = try #require(json["evidence"] as? [String: Any])
        #expect(evidence["durationMs"] as? Int == 2400)
        #expect(evidence["language"] as? String == "zh-Hans-CN-extra")
        #expect(evidence["utteranceId"] as? String == "utt_AAAAAAAAAAAAAAAA")
        #expect(evidence["transcriber"] as? String == "device")
        let speaker = try #require(json["speaker"] as? [String: Any])
        #expect(speaker["kind"] as? String == "owner")
        #expect(speaker["score"] as? Int == 640)
    }

    @Test func cutsTextAtTheServersLimitAndLeavesOutAnUnknownSpeaker() throws {
        let upload = SpeechUtteranceUpload(heard(text: "一二三四五", speaker: nil), textLimit: 3)
        #expect(upload.text == "一二三")
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(upload)) as? [String: Any])
        #expect(json["speaker"] == nil)
    }
}

@Suite struct SentenceReaderTests {
    @Test func readsEachSentenceOnceAsTheAnswerGrows() {
        var reader = SentenceReader()
        #expect(reader.next(fullText: "好的，") == [])
        #expect(reader.next(fullText: "好的，我把会改到了下午三点。另外") == ["好的，我把会改到了下午三点。"])
        #expect(reader.next(fullText: "好的，我把会改到了下午三点。另外，记得带资料！") == ["另外，记得带资料！"])
        #expect(reader.finish(fullText: "好的，我把会改到了下午三点。另外，记得带资料！") == [])
    }

    @Test func keepsNumbersAndClosingQuotesTogether() {
        var reader = SentenceReader()
        #expect(reader.next(fullText: "It costs 3.5 dollars. Next") == ["It costs 3.5 dollars."])
        #expect(reader.next(fullText: "It costs 3.5 dollars. Next he said「好的。」然后") == ["Next he said「好的。」"])
        #expect(reader.finish(fullText: "It costs 3.5 dollars. Next he said「好的。」然后走了") == ["然后走了"])
    }

    @Test func startsOverWhenTheTextIsReplaced() {
        var reader = SentenceReader()
        _ = reader.next(fullText: "第一句。")
        #expect(reader.next(fullText: "换了。") == ["换了。"])
    }
}

@Suite struct NameCallTests {
    private let call = NameCall(names: ["Himawari", "ひまわり", "向日葵"])

    @Test func findsTheNameWhereverItIsAndKeepsTheWholeSentence() {
        #expect(call.match("Himawari，帮我订会议室") == NameCall.Match(name: "Himawari", text: "Himawari，帮我订会议室", saysMoreThanTheName: true))
        #expect(call.match("帮我订个会议室，Himawari")?.text == "帮我订个会议室，Himawari")
        #expect(call.match("我跟你说，himawari 帮我查天气")?.name == "Himawari")
        #expect(call.match("ねえ、ひまわり、明日の天気は？")?.name == "ひまわり")
        #expect(call.match("ＨＩＭＡＷＡＲＩ 几点了")?.name == "Himawari")
    }

    @Test func leavesWhetherItIsBeingAddressedToTheServer() {
        #expect(call.match("我昨天让 Himawari 订了会议室")?.saysMoreThanTheName == true)
        #expect(call.match("昨天我们去公园看了很多向日葵")?.name == "向日葵")
    }

    @Test func tellsWhenOnlyTheNameWasSaid() {
        #expect(call.match("Himawari？")?.saysMoreThanTheName == false)
        #expect(call.match("今天天气不错") == nil)
        #expect(call.match("") == nil)
    }

    @Test func takesItsNamesFromWhereverTheyAreGiven() {
        #expect(NameCall(names: ["Sunny"]).match("开灯 Sunny")?.name == "Sunny")
        #expect(NameCall(names: ["Sunny"]).match("Himawari 开灯") == nil)
    }
}

@Suite struct VoiceprintTests {
    @Test func scoresTheOwnerHighAndSomeoneElseLow() throws {
        var enrollment = VoiceprintEnrollment(prompts: ["一", "二", "三"])
        #expect(enrollment.currentIndex == 0)
        enrollment.add([1, 0.1, 0])
        enrollment.add([0.9, 0, 0.1])
        #expect(enrollment.voiceprint(model: "m", at: Date()) == nil)
        enrollment.add([1, 0, 0])
        let print = try #require(enrollment.voiceprint(model: "m", at: Date(timeIntervalSince1970: 0)))
        #expect(print.samples == 3)
        #expect(try #require(print.score([1, 0.05, 0.05], model: "m")) > 990)
        #expect(try #require(print.score([0, 1, 0], model: "m")) < 100)
        #expect(print.score([0, -1, 0], model: "m") == 0)
    }

    @Test func refusesToCompareAcrossModelsOrSizes() throws {
        let print = try #require(Voiceprint(model: "m", samples: [[1, 0]], enrolledAt: Date()))
        #expect(print.score([1, 0], model: "other") == nil)
        #expect(print.score([1, 0, 0], model: "m") == nil)
        #expect(print.score([0, 0], model: "m") == nil)
        #expect(Voiceprint(model: "m", samples: [], enrolledAt: Date()) == nil)
        #expect(Voiceprint(model: "m", samples: [[1, 0], [1]], enrolledAt: Date()) == nil)
    }

    @Test func storesOnlyOnThisDeviceAndCanBeDeleted() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FileVoiceprintStore(url: directory.appendingPathComponent("voiceprint.json"))
        #expect(try store.load() == nil)
        let print = try #require(Voiceprint(model: "m", samples: [[3, 4]], enrolledAt: Date(timeIntervalSince1970: 10)))
        try store.save(print)
        #expect(try store.load() == print)
        try store.delete()
        #expect(try store.load() == nil)
    }
}

@Suite struct ListeningSessionTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func startsWithAMediumTapAndCountsTimeFromTheStart() {
        var session = ListeningSession()
        let started = session.handle(.ownerStarted(at: t0))
        #expect(started.haptic == .listeningStarted)
        #expect(started.microphoneOn)
        #expect(session.elapsed(at: t0.addingTimeInterval(2712)) == 2712)
        let stopped = session.handle(.ownerStopped(at: t0.addingTimeInterval(10)))
        #expect(stopped.haptic == .listeningStopped)
        #expect(!stopped.microphoneOn)
        #expect(session.elapsed(at: t0) == nil)
    }

    @Test func resumesQuietlyAfterACallWhenTheSystemSaysSo() {
        var session = ListeningSession()
        session.handle(.ownerStarted(at: t0))
        #expect(!session.handle(.interruptionBegan(at: t0.addingTimeInterval(60))).microphoneOn)
        #expect(session.elapsed(at: t0.addingTimeInterval(120)) == 120)
        let resumed = session.handle(.interruptionEnded(at: t0.addingTimeInterval(300), systemSuggestsResume: true))
        #expect(resumed.microphoneOn)
        #expect(resumed.notice == nil)
        #expect(session.elapsed(at: t0.addingTimeInterval(400)) == 400)
    }

    @Test func asksTheOwnerToTapWhenItCannotResumeByItself() {
        var session = ListeningSession()
        session.handle(.ownerStarted(at: t0))
        session.handle(.interruptionBegan(at: t0))
        #expect(session.handle(.interruptionEnded(at: t0, systemSuggestsResume: false)).notice == .pausedTapToContinue)
        var other = ListeningSession()
        other.handle(.ownerStarted(at: t0))
        other.handle(.interruptionBegan(at: t0))
        #expect(other.handle(.resumeFailed(at: t0)).notice == .pausedTapToContinue)
        #expect(other.handle(.ownerStarted(at: t0.addingTimeInterval(5))).microphoneOn)
    }

    @Test func stopsAtTheDailyLimitAndSaysWhenItComesBack() {
        var session = ListeningSession()
        session.handle(.ownerStarted(at: t0))
        let tomorrow = t0.addingTimeInterval(86_400)
        let stopped = session.handle(.audioLimitReached(at: t0, resumesAt: tomorrow))
        #expect(stopped.notice == .stopped(.dailyAudioLimit, resumesAt: tomorrow))
        #expect(!stopped.microphoneOn)
    }

    @Test func listensOnlyForItsNameWhenTheBatteryIsLowOrTheDeviceIsHot() {
        var session = ListeningSession(policy: ListeningPolicy(batteryFloorPercent: 20))
        session.handle(.ownerStarted(at: t0))
        #expect(session.handle(.power(batteryPercent: 50, charging: false, hot: false)).notice == nil)
        let low = session.handle(.power(batteryPercent: 19, charging: false, hot: false))
        #expect(low.notice == .downgraded(.batteryLow))
        #expect(low.state == .listening(since: t0, mode: .nameOnly, downgrade: .batteryLow))
        #expect(session.handle(.power(batteryPercent: 19, charging: true, hot: false)).notice == .restored)
        #expect(session.handle(.power(batteryPercent: 90, charging: true, hot: true)).notice == .downgraded(.deviceHot))
        #expect(session.handle(.power(batteryPercent: 90, charging: true, hot: true)).notice == nil)
    }

    @Test func ignoresEventsThatDoNotApply() {
        var session = ListeningSession()
        #expect(session.handle(.interruptionBegan(at: t0)).state == .off)
        #expect(session.handle(.power(batteryPercent: 5, charging: false, hot: true)).notice == nil)
    }
}
