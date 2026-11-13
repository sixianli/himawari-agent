#if os(iOS) || os(macOS)
@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import Speech

package struct TranscriptPiece: Sendable, Equatable {
    package let text: String
    package let isFinal: Bool
    package let start: TimeInterval
    package let end: TimeInterval
    package let confidence: Double
}

package enum SpeechEngine: String, Sendable, CaseIterable {
    case transcriber
    case dictation
}

package enum SpeechPipelineError: Error, Equatable {
    case unavailable
    case unsupportedLocale
    case noAudioFormat
}

package final class SpeechPipeline: @unchecked Sendable {
    package typealias PieceHandler = @Sendable (TranscriptPiece) async -> Void
    package let locale: Locale
    package let engine: SpeechEngine
    private let drain: @Sendable (@escaping PieceHandler) async throws -> Void
    private let analyzer: SpeechAnalyzer
    private let format: AVAudioFormat
    private let inputs: AsyncStream<AnalyzerInput>
    private let inputBuilder: AsyncStream<AnalyzerInput>.Continuation
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var resultsTask: Task<Void, Never>?

    package static func make(preferred locale: Locale, sensitivity: SpeechDetector.SensitivityLevel, engine: SpeechEngine = .transcriber, farField: Bool = false) async throws -> SpeechPipeline {
        let detector = SpeechDetector(detectionOptions: SpeechDetector.DetectionOptions(sensitivityLevel: sensitivity), reportResults: false)
        let supported: Locale
        let module: any SpeechModule
        let drain: @Sendable (@escaping PieceHandler) async throws -> Void
        switch engine {
        case .transcriber:
            guard SpeechTranscriber.isAvailable else { throw SpeechPipelineError.unavailable }
            guard let found = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { throw SpeechPipelineError.unsupportedLocale }
            let transcriber = SpeechTranscriber(
                locale: found,
                transcriptionOptions: [],
                reportingOptions: [.volatileResults],
                attributeOptions: [.audioTimeRange, .transcriptionConfidence]
            )
            supported = found
            module = transcriber
            drain = { handle in
                for try await result in transcriber.results {
                    await handle(Self.piece(text: result.text, isFinal: result.isFinal, range: result.range))
                }
            }
        case .dictation:
            guard let found = await DictationTranscriber.supportedLocale(equivalentTo: locale) else { throw SpeechPipelineError.unsupportedLocale }
            let dictation = DictationTranscriber(
                locale: found,
                contentHints: farField ? [.farField] : [],
                transcriptionOptions: [],
                reportingOptions: [.volatileResults],
                attributeOptions: [.audioTimeRange, .transcriptionConfidence]
            )
            supported = found
            module = dictation
            drain = { handle in
                for try await result in dictation.results {
                    await handle(Self.piece(text: result.text, isFinal: result.isFinal, range: result.range))
                }
            }
        }
        let modules: [any SpeechModule] = [detector, module]
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else { throw SpeechPipelineError.noAudioFormat }
        return SpeechPipeline(locale: supported, engine: engine, drain: drain, analyzer: SpeechAnalyzer(modules: modules), format: format)
    }

    private init(locale: Locale, engine: SpeechEngine, drain: @escaping @Sendable (@escaping PieceHandler) async throws -> Void, analyzer: SpeechAnalyzer, format: AVAudioFormat) {
        self.locale = locale
        self.engine = engine
        self.drain = drain
        self.analyzer = analyzer
        self.format = format
        (inputs, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingNewest(128))
    }

    static func piece(text: AttributedString, isFinal: Bool, range: CMTimeRange) -> TranscriptPiece {
        var total = 0.0
        var count = 0
        for run in text.runs {
            if let value = run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] {
                total += value
                count += 1
            }
        }
        return TranscriptPiece(
            text: String(text.characters),
            isFinal: isFinal,
            start: range.start.seconds,
            end: CMTimeRangeGetEnd(range).seconds,
            confidence: count == 0 ? 0 : total / Double(count)
        )
    }

    package func start(onPiece: @escaping PieceHandler) async throws {
        try await analyzer.start(inputSequence: inputs)
        let drain = drain
        resultsTask = Task {
            try? await drain(onPiece)
        }
    }

    package func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converted = convert(buffer) else { return }
        inputBuilder.yield(AnalyzerInput(buffer: converted))
    }

    package func finish() async {
        inputBuilder.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
    }

    package func cancel() async {
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
