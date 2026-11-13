import Foundation
import Testing
@testable import HimawariCore

struct ListenEvalTests {
    static let names = NameCall(names: ["Himawari", "ひまわり", "ヒマワリ", "向日葵"])

    static func kitData() throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/HimawariListenEngine/Resources/listen-eval-kit.json")
        return try Data(contentsOf: url)
    }

    @Test func speechLevelIgnoresTheSilenceAfterTheSentence() throws {
        let rate = 16_000.0
        let speech = [Float](repeating: 0.5, count: Int(rate * 2))
        let silence = [Float](repeating: 0, count: Int(rate * 1))
        let level = try #require(SpeechLevel.dbfs(samples: speech + silence, sampleRate: rate))
        #expect(abs(level - 20 * log10(0.5)) < 0.01)
        #expect(SpeechLevel.dbfs(samples: silence, sampleRate: rate) == SpeechLevel.silence)
        #expect(SpeechLevel.dbfs(samples: [], sampleRate: rate) == nil)
    }

    @Test func aFarVoiceScoresLowerThanANearOne() throws {
        let rate = 16_000.0
        let near = try #require(SpeechLevel.dbfs(samples: [Float](repeating: 0.3, count: 16_000), sampleRate: rate))
        let far = try #require(SpeechLevel.dbfs(samples: [Float](repeating: 0.03, count: 16_000), sampleRate: rate))
        #expect(VoiceScore.loudness(dbfs: near) - VoiceScore.loudness(dbfs: far) == 200)
    }

    @Test func theBundledKitHasTheAgreedSampleCounts() throws {
        let kit = try ListenEvalKit.decode(Self.kitData())
        let counts = Dictionary(uniqueKeysWithValues: kit.stages.map { ($0.id, $0.prompts.count) })
        #expect(counts == ["enroll": 3, "speaker-quiet": 100, "speaker-noisy": 100, "command-airpods": 40, "command-table": 40, "owner-mention": 10, "command-pocket": 20, "mixed": 85])
        #expect(kit.synthetic.bystander.count == 50)
        #expect(kit.synthetic.tvMention.count == 50)
        let ids = kit.stages.flatMap { $0.prompts.map(\.id) }
        #expect(Set(ids).count == ids.count)
        #expect(kit.promptCount == 398)
    }

    @Test func everyCommandAndMentionSaysTheNameSomewhere() throws {
        let kit = try ListenEvalKit.decode(Self.kitData())
        let spoken = kit.stages.filter { $0.purpose == .command || $0.purpose == .ownerMention }
        for stage in spoken {
            for prompt in stage.prompts {
                let folded = NameCall.fold(prompt.text)
                #expect(Self.names.names.contains { folded.contains($0) }, "\(prompt.id)")
            }
        }
        let placements = kit.stages.filter { $0.purpose == .command && $0.placement != .pocket }
        for stage in placements {
            let notFirst = stage.prompts.filter { !NameCall.fold($0.text).hasPrefix(NameCall.fold("Himawari")) }
            #expect(notFirst.count == 10, "\(stage.id)")
        }
        for line in kit.synthetic.bystander {
            #expect(Self.names.match(line.text) != nil, "\(line.text)")
        }
    }

    @Test func sessionWalksThePromptsInOrderAndReplacesARetake() throws {
        let kit = try ListenEvalKit.decode(Self.kitData())
        var session = ListenEvalSession(kitVersion: kit.version, device: "iPhone", system: "26.1")
        let first = try #require(session.nextPrompt(in: kit))
        #expect(first.prompt.id == "enroll-001")
        let at = Date(timeIntervalSince1970: 1_794_582_000)
        session.record(ListenEvalRecording(promptId: "enroll-001", file: "enroll-001.caf", route: .deviceMicrophone, inEar: nil, recordedAt: at, seconds: 3))
        session.record(ListenEvalRecording(promptId: "enroll-001", file: "enroll-001.caf", route: .deviceMicrophone, inEar: nil, recordedAt: at, seconds: 4))
        #expect(session.recordings.count == 1)
        #expect(session.recording(for: "enroll-001")?.seconds == 4)
        #expect(session.nextPrompt(in: kit)?.prompt.id == "enroll-002")
        #expect(session.recordedCount(in: kit.stages[0]) == 1)
        let decoded = try ListenEvalSession.decode(session.encoded())
        #expect(decoded == session)
    }

    @Test func replayRecordsWhatWasPreparedAndTheFinalRequest() {
        let pieces = [
            ListenEvalPiece(at: 0.3, start: 0, text: "Himawari", isFinal: false),
            ListenEvalPiece(at: 0.8, start: 0, text: "Himawari 帮我", isFinal: false),
            ListenEvalPiece(at: 1.4, start: 0, text: "Himawari 帮我看天气", isFinal: false),
            ListenEvalPiece(at: 1.9, start: 0, text: "Himawari 帮我看天气", isFinal: true),
        ]
        let call = ListenEvalReplay.call(names: Self.names, pieces: pieces)
        #expect(call == ListenEvalCall(nameHeard: true, request: "Himawari 帮我看天气", prepared: ["Himawari 帮我", "Himawari 帮我看天气"], heardName: "Himawari"))

        var changed = pieces
        changed[3] = ListenEvalPiece(at: 1.9, start: 0, text: "Himawari，帮我看天气。", isFinal: true)
        let punctuated = ListenEvalReplay.call(names: Self.names, pieces: changed)
        #expect(punctuated.request == "Himawari，帮我看天气。")
        #expect(punctuated.prepared.last == "Himawari 帮我看天气")
    }

    @Test func replayFollowsANameOnlyCallIntoTheNextSentence() {
        let pieces = [
            ListenEvalPiece(at: 0.5, start: 0, text: "ひまわり", isFinal: true),
            ListenEvalPiece(at: 2.0, start: 1.2, text: "明日の天気", isFinal: false),
            ListenEvalPiece(at: 2.6, start: 1.2, text: "明日の天気", isFinal: true),
        ]
        let call = ListenEvalReplay.call(names: Self.names, pieces: pieces)
        #expect(call == ListenEvalCall(nameHeard: true, request: "ひまわり\n明日の天気", prepared: ["ひまわり\n明日の天気"], heardName: "ひまわり"))
    }

    @Test func replayReportsNothingWhenTheNameIsNotCalled() {
        let pieces = [
            ListenEvalPiece(at: 0.4, start: 0, text: "今天天气", isFinal: false),
            ListenEvalPiece(at: 1.0, start: 0, text: "今天天气不错", isFinal: true),
        ]
        #expect(ListenEvalReplay.call(names: Self.names, pieces: pieces) == ListenEvalCall(nameHeard: false, request: nil, prepared: []))
    }

    @Test func transcriptJoinsFinalPiecesAndSpansTheSpeech() {
        let transcript = ListenEvalTranscript(engine: "transcriber", locale: "zh-CN", pieces: [
            ListenEvalPiece(at: 0.6, start: 0.2, text: "今天", isFinal: false),
            ListenEvalPiece(at: 1.0, start: 0.2, text: "今天天气", isFinal: true),
            ListenEvalPiece(at: 2.5, start: 1.4, text: "不错", isFinal: true),
        ], processingSeconds: 0.3)
        #expect(transcript.text == "今天天气 不错")
        #expect(transcript.speechSpan == 0.2...2.5)
    }
}

