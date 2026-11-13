#if os(iOS)
import FluidAudio
import Foundation
import HimawariCore

actor FluidSpeakerEmbedder: SpeakerEmbedder {
    nonisolated let model = "fluidaudio-wespeaker-0.18.3"
    static let minimumSeconds: Double = 1

    private var manager: DiarizerManager?

    enum Failure: Error {
        case tooShort
        case wrongSampleRate
    }

    func prepare() async throws {
        guard manager == nil else { return }
        let models = try await DiarizerModels.downloadIfNeeded()
        let created = DiarizerManager()
        created.initialize(models: models)
        manager = created
    }

    func embedding(samples: [Float], sampleRate: Double) async throws -> [Float] {
        guard sampleRate == SpeakerAudioWindow.sampleRate else { throw Failure.wrongSampleRate }
        guard Double(samples.count) >= Self.minimumSeconds * sampleRate else { throw Failure.tooShort }
        try await prepare()
        guard let manager else { throw Failure.tooShort }
        return try manager.extractSpeakerEmbedding(from: samples)
    }
}
#endif
