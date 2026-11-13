#if os(iOS)
@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import Speech

struct TranscriptPiece: Sendable, Equatable {
    let text: String
    let isFinal: Bool
    let start: TimeInterval
    let end: TimeInterval
    let confidence: Double
}

enum SpeechPipelineError: Error, Equatable {
    case unavailable
    case unsupportedLocale
    case noAudioFormat
}

final class SpeechPipeline: @unchecked Sendable {
    let locale: Locale
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let format: AVAudioFormat
    private let inputs: AsyncStream<AnalyzerInput>
    private let inputBuilder: AsyncStream<AnalyzerInput>.Continuation
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var resultsTask: Task<Void, Never>?

    static func make(preferred locale: Locale, sensitivity: SpeechDetector.SensitivityLevel) async throws -> SpeechPipeline {
        guard SpeechTranscriber.isAvailable else { throw SpeechPipelineError.unavailable }
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { throw SpeechPipelineError.unsupportedLocale }
        let transcriber = SpeechTranscriber(
            locale: supported,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange, .transcriptionConfidence]
        )
        let detector = SpeechDetector(detectionOptions: SpeechDetector.DetectionOptions(sensitivityLevel: sensitivity), reportResults: false)
        let modules: [any SpeechModule] = [detector, transcriber]
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else { throw SpeechPipelineError.noAudioFormat }
        return SpeechPipeline(locale: supported, transcriber: transcriber, analyzer: SpeechAnalyzer(modules: modules), format: format)
    }

    private init(locale: Locale, transcriber: SpeechTranscriber, analyzer: SpeechAnalyzer, format: AVAudioFormat) {
        self.locale = locale
        self.transcriber = transcriber
        self.analyzer = analyzer
        self.format = format
        (inputs, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingNewest(128))
    }

    func start(onPiece: @escaping @Sendable (TranscriptPiece) async -> Void) async throws {
        try await analyzer.start(inputSequence: inputs)
        let transcriber = transcriber
        resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    var total = 0.0
                    var count = 0
                    for run in result.text.runs {
                        if let value = run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] {
                            total += value
                            count += 1
                        }
                    }
                    await onPiece(TranscriptPiece(
                        text: text,
                        isFinal: result.isFinal,
                        start: result.range.start.seconds,
                        end: CMTimeRangeGetEnd(result.range).seconds,
                        confidence: count == 0 ? 0 : total / Double(count)
                    ))
                }
            } catch {
                return
            }
        }
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converted = convert(buffer) else { return }
        inputBuilder.yield(AnalyzerInput(buffer: converted))
    }

    func finish() async {
        inputBuilder.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
    }

    func cancel() async {
        inputBuilder.finish()
        await analyzer.cancelAndFinishNow()
        resultsTask?.cancel()
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format == format { return buffer }
        let converter: AVAudioConverter? = lock.withLock {
            if self.converter == nil || self.converter?.inputFormat != buffer.format {
                self.converter = AVAudioConverter(from: buffer.format, to: format)
            }
            return self.converter
        }
        guard let converter else { return nil }
        let ratio = format.sampleRate / buffer.format.sampleRate
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)) else { return nil }
        nonisolated(unsafe) var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil ? output : nil
    }
}
#endif
