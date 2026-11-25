import Foundation
import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariListenUI
import Observation
#if os(iOS)
@preconcurrency import AVFoundation
import HimawariListenEngine
import Speech
import UIKit
#endif

public enum EnrollmentState: Equatable {
    case idle
    case recording(EnrollmentProgress)
    case failed
}

@MainActor
@Observable
public final class ListeningController {
    public private(set) var session = ListeningSession()
    public private(set) var live: ListenLiveState?
    public private(set) var levels: [Double] = VoiceLevels.resting
    public private(set) var enrollment: EnrollmentState = .idle
    public private(set) var hasVoiceprint = false
    public private(set) var problem: String?
    public var introShown = false
    public var recordingKitOpen = false

    @ObservationIgnored private let api: DeviceAPI
    @ObservationIgnored private let chat: ChatStore
    @ObservationIgnored private let voiceprints: VoiceprintStore
    @ObservationIgnored private var flow: UtteranceFlow
    @ObservationIgnored private var meter: ListeningBatteryMeter
    @ObservationIgnored private var limits: ListeningLimits?
    @ObservationIgnored private var voiceprint: Voiceprint?
    @ObservationIgnored private var pendingAsk: (message: SpokenMessage, heard: String)?
    @ObservationIgnored private var unsent: [SpeechUtteranceUpload] = []
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var enrollmentDraft: VoiceprintEnrollment?
    @ObservationIgnored private let policy: ListeningPolicy
    @ObservationIgnored private var utteranceOpen = false
    @ObservationIgnored private var touchPending = false
    #if os(iOS)
    @ObservationIgnored private var capture: AudioCapture?
    @ObservationIgnored private var pipeline: SpeechPipeline?
    @ObservationIgnored private let window = SpeakerAudioWindow(seconds: 30)
    @ObservationIgnored private let embedder = FluidSpeakerEmbedder()
    @ObservationIgnored private let inEar = InEarMonitor()
    @ObservationIgnored private let reader = SpokenReplyReader()
    @ObservationIgnored private let activity = ListenActivityController()
    @ObservationIgnored private let notices = ListenNotifications()
    #endif

    public static let usageEvery: Duration = .seconds(300)
    public static let powerEvery: Duration = .seconds(60)

    public init(api: DeviceAPI, chat: ChatStore, voiceprints: VoiceprintStore = ListeningController.defaultVoiceprintStore(), names: [String] = ListeningController.bundledNames(), policy: ListeningPolicy = .designed) {
        self.api = api
        self.chat = chat
        self.voiceprints = voiceprints
        self.policy = policy
        session = ListeningSession(policy: policy)
        flow = UtteranceFlow(names: NameCall(names: names))
        meter = ListeningBatteryMeter(day: Self.day(Date()))
        voiceprint = try? voiceprints.load()
        hasVoiceprint = voiceprint != nil
        ListenCommandCenter.shared.handler = { [weak self] command in
            await self?.perform(command)
        }
    }

