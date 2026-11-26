import Foundation

public enum TextSearch {
    public static func terms(_ query: String) -> [String] {
        query.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    public static func matches(_ text: String, query: String) -> Bool {
        let wanted = terms(query)
        guard !wanted.isEmpty else { return true }
        return wanted.allSatisfy { text.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]) != nil }
    }
}
