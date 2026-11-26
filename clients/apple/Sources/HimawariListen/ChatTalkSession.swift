#if os(iOS)
@preconcurrency import AVFoundation
import Foundation
import HimawariChat
import HimawariCore
import HimawariListenEngine
import HimawariListenUI
import Observation

@MainActor
@Observable
public final class ChatTalkSession: ChatTalk {
    public private(set) var phase: TalkPhase = .starting
    public private(set) var heard = ""
    public private(set) var levels: [Double] = []
    public private(set) var muted = false
    public private(set) var running = false
    public private(set) var suggestsVoiceDownload = false

    @ObservationIgnored private var audio: TalkAudio?
    @ObservationIgnored private var pipeline: SpeechPipeline?
    @ObservationIgnored private var feeding: Task<Void, Never>?
    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var turn = TalkTurn()
    @ObservationIgnored private var reply = HerReply()
    @ObservationIgnored private var sentences: [SpokenSentence] = []
    @ObservationIgnored private var playback: Task<Void, Never>?
    @ObservationIgnored private var buffersPlaying = 0
    @ObservationIgnored private var policy = CloudSpeechPolicy()
    @ObservationIgnored public private(set) var timing = TalkTurnTiming()
    @ObservationIgnored private let cloudSpeech: (@Sendable (String) async throws -> CloudSpeechAudio)?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var speech = 0
    @ObservationIgnored private var onSaid: (@MainActor (_ said: String, _ messageId: String) -> Void)?
    @ObservationIgnored private let reportTiming: (@Sendable (VoiceTiming) async -> Void)?
    @ObservationIgnored private var voice: AVSpeechSynthesisVoice?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let activity = TalkActivityController()
    @ObservationIgnored private var startedAt = Date()

    private static let levelsKept = 32
    static let voiceHintShownKey = "talk.voiceHintShown"

    public init(
        defaults: UserDefaults = .standard,
        cloudSpeech: (@Sendable (String) async throws -> CloudSpeechAudio)? = nil,
        reportTiming: (@Sendable (VoiceTiming) async -> Void)? = nil
    ) {
        self.defaults = defaults
        self.cloudSpeech = cloudSpeech
        self.reportTiming = reportTiming
    }

    public func begin(onSaid: @escaping @MainActor (_ said: String, _ messageId: String) -> Void) async throws {
        await end()
        generation += 1
        let started = generation
        phase = .starting
        guard await AVAudioApplication.requestRecordPermission() else { throw ChatDictationError.microphoneDenied }
        let locale = Locale(identifier: Locale.preferredLanguages.first ?? "zh-Hans")
        chooseVoice(for: locale.identifier)
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
        policy = CloudSpeechPolicy()
        finishTiming()
        heard = ""
        muted = false
        startedAt = Date()
        running = true
        TalkCommandCenter.shared.handler = { [weak self] command in
            await self?.perform(command)
        }
        phase = .listening
        showActivity()
        feeding = Task { [weak self] in
            for await captured in audio.buffers {
                self?.feed(captured, generation: started)
            }
        }
    }

    public func herReply(_ markdown: String, finished: Bool) {
        guard audio != nil else { return }
        let spoken = reply.receive(markdown, finished: finished)
        if !spoken.isEmpty, timing.firstTextAt == nil { timing.firstTextAt = Date() }
        for sentence in spoken { say(sentence) }
    }

