import Foundation

public struct NameCall: Sendable, Equatable {
    public let names: [String]
    private let spellings: [String]

    public init(names: [String]) {
        var seen = Set<String>()
        var folded: [String] = []
        var spellings: [String] = []
        for name in names {
            let key = Self.fold(name)
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            folded.append(key)
            spellings.append(name.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        self.names = folded
        self.spellings = spellings
    }

    public struct Match: Sendable, Equatable {
        public let name: String
        public let text: String
        public let saysMoreThanTheName: Bool
    }

    public func match(_ transcript: String) -> Match? {
        let folded = Self.fold(transcript)
        guard !folded.isEmpty else { return nil }
        for (index, name) in names.enumerated() where folded.contains(name) {
            return Match(
                name: spellings[index],
                text: transcript.trimmingCharacters(in: .whitespacesAndNewlines),
                saysMoreThanTheName: !folded.replacingOccurrences(of: name, with: "").isEmpty
            )
        }
        return nil
    }

    static func fold(_ text: String) -> String {
        text.precomposedStringWithCompatibilityMapping
            .lowercased()
            .unicodeScalars
            .filter { !CharacterSet.punctuationCharacters.contains($0) && !CharacterSet.symbols.contains($0) && !CharacterSet.whitespacesAndNewlines.contains($0) }
            .map(String.init)
            .joined()
    }
}
