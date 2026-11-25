import Foundation

public enum AnswerLinks {
    public static func bareWebLinks(in text: String) -> [(range: Range<String.Index>, url: URL)] {
        #if canImport(Darwin)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        let whole = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, options: [], range: whole).compactMap { match in
            guard let url = match.url, let range = Range(match.range, in: text) else { return nil }
            let written = text[range].lowercased()
            guard written.hasPrefix("http://") || written.hasPrefix("https://") else { return nil }
            return (range, url)
        }
        #else
        return []
        #endif
    }

    public static func linkingBareURLs(_ attributed: AttributedString) -> AttributedString {
        var result = attributed
        let plain = String(result.characters)
        for found in bareWebLinks(in: plain).reversed() {
            let lower = plain.distance(from: plain.startIndex, to: found.range.lowerBound)
            let upper = plain.distance(from: plain.startIndex, to: found.range.upperBound)
            let start = result.characters.index(result.startIndex, offsetBy: lower)
            let end = result.characters.index(result.startIndex, offsetBy: upper)
            if result[start..<end].runs.contains(where: { $0.link != nil }) { continue }
            result[start..<end].link = found.url
        }
        return result
    }
}

public enum MessageCopy {
    public static func text(_ raw: String, fromAgent: Bool) -> String {
        fromAgent ? raw : MessageAttachments.shown(raw).text
    }
}
