#if os(iOS)
@preconcurrency import AVFoundation
import Foundation
import HimawariCore

@MainActor
final class SpokenReplyReader {
    private let synthesizer = AVSpeechSynthesizer()
    private var reader = SentenceReader()
    private var language: String?

    init() {
        synthesizer.usesApplicationAudioSession = true
    }

    var isSpeaking: Bool {
        synthesizer.isSpeaking
    }

    func reset(language: String?) {
        reader = SentenceReader()
        self.language = language
    }

    func grow(_ fullText: String) {
        for sentence in reader.next(fullText: fullText) { say(sentence) }
    }

    func finish(_ fullText: String) {
        for sentence in reader.finish(fullText: fullText) { say(sentence) }
    }

    func say(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = AVSpeechSynthesisVoice(language: language ?? Locale.preferredLanguages.first)
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }
}
#endif
