import Foundation

public struct HerReply: Sendable, Equatable {
    private var reader = SentenceReader()
    private var source = ""
    private var finished = true
    public private(set) var interrupted = false

    public init() {}

    public var expectsMore: Bool { !source.isEmpty && !finished && !interrupted }

    public mutating func receive(_ markdown: String, finished: Bool) -> [String] {
        let text = SpokenText.from(markdown: markdown)
        if source.isEmpty || !text.hasPrefix(source) {
            reader = SentenceReader()
            interrupted = false
        }
        source = text
        self.finished = finished
        guard !interrupted else { return [] }
        return finished ? reader.finish(fullText: text) : reader.next(fullText: text)
    }

    public mutating func ownerSpoke(whileSpeaking speaking: Bool) -> Bool {
        guard speaking || expectsMore else { return false }
        interrupted = true
        return true
    }
}