    public func setMuted(_ muted: Bool) {
        self.muted = muted
        if muted {
            turn.drop()
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
        finishTiming()
        feeding?.cancel()
        feeding = nil
        dropSentences()
        audio?.stop()
        audio = nil
        let pipeline = pipeline
        self.pipeline = nil
        buffersPlaying = 0
        reply = HerReply()
        heard = ""
        levels = []
        suggestsVoiceDownload = false
        let wasRunning = running
        running = false
        phase = .starting
        activity.end()
        if wasRunning { TalkCommandCenter.shared.handler = nil }
        await pipeline?.cancel()
        if !said.isEmpty { onSaid?(said, OutgoingMessage.newId()) }
    }

    private func perform(_ command: TalkCommand) async {
        guard running else { return }
        switch command {
        case .toggleMute: setMuted(!muted)
        case .end: await end()
        }
    }

    private func showActivity() {
        guard running else { return }
        let shown: TalkLivePhase = switch phase {
        case .herTurn: .speaking
        case .muted: .muted
        case .listening, .starting: muted ? .muted : .listening
        }
        activity.show(TalkLiveState(phase: shown, startedAt: startedAt))
    }

    private func chooseVoice(for language: String) {
        let installed = AVSpeechSynthesisVoice.speechVoices()
        let options = installed.map { voice in
            TalkVoiceOption(identifier: voice.identifier, language: voice.language, quality: Self.quality(voice.quality))
        }
        let pick = TalkVoices.pick(from: options, preferred: language)
        voice = pick.voice.flatMap { AVSpeechSynthesisVoice(identifier: $0.identifier) } ?? AVSpeechSynthesisVoice(language: language)
        if pick.suggestsDownload, !defaults.bool(forKey: Self.voiceHintShownKey) {
            defaults.set(true, forKey: Self.voiceHintShownKey)
            suggestsVoiceDownload = true
        } else {
            suggestsVoiceDownload = false
        }
    }

    private static func quality(_ quality: AVSpeechSynthesisVoiceQuality) -> TalkVoiceQuality {
        switch quality {
        case .premium: .premium
        case .enhanced: .enhanced
        default: .standard
        }
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
            policy.newTurn()
            finishTiming()
            let messageId = OutgoingMessage.newId()
            timing.messageId = messageId
            timing.saidAt = Date()
            onSaid?(said, messageId)
        }
    }

    private func finishTiming() {
        sendTiming()
        timing = TalkTurnTiming()
    }

    private func sendTiming() {
        guard let report = timing.report, let reportTiming else { return }
        timing.messageId = nil
        Task { await reportTiming(report) }
    }

    private func receive(_ piece: TranscriptPiece, generation started: Int) {
        guard started == generation, !muted else { return }
        let spoken = !piece.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if spoken, reply.ownerSpoke(whileSpeaking: phase == .herTurn) { interrupt() }
        turn.heard(piece.text, isFinal: piece.isFinal, from: piece.start, to: piece.end, at: .now)
        heard = turn.text
    }

    private func interrupt() {
        speech += 1
        dropSentences()
        audio?.silence()
        buffersPlaying = 0
        settlePhase()
    }

