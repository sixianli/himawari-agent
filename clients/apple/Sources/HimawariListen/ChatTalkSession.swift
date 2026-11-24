#if os(iOS)
@preconcurrency import AVFoundation
import Foundation
import HimawariChat
import HimawariCore
import HimawariListenEngine
import Observation

@MainActor
@Observable
public final class ChatTalkSession: ChatTalk {
    public private(set) var phase: TalkPhase = .starting
    public private(set) var heard = ""
    public private(set) var levels: [Double] = []
    public private(set) var muted = false

    @ObservationIgnored private var audio: TalkAudio?
    @ObservationIgnored private var pipeline: SpeechPipeline?
    @ObservationIgnored private var feeding: Task<Void, Never>?
    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var turn = TalkTurn()
    @ObservationIgnored private var reader = SentenceReader()
    @ObservationIgnored private var replySource = ""
    @ObservationIgnored private var interrupted = false
    @ObservationIgnored private var sentencesRendering = 0
    @ObservationIgnored private var buffersPlaying = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var speech = 0
    @ObservationIgnored private var onSaid: (@MainActor (String) -> Void)?
    @ObservationIgnored private var language: String?

    private static let levelsKept = 32

    public init() {}

    public func begin(onSaid: @escaping @MainActor (String) -> Void) async throws {
        await end()
        generation += 1
        let started = generation
        phase = .starting
        guard await AVAudioApplication.requestRecordPermission() else { throw ChatDictationError.microphoneDenied }
        let locale = Locale(identifier: Locale.preferredLanguages.first ?? "zh-Hans")
        language = locale.identifier
        let pipeline = try await SpeechPipeline.make(preferred: locale, sensitivity: .medium, engine: .dictation)
        guard started == generation else { return }
        try await pipeline.start { [weak self] piece in
            await self?.receive(piece, generation: started)
        }
        let audio = TalkAudio()
        try audio.start()
        guard started == generation else {
            audio.stop()
            await pipeline.cancel()
            return
        }
        self.audio = audio
        self.pipeline = pipeline
        self.onSaid = onSaid
        turn = TalkTurn()
        heard = ""
        muted = false
        phase = .listening
        feeding = Task { [weak self] in
            for await captured in audio.buffers {
                self?.feed(captured, generation: started)
            }
        }
    }

    public func herReply(_ markdown: String, finished: Bool) {
        guard audio != nil else { return }
        let text = SpokenText.from(markdown: markdown)
        if replySource.isEmpty || !text.hasPrefix(replySource) {
            reader = SentenceReader()
            interrupted = false
        }
        replySource = text
        guard !interrupted else { return }
        let sentences = finished ? reader.finish(fullText: text) : reader.next(fullText: text)
        for sentence in sentences { say(sentence) }
    }

    public func setMuted(_ muted: Bool) {
        self.muted = muted
        if muted {
            turn = TalkTurn()
            heard = ""
            levels = []
        }
        settlePhase()
    }

    public func end() async {
        generation += 1
        speech += 1
        let said = turn.take()
        let onSaid = onSaid
        self.onSaid = nil
        feeding?.cancel()
        feeding = nil
        synthesizer.stopSpeaking(at: .immediate)
        audio?.stop()
        audio = nil
        let pipeline = pipeline
        self.pipeline = nil
        sentencesRendering = 0
        buffersPlaying = 0
        replySource = ""
        heard = ""
        levels = []
        phase = .starting
        await pipeline?.cancel()
        if !said.isEmpty { onSaid?(said) }
    }

    private func feed(_ captured: CapturedBuffer, generation started: Int) {
        guard started == generation, !muted else { return }
        pipeline?.feed(captured.buffer)
        if let level = AudioCapture.dbfs(captured.buffer) {
            levels = Array((levels + [max(0, min(1, (level + 60) / 60))]).suffix(Self.levelsKept))
        }
        if turn.isDone(at: .now) {
            let said = turn.take()
            heard = ""
            onSaid?(said)
        }
    }

    private func receive(_ piece: TranscriptPiece, generation started: Int) {
        guard started == generation, !muted else { return }
        let spoken = !piece.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if spoken, phase == .herTurn { interrupt() }
        turn.heard(piece.text, isFinal: piece.isFinal, at: .now)
        heard = turn.text
    }

    private func interrupt() {
        speech += 1
        interrupted = true
        synthesizer.stopSpeaking(at: .immediate)
        audio?.silence()
        sentencesRendering = 0
        buffersPlaying = 0
        settlePhase()
    }

    private func say(_ sentence: String) {
        let utterance = AVSpeechUtterance(string: sentence)
        utterance.voice = AVSpeechSynthesisVoice(language: language)
        let current = speech
        sentencesRendering += 1
        phase = .herTurn
        synthesizer.write(utterance) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            let captured = CapturedBuffer(buffer: pcm, hostTime: Date())
            Task { @MainActor in self?.rendered(captured, speech: current) }
        }
    }

    private func rendered(_ captured: CapturedBuffer, speech current: Int) {
        guard current == speech, let audio else { return }
        if captured.buffer.frameLength == 0 {
            sentencesRendering = max(0, sentencesRendering - 1)
            settlePhase()
            return
        }
        buffersPlaying += 1
        audio.play(captured.buffer) { [weak self] in
            Task { @MainActor in self?.played(speech: current) }
        }
    }

    private func played(speech current: Int) {
        guard current == speech else { return }
        buffersPlaying = max(0, buffersPlaying - 1)
        settlePhase()
    }

    private func settlePhase() {
        guard audio != nil else { return }
        if sentencesRendering > 0 || buffersPlaying > 0 {
            phase = .herTurn
        } else {
            phase = muted ? .muted : .listening
        }
    }
}
#endif
