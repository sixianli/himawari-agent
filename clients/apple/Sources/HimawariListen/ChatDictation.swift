#if os(iOS)
@preconcurrency import AVFoundation
import Foundation
import HimawariChat
import HimawariCore
import HimawariListenEngine

public enum ChatDictationError: Error {
    case microphoneDenied
}

@MainActor
public final class ChatDictation: ChatVoiceInput {
    private var capture: AudioCapture?
    private var pipeline: SpeechPipeline?
    private var feeding: Task<Void, Never>?
    private var settled = ""
    private var pending = ""
    private var onText: (@MainActor (String) -> Void)?
    private var generation = 0

    public init() {}

    private var current: String { settled + pending }

    public func start(onText: @escaping @MainActor (String) -> Void) async throws {
        await cancel()
        generation += 1
        let started = generation
        guard await AVAudioApplication.requestRecordPermission() else { throw ChatDictationError.microphoneDenied }
        settled = ""
        pending = ""
        self.onText = onText
        let capture = AudioCapture()
        try capture.configureSession()
        let locale = Locale(identifier: Locale.preferredLanguages.first ?? "zh-Hans")
        let pipeline = try await SpeechPipeline.make(preferred: locale, sensitivity: .medium, engine: .dictation)
        guard started == generation else {
            capture.stop(deactivate: true)
            return
        }
        try await pipeline.start { [weak self] piece in
            await self?.receive(piece, generation: started)
        }
        try capture.start()
        self.capture = capture
        self.pipeline = pipeline
        feeding = Task {
            for await captured in capture.buffers {
                pipeline.feed(captured.buffer)
            }
        }
    }

    private func receive(_ piece: TranscriptPiece, generation started: Int) {
        guard started == generation else { return }
        if piece.isFinal {
            settled += piece.text
            pending = ""
        } else {
            pending = piece.text
        }
        onText?(current)
    }

    public func finish() async -> String {
        let pipeline = pipeline
        stopCapture()
        await pipeline?.finish()
        let said = current
        onText = nil
        generation += 1
        return said
    }

    private func stopCapture() {
        capture?.stop(deactivate: true)
        capture = nil
        feeding?.cancel()
        feeding = nil
        pipeline = nil
    }
}
#endif