struct HeadphoneWearTests {
    let airpodsMic = AudioPortSnapshot(bluetooth: true, uid: "AA:BB:CC:DD:EE:FF-tsco", name: "Andy's AirPods Pro")

    @Test func wornNeedsFreshMotionAndTheSameHeadsetPlaying() {
        let same = [AudioPortSnapshot(bluetooth: true, uid: "AA:BB:CC:DD:EE:FF-tsco", name: "Andy's AirPods Pro")]
        let speaker = [AudioPortSnapshot(bluetooth: false, uid: "Speaker", name: "Speaker")]
        #expect(HeadphoneWear.playsThroughSameHeadset(input: airpodsMic, outputs: same))
        #expect(!HeadphoneWear.playsThroughSameHeadset(input: airpodsMic, outputs: speaker))
        #expect(!HeadphoneWear.playsThroughSameHeadset(input: nil, outputs: same))
        #expect(HeadphoneWear.worn(motionFresh: true, playsThroughSameHeadset: true) == true)
        #expect(HeadphoneWear.worn(motionFresh: true, playsThroughSameHeadset: false) == false)
        #expect(HeadphoneWear.worn(motionFresh: false, playsThroughSameHeadset: true) == false)
        #expect(HeadphoneWear.worn(motionFresh: nil, playsThroughSameHeadset: true) == nil)
    }

    @Test func anotherBluetoothHeadsetDoesNotCount() {
        let other = [AudioPortSnapshot(bluetooth: true, uid: "11:22:33:44:55:66", name: "Car Audio")]
        #expect(!HeadphoneWear.playsThroughSameHeadset(input: airpodsMic, outputs: other))
        let sameNameNewUID = [AudioPortSnapshot(bluetooth: true, uid: "AA:BB:CC:DD:EE:FF-tacl", name: "Andy's AirPods Pro")]
        #expect(HeadphoneWear.playsThroughSameHeadset(input: airpodsMic, outputs: sameNameNewUID))
    }
}
