#if os(iOS) || os(macOS)
import FluidAudio
import Foundation
import HimawariCore

package actor FluidSpeakerEmbedder: SpeakerEmbedder {
    package nonisolated let model = "fluidaudio-wespeaker-0.18.3"
    package static let sampleRate: Double = 16_000
    package static let minimumSeconds: Double = 1

    private var manager: DiarizerManager?

    package init() {}

    enum Failure: Error {
        case tooShort
        case wrongSampleRate
    }

    package func prepare() async throws {
        guard manager == nil else { return }
        let models = try await DiarizerModels.downloadIfNeeded()
        let created = DiarizerManager()
        created.initialize(models: models)
        manager = created
    }

    package func embedding(samples: [Float], sampleRate: Double) async throws -> [Float] {
        guard sampleRate == Self.sampleRate else { throw Failure.wrongSampleRate }
        guard Double(samples.count) >= Self.minimumSeconds * sampleRate else { throw Failure.tooShort }
        try await prepare()
        guard let manager else { throw Failure.tooShort }
        return try manager.extractSpeakerEmbedding(from: samples)
    }
}
#endif