    public static func defaultVoiceprintStore() -> VoiceprintStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return FileVoiceprintStore(url: base.appendingPathComponent("listening/voiceprint.json"))
    }

    public static func bundledNames() -> [String] {
        #if os(iOS)
        ListenResources.names()
        #else
        []
        #endif
    }

    static func day(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    public var isListening: Bool {
        if case .listening = session.state { return true }
        if case .interrupted = session.state { return true }
        return false
    }

    public func perform(_ command: ListenCommand) async {
        switch command {
        case .pause: pauseOneHour()
        case .stop: stop()
        case .resume: await start()
        case .notMe: notMe()
        case .itsMe: await itsMe()
        case .openRecordingKit:
            if isListening { stop() }
            recordingKitOpen = true
        }
    }

    public func start() async {
        problem = nil
        #if os(iOS)
        do {
            await notices.prepare()
            capture?.stop(deactivate: true)
            let capture = AudioCapture()
            self.capture = capture
            try capture.configureSession()
            try await startPipeline(capture)
            let now = Date()
            apply(session.handle(.ownerStarted(at: now)), at: now)
            observe(capture)
            schedulePeriodicWork()
            activity.start(state: liveState(phase: .listening, at: now))
            Task { try? await embedder.prepare() }
        } catch {
            problem = String(describing: error)
            capture?.stop(deactivate: true)
        }
        #endif
    }

    public func stop() {
        let now = Date()
        apply(session.handle(.ownerStopped(at: now)), at: now)
        tearDown()
    }

    public func pauseOneHour() {
        stop()
        #if os(iOS)
        let until = Date().addingTimeInterval(3600)
        notices.schedulePauseEnded(at: until)
        #endif
    }

    public func listenForCommand() {
        touchPending = true
        utteranceOpen = false
    }

    public func notMe() {
        pendingAsk = nil
        returnToListening()
    }

    public func itsMe() async {
        #if os(iOS)
        guard let pending = pendingAsk else { return }
        pendingAsk = nil
        let touched = SpokenMessage(
            message: pending.message.message,
            utteranceId: pending.message.utteranceId,
            voice: VoiceEvidence(trigger: .handsOn, speakerScore: pending.message.voice.speakerScore, inputRoute: pending.message.voice.inputRoute, inEar: pending.message.voice.inEar, loudnessScore: pending.message.voice.loudnessScore)
        )
        await deliver(touched, heard: pending.heard)
        #endif
    }

    public func deleteVoiceprint() {
        try? voiceprints.delete()
        voiceprint = nil
        hasVoiceprint = false
    }

    public func beginEnrollment() {
        let draft = VoiceprintEnrollment(prompts: ListenText.enrollmentPrompts())
        enrollmentDraft = draft
        enrollment = .recording(EnrollmentProgress(index: 0, total: draft.prompts.count, prompt: draft.prompts[0], levels: Array(VoiceLevels.resting.prefix(27))))
    }

    public func skipEnrollment() {
        enrollmentDraft = nil
        enrollment = .idle
    }

    private func apply(_ transition: ListeningTransition, at now: Date) {
        if let haptic = transition.haptic {
            Haptics.shared.report(haptic)
        }
        if let notice = transition.notice {
            #if os(iOS)
            notices.post(notice, policy: policy, now: now)
            #endif
        }
        switch transition.state {
        case let .listening(since, mode, _):
            live = live.map { current in
                var next = current
                next.nameOnly = mode == .nameOnly
                return next
            } ?? liveState(phase: .listening, at: since)
        case .interrupted:
            live?.phase = .paused
        case .waitingForOwner, .stopped, .off:
            live = nil
            tearDown()
        }
        #if os(iOS)
        if let live { activity.update(live) }
        #endif
    }

    private func liveState(phase: ListenPhase, at now: Date) -> ListenLiveState {
        var since = now
        if case let .listening(started, _, _) = session.state { since = started }
        #if os(iOS)
        let route = capture?.currentRoute ?? .deviceMicrophone
        #else
        let route = AudioInputRoute.deviceMicrophone
        #endif
        return ListenLiveState(phase: phase, startedAt: since, source: route)
    }

    private func tearDown() {
        for task in tasks { task.cancel() }
        tasks.removeAll()
        #if os(iOS)
        capture?.stop(deactivate: true)
        capture = nil
        inEar.stop()
        reader.stop()
        let pipeline = pipeline
        self.pipeline = nil
        Task { await pipeline?.finish() }
        activity.end()
        #endif
        live = nil
    }

    private func returnToListening() {
        guard var live else { return }
        live.phase = .listening
        live.heard = ""
        live.heardTail = ""
        live.askReason = nil
        self.live = live
        #if os(iOS)
        activity.update(live)
        #endif
    }

    #if os(iOS)
    private func startPipeline(_ capture: AudioCapture) async throws {
        let locale = Locale(identifier: Locale.preferredLanguages.first ?? "zh-Hans")
        let created = try await SpeechPipeline.make(preferred: locale, sensitivity: .medium)
        window.reset(at: 0)
        try await created.start { [weak self] piece in
            await self?.receive(piece)
        }
        pipeline = created
        try capture.start()
    }

    private func observe(_ capture: AudioCapture) {
        tasks.append(Task { [weak self] in
            for await captured in capture.buffers {
                guard let self else { return }
                await self.feed(captured)
            }
        })
        tasks.append(Task { [weak self] in
            for await event in capture.events {
                guard let self else { return }
                await self.handle(event)
            }
        })
    }

    private func feed(_ captured: CapturedBuffer) {
        guard session.isCapturing else { return }
        pipeline?.feed(captured.buffer)
        window.append(captured.buffer)
        if live?.phase == .calling || enrollmentDraft != nil, let level = AudioCapture.dbfs(captured.buffer) {
            let unit = max(0, min(1, (level + 60) / 60))
            levels = Array((levels + [unit]).suffix(levels.count))
        }
    }

    private func handle(_ event: CaptureEvent) async {
        let now = Date()
        switch event {
        case .interruptionBegan:
            apply(session.handle(.interruptionBegan(at: now)), at: now)
        case let .interruptionEnded(shouldResume):
            if shouldResume {
                do {
                    try capture?.restart()
                    apply(session.handle(.interruptionEnded(at: now, systemSuggestsResume: true)), at: now)
                } catch {
                    apply(session.handle(.resumeFailed(at: now)), at: now)
                }
            } else {
                apply(session.handle(.interruptionEnded(at: now, systemSuggestsResume: false)), at: now)
            }
        case let .routeChanged(route):
            if route == .airpods { inEar.start() } else { inEar.stop() }
            if var live {
                live.source = route.rawValue
                self.live = live
                activity.update(live)
            }
        case .mediaServicesReset:
            apply(session.handle(.resumeFailed(at: now)), at: now)
        }
    }

    private func openUtterance(at now: Date) {
        guard !utteranceOpen else { return }
        flow.begin(touchPending ? .ownerTouched : .heard, at: now)
        touchPending = false
        utteranceOpen = true
    }

    private func receive(_ piece: TranscriptPiece) async {
        let now = Date()
        if enrollmentDraft != nil {
            if piece.isFinal { await enroll(start: piece.start, end: piece.end) }
            return
        }
        openUtterance(at: now)
        if !piece.isFinal {
            for step in flow.partial(piece.text, at: now) {
                switch step {
                case .heardName:
                    Haptics.shared.report(.heardName)
                    showCalling(heard: "", tail: "")
                case let .prepare(utteranceId, text):
                    showCalling(heard: text, tail: "")
                    Task { [api] in _ = try? await api.prepare(utteranceId: utteranceId, partialText: text) }
                }
            }
            return
        }
        guard case let .listening(_, mode, _) = session.state else { return }
        let route = capture?.currentRoute ?? .deviceMicrophone
        let samples = window.slice(from: piece.start, to: piece.end)
        let score = await ownerScore(samples)
        let loudness = VoiceScore.loudness(dbfs: SpeechLevel.dbfs(samples: samples, sampleRate: FluidSpeakerEmbedder.sampleRate) ?? SpeechLevel.silence)
        let speech = HeardSpeech(
            text: piece.text,
            startedAt: now.addingTimeInterval(-(piece.end - piece.start)),
            duration: piece.end - piece.start,
            language: pipeline?.locale.identifier(.bcp47),
            confidence: piece.confidence,
            source: route,
            ownerScore: score
        )
        let result = flow.finish(speech, mode: mode, at: now)
        utteranceOpen = false
        switch result {
        case let .command(request, heard, touched, heardName):
            await upload(heard)
            let context: CommandTriggerContext = touched
                ? .ownerTouched
                : .heardName(route: route, inEar: route == .airpods ? HeadphoneWear.worn(motionFresh: inEar.inEar(), playsThroughSameHeadset: capture?.playsThroughSameHeadset ?? false) : nil, loudnessScore: loudness)
            await command(request, heard: heard, evidence: SpokenTrigger.evidence(for: context, speakerScore: score, heardName: heardName))
        case let .calledOnly(heard):
            await upload(heard)
        case let .record(heard):
            await upload(heard)
        case .nothing:
            break
        }
    }

    private func enroll(start: TimeInterval, end: TimeInterval) async {
        guard var draft = enrollmentDraft else { return }
        let samples = window.slice(from: start, to: end)
        guard let embedding = try? await embedder.embedding(samples: samples, sampleRate: FluidSpeakerEmbedder.sampleRate) else { return }
        draft.add(embedding)
        if let next = draft.currentIndex {
            enrollmentDraft = draft
            enrollment = .recording(EnrollmentProgress(index: next, total: draft.prompts.count, prompt: draft.prompts[next], levels: Array(levels.suffix(27))))
            return
        }
        enrollmentDraft = nil
        guard let made = draft.voiceprint(model: embedder.model, at: Date()) else {
            enrollment = .failed
            return
        }
        do {
            try voiceprints.save(made)
            voiceprint = made
            hasVoiceprint = true
            enrollment = .idle
        } catch {
            enrollment = .failed
        }
    }

    private func ownerScore(_ samples: [Float]) async -> Int? {
        guard let voiceprint else { return nil }
        guard let embedding = try? await embedder.embedding(samples: samples, sampleRate: FluidSpeakerEmbedder.sampleRate) else { return nil }
        return voiceprint.score(embedding, model: embedder.model)
    }

    private func showCalling(heard: String, tail: String) {
        guard var live else { return }
        live.phase = .calling
        live.heard = heard
        live.heardTail = tail
        self.live = live
        activity.update(live)
    }

    private func upload(_ heard: HeardUtterance) async {
        unsent.append(SpeechUtteranceUpload(heard, textLimit: nil))
        let batch = unsent
        do {
            let result = try await api.upload(heard: batch)
            unsent.removeAll { result.outcomes[$0.id] != nil }
            let now = Date()
            switch result.refusal {
            case .dailyAudioLimit:
                let resumesAt = (try? await api.listeningLimits())?.audio?.resetsAt ?? now
                apply(session.handle(.audioLimitReached(at: now, resumesAt: resumesAt)), at: now)
            case let .some(reason):
                apply(session.handle(.serverRefused(reason, at: now, resumesAt: nil)), at: now)
            case .none:
                break
            }
        } catch {
            return
        }
    }

    private func command(_ request: String, heard: HeardUtterance, evidence: VoiceEvidence) async {
        do {
            let created = try await api.createThread(requestId: OutgoingMessage.newId(), answerLocale: .matching(preferredLanguages: Locale.preferredLanguages))
            let message = OutgoingMessage(threadId: created.threadId, expectedRevision: created.threadRevision, text: request, createdAt: Date())
            await deliver(SpokenMessage(message: message, utteranceId: heard.utteranceId, voice: evidence), heard: request)
        } catch {
            returnToListening()
        }
    }

    private func deliver(_ spoken: SpokenMessage, heard: String) async {
        do {
            switch try await api.send(spoken) {
            case .sent:
                returnToListening()
                await readReply(threadId: spoken.message.threadId)
            case let .askFirst(reason) where !reason.asksOwner:
                returnToListening()
            case let .askFirst(reason):
                pendingAsk = (spoken, heard)
                guard var live else { return }
                live.phase = .asking
                live.heard = heard
                live.askReason = reason.rawValue
                self.live = live
                activity.update(live)
                notices.ask(heard: heard, reason: reason, onAirPods: spoken.voice.inputRoute == .airpods)
                if spoken.voice.inputRoute == .airpods { reader.say(ListenText.askQuestion) }
            }
        } catch {
            returnToListening()
        }
    }

    private func readReply(threadId: String) async {
        chat.watch(threadId)
        chat.prefetch(threadId)
        reader.reset(language: Locale.preferredLanguages.first)
        var seen = false
        var last = ""
        let deadline = Date().addingTimeInterval(300)
        while Date() < deadline, !Task.isCancelled {
            if let text = chat.streamingText(in: threadId) {
                seen = true
                last = text
                reader.grow(text)
            } else if seen {
                break
            }
            try? await Task.sleep(for: .milliseconds(150))
        }
        reader.finish(last)
    }

    private func schedulePeriodicWork() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkPower()
                try? await Task.sleep(for: Self.powerEvery)
            }
        })
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncUsage()
                try? await Task.sleep(for: Self.usageEvery)
            }
        })
    }

    private func checkPower() {
        let device = UIDevice.current
        let level: Double? = device.batteryLevel < 0 ? nil : Double(device.batteryLevel)
        let charging = device.batteryState == .charging || device.batteryState == .full
        let hot = [.serious, .critical].contains(ProcessInfo.processInfo.thermalState)
        let now = Date()
        meter.sample(level: level, charging: charging, listening: session.isCapturing, day: Self.day(now))
        let spent = limits?.batterySpent(usedPercent: meter.usedPercent) ?? false
        apply(session.handle(.power(batteryPercent: level.map { Int(($0 * 100).rounded()) }, charging: charging, hot: hot, budgetSpent: spent)), at: now)
    }

    private func syncUsage() async {
        try? await api.reportListeningBattery(usedPercent: meter.usedPercent)
        guard let fetched = try? await api.listeningLimits() else { return }
        limits = fetched
        if fetched.audioSpent {
            let now = Date()
            apply(session.handle(.audioLimitReached(at: now, resumesAt: fetched.audio?.resetsAt ?? now)), at: now)
        }
    }
    #endif
}
