import Foundation

public struct SentenceReader: Sendable, Equatable {
    private var consumed: String.Index?
    private var source = ""

    public init() {}

    static let enders: Set<Character> = ["。", "！", "？", "!", "?", "…", "；", ";", "\n"]
    static let closers: Set<Character> = ["」", "』", "”", "’", "\"", "'", ")", "）", "】", "]"]

    public mutating func next(fullText: String) -> [String] {
        guard fullText.hasPrefix(source) else {
            self = SentenceReader()
            return next(fullText: fullText)
        }
        source = fullText
        var start = consumed ?? source.startIndex
        var sentences: [String] = []
        var index = start
        while index < source.endIndex {
            let character = source[index]
            var end: String.Index?
            if Self.enders.contains(character) {
                end = source.index(after: index)
            } else if character == "." {
                let after = source.index(after: index)
                if after < source.endIndex, source[after].isWhitespace || source[after].isNewline {
                    end = after
                }
            }
            if var cut = end {
                while cut < source.endIndex, Self.closers.contains(source[cut]) || Self.enders.contains(source[cut]) {
                    cut = source.index(after: cut)
                }
                let sentence = source[start..<cut].trimmingCharacters(in: .whitespacesAndNewlines)
                if !sentence.isEmpty { sentences.append(sentence) }
                start = cut
                index = cut
                continue
            }
            index = source.index(after: index)
        }
        consumed = start
        return sentences
    }

    public mutating func finish(fullText: String) -> [String] {
        var sentences = next(fullText: fullText)
        let rest = source[(consumed ?? source.startIndex)...].trimmingCharacters(in: .whitespacesAndNewlines)
        if !rest.isEmpty { sentences.append(rest) }
        consumed = source.endIndex
        return sentences
    }
}