    private func dropSentences() {
        for sentence in sentences { sentence.cancel() }
        sentences = []
        playback?.cancel()
        playback = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    private func say(_ text: String) {
        let sentence = SpokenSentence(text: text)
        sentences.append(sentence)
        phase = .herTurn
        showActivity()
        if sentences.count == 1 {
            produce(sentence)
        } else if sentences.count == 2, sentences[0].playing {
            produce(sentence)
        }
        if playback == nil {
            let current = speech
            playback = Task { [weak self] in await self?.play(speech: current) }
        }
    }

    private func play(speech current: Int) async {
        while current == speech, let sentence = sentences.first {
            produce(sentence)
            for await buffer in sentence.buffers {
                guard current == speech, let audio else { return }
                if !sentence.playing {
                    sentence.playing = true
                    if sentences.count > 1 { produce(sentences[1]) }
                    if timing.firstSoundAt == nil {
                        timing.firstSoundAt = Date()
                        timing.route = sentence.route
                        sendTiming()
                    }
                }
                buffersPlaying += 1
                audio.play(buffer) { [weak self] in
                    Task { @MainActor in self?.played(speech: current) }
                }
            }
            guard current == speech else { return }
            if sentences.first === sentence { sentences.removeFirst() }
        }
        guard current == speech else { return }
        playback = nil
        settlePhase()
    }

    private func produce(_ sentence: SpokenSentence) {
        guard sentence.producer == nil else { return }
        let route: SpeechRoute = cloudSpeech == nil ? .local : policy.route(sentence.text)
        sentence.route = route
        let current = speech
        sentence.producer = Task { [weak self] in
            defer { sentence.finish() }
            guard let self else { return }
            if route == .cloud, await self.streamCloud(sentence, speech: current) { return }
            guard !Task.isCancelled, current == self.speech else { return }
            sentence.route = .local
            await self.streamLocal(sentence)
        }
    }

    private func streamCloud(_ sentence: SpokenSentence, speech current: Int) async -> Bool {
        guard let cloudSpeech else { return false }
        let text = sentence.text
        let pump = Task { @MainActor [weak self] () -> CloudOutcome in
            do {
                let audio = try await cloudSpeech(text)
                guard let format = AVAudioFormat(standardFormatWithSampleRate: audio.sampleRate, channels: 1) else { return .failed(nil) }
                var decoder = PCM16Decoder()
                for try await chunk in audio.chunks {
                    let samples = decoder.samples(chunk)
                    guard let buffer = Self.buffer(samples, format: format) else { continue }
                    if !sentence.hasAudio, let self, current == self.speech, self.timing.serverFirstAudioMs == nil {
                        self.timing.serverFirstAudioMs = audio.firstAudioMs
                    }
                    sentence.yield(buffer)
                }
                return sentence.hasAudio ? .finished : .failed(nil)
            } catch let DeviceAPIError.server(status, _, _, _) {
                return .failed(status)
            } catch {
                return .failed(nil)
            }
        }
        let watchdog = Task { @MainActor in
            try? await Task.sleep(for: CloudSpeechPolicy.firstAudioDeadline)
            if !Task.isCancelled, !sentence.hasAudio { pump.cancel() }
        }
        let outcome = await withTaskCancellationHandler {
            await pump.value
        } onCancel: {
            pump.cancel()
        }
        watchdog.cancel()
        guard case let .failed(status) = outcome else { return true }
        if current == speech, !Task.isCancelled { policy.failed(status: status) }
        return sentence.hasAudio
    }

    private func streamLocal(_ sentence: SpokenSentence) async {
        let utterance = AVSpeechUtterance(string: sentence.text)
        utterance.voice = voice
        let once = ResumeOnce()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                once.arm(done)
                synthesizer.write(utterance) { buffer in
                    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                    let captured = CapturedBuffer(buffer: pcm, hostTime: Date())
                    Task { @MainActor in
                        if captured.buffer.frameLength == 0 {
                            once.resume()
                        } else {
                            sentence.yield(captured.buffer)
                        }
                    }
                }
            }
        } onCancel: {
            once.resume()
        }
    }

    private static func buffer(_ samples: [Float], format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        samples.withUnsafeBufferPointer { source in
            channel.update(from: source.baseAddress!, count: samples.count)
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        return buffer
    }

    private func played(speech current: Int) {
        guard current == speech else { return }
        buffersPlaying = max(0, buffersPlaying - 1)
        settlePhase()
    }

    private func settlePhase() {
        guard audio != nil else { return }
        if !sentences.isEmpty || buffersPlaying > 0 {
            phase = .herTurn
        } else {
            phase = muted ? .muted : .listening
        }
        showActivity()
    }
}
private enum CloudOutcome: Sendable {
    case finished
    case failed(Int?)
}

@MainActor
private final class SpokenSentence {
    let text: String
    let buffers: AsyncStream<AVAudioPCMBuffer>
    private let continuation: AsyncStream<AVAudioPCMBuffer>.Continuation
    var producer: Task<Void, Never>?
    var route: SpeechRoute?
    var playing = false
    private(set) var hasAudio = false

    init(text: String) {
        self.text = text
        let (buffers, continuation) = AsyncStream<AVAudioPCMBuffer>.makeStream()
        self.buffers = buffers
        self.continuation = continuation
    }

    func yield(_ buffer: AVAudioPCMBuffer) {
        hasAudio = true
        continuation.yield(buffer)
    }

    func finish() {
        continuation.finish()
    }

    func cancel() {
        producer?.cancel()
        continuation.finish()
    }
}

private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var resumed = false

    func arm(_ continuation: CheckedContinuation<Void, Never>) {
        let resumeNow = lock.withLock { () -> Bool in
            if resumed { return true }
            self.continuation = continuation
            return false
        }
        if resumeNow { continuation.resume() }
    }

    func resume() {
        let pending = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            resumed = true
            defer { continuation = nil }
            return continuation
        }
        pending?.resume()
    }
}
#endif
