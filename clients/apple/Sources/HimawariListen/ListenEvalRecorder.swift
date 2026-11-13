#if os(iOS)
@preconcurrency import AVFoundation
import Foundation
import HimawariCore
import Observation
import UIKit

@MainActor
@Observable
package final class ListenEvalRecorder {
    package enum Phase: Equatable {
        case ready
        case recording(since: Date)
        case failed(String)
    }

    package let kit: ListenEvalKit
    package let folder: URL
    package private(set) var session: ListenEvalSession
    package private(set) var phase: Phase = .ready
    package private(set) var currentId: String?
    package private(set) var level: Double = 0
    package private(set) var route: AudioInputRoute = .deviceMicrophone

    @ObservationIgnored private var capture: AudioCapture?
    @ObservationIgnored private var writer: Task<Void, Never>?
    @ObservationIgnored private var file: EvalAudioFile?
    @ObservationIgnored private let inEar = InEarMonitor()

    package static func defaultFolder() -> URL {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return documents.appendingPathComponent("listen-eval", isDirectory: true)
    }

    package init(kit: ListenEvalKit, folder: URL = ListenEvalRecorder.defaultFolder()) {
        self.kit = kit
        self.folder = folder
        let manifest = folder.appendingPathComponent(ListenEvalSession.manifestName)
        let stored = (try? Data(contentsOf: manifest)).flatMap { try? ListenEvalSession.decode($0) }
        if let stored, stored.kitVersion == kit.version {
            session = stored
        } else {
            session = ListenEvalSession(kitVersion: kit.version, device: Self.deviceModel(), system: UIDevice.current.systemVersion)
        }
        currentId = session.nextPrompt(in: kit)?.prompt.id
    }

    package var flatPrompts: [ListenEvalPrompt] {
        kit.stages.flatMap(\.prompts)
    }

    package var currentPrompt: ListenEvalPrompt? {
        currentId.flatMap { id in flatPrompts.first { $0.id == id } }
    }

    package var currentStage: ListenEvalStage? {
        currentId.flatMap { kit.stage(containing: $0) }
    }

    package var recordedCount: Int {
        session.recordings.count
    }

    package var isRecording: Bool {
        if case .recording = phase { return true }
        return false
    }

    package var routeMismatch: Bool {
        guard let stage = currentStage else { return false }
        return (stage.placement == .airpods) != (route == .airpods)
    }

    package func refreshRoute() {
        route = AudioCapture.route(of: AVAudioSession.sharedInstance().currentRoute)
    }

    package func start() {
        guard !isRecording, let prompt = currentPrompt else { return }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let capture = AudioCapture()
            try capture.configureSession()
            route = capture.currentRoute
            if route == .airpods { inEar.start() }
            let url = folder.appendingPathComponent(ListenEvalSession.fileName(for: prompt.id))
            try? FileManager.default.removeItem(at: url)
            let format = capture.inputFormat
            let file = try EvalAudioFile(AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false))
            try capture.start()
            self.capture = capture
            self.file = file
            phase = .recording(since: Date())
            writer = Task.detached { [weak self] in
                for await captured in capture.buffers {
                    file.write(captured.buffer)
                    let level = AudioCapture.dbfs(captured.buffer).map { max(0, min(1, ($0 + 60) / 60)) } ?? 0
                    await self?.show(level: level)
                }
            }
        } catch {
            capture?.stop(deactivate: true)
            capture = nil
            file = nil
            inEar.stop()
            phase = .failed(error.localizedDescription)
        }
    }

    package func stop() async {
        guard case let .recording(since) = phase, let prompt = currentPrompt, let capture else { return }
        let inEarNow = route == .airpods ? HeadphoneWear.worn(motionFresh: inEar.inEar(), playsThroughSameHeadset: capture.playsThroughSameHeadset) : nil
        capture.stop(deactivate: true)
        writer?.cancel()
        await writer?.value
        writer = nil
        self.capture = nil
        inEar.stop()
        let seconds = file?.close() ?? 0
        file = nil
        level = 0
        session.record(ListenEvalRecording(
            promptId: prompt.id,
            file: ListenEvalSession.fileName(for: prompt.id),
            route: route,
            inEar: inEarNow,
            recordedAt: since,
            seconds: seconds
        ))
        save()
        currentId = next(after: prompt.id, skippingRecorded: true)
        phase = .ready
    }

    package func skip() {
        guard !isRecording, let id = currentId else { return }
        currentId = next(after: id, skippingRecorded: false)
    }

    package func previous() {
        guard !isRecording else { return }
        let prompts = flatPrompts
        guard let id = currentId, let index = prompts.firstIndex(where: { $0.id == id }) else {
            currentId = prompts.last?.id
            return
        }
        guard index > 0 else { return }
        currentId = prompts[index - 1].id
    }

    package func clearFailure() {
        if case .failed = phase { phase = .ready }
    }

    private func next(after id: String, skippingRecorded: Bool) -> String? {
        let prompts = flatPrompts
        guard let index = prompts.firstIndex(where: { $0.id == id }) else { return nil }
        let later = prompts[(index + 1)...]
        if skippingRecorded {
            return later.first { session.recording(for: $0.id) == nil }?.id ?? session.nextPrompt(in: kit)?.prompt.id
        }
        return later.first?.id
    }

    private func show(level: Double) {
        self.level = level
    }

    private func save() {
        guard let data = try? session.encoded() else { return }
        try? data.write(to: folder.appendingPathComponent(ListenEvalSession.manifestName), options: .atomic)
    }

    private static func deviceModel() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}

final class EvalAudioFile: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?

    init(_ file: AVAudioFile) {
        self.file = file
    }

    func write(_ buffer: AVAudioPCMBuffer) {
        lock.withLock { try? file?.write(from: buffer) }
    }

    func close() -> Double {
        lock.withLock {
            let seconds = file.map { Double($0.length) / $0.processingFormat.sampleRate } ?? 0
            file = nil
            return seconds
        }
    }
}
#endif
