import Foundation

public struct NameCall: Sendable, Equatable {
    public let names: [String]

    public init(names: [String]) {
        var seen = Set<String>()
        self.names = names
            .map(Self.fold)
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public struct Match: Sendable, Equatable {
        public let request: String
    }

    public func match(_ transcript: String) -> Match? {
        let folded = Self.fold(transcript)
        guard !folded.isEmpty else { return nil }
        for name in names {
            guard let range = folded.range(of: name) else { continue }
            let before = folded[..<range.lowerBound]
            guard before.count <= Self.leadingAllowance else { continue }
            let request = Self.request(in: transcript, after: name)
            return Match(request: request)
        }
        return nil
    }

    static let leadingAllowance = 4

    static func fold(_ text: String) -> String {
        text.precomposedStringWithCompatibilityMapping
            .lowercased()
            .unicodeScalars
            .filter { !CharacterSet.punctuationCharacters.contains($0) && !CharacterSet.symbols.contains($0) && !CharacterSet.whitespacesAndNewlines.contains($0) }
            .map(String.init)
            .joined()
    }

    static func request(in transcript: String, after name: String) -> String {
        var folded = ""
        for (offset, character) in transcript.enumerated() {
            folded += fold(String(character))
            if folded.hasSuffix(name) {
                let leading = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
                let rest = transcript.dropFirst(offset + 1).drop { $0.unicodeScalars.allSatisfy(leading.contains) }
                return String(rest).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return transcript
    }
}
