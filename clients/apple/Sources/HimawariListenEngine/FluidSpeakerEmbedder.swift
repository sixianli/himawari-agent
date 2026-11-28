#if os(iOS) || os(macOS)
import FluidAudio
import Foundation
import HimawariCore

package actor FluidSpeakerEmbedder: SpeakerEmbedder {
    package nonisolated let model = "fluidaudio-wespeaker-0.18.3"
    package static let sampleRate: Double = 16_000
    package static let minimumSeconds: Double = 1
    package static let bundledModelNames = [ModelNames.Diarizer.segmentationFile, ModelNames.Diarizer.embeddingFile]

    private var manager: DiarizerManager?
    private var loading: Task<DiarizerModels, Error>?

    package init() {}

    package enum Failure: Error {
        case tooShort
        case wrongSampleRate
        case notReady
        case modelMissing(String)
    }

    package static func bundledModelURL(_ name: String) throws -> URL {
        guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "SpeakerModels") else {
            throw Failure.modelMissing(name)
        }
        return url
    }

    package func prepare() async throws {
        if manager != nil { return }
        let task = loading ?? Task.detached(priority: .userInitiated) {
            try DiarizerModels.load(
                localSegmentationModel: try Self.bundledModelURL(ModelNames.Diarizer.segmentationFile),
                localEmbeddingModel: try Self.bundledModelURL(ModelNames.Diarizer.embeddingFile)
            )
        }
        loading = task
        do {
            let models = try await task.value
            if manager == nil {
                let created = DiarizerManager()
                created.initialize(models: models)
                manager = created
            }
        } catch {
            loading = nil
            throw error
        }
    }

    package func embedding(samples: [Float], sampleRate: Double) async throws -> [Float] {
        guard sampleRate == Self.sampleRate else { throw Failure.wrongSampleRate }
        guard Double(samples.count) >= Self.minimumSeconds * sampleRate else { throw Failure.tooShort }
        try await prepare()
        guard let manager else { throw Failure.notReady }
        return try manager.extractSpeakerEmbedding(from: samples)
    }
}
#endif
