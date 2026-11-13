import Foundation

public enum AttachmentKind: String, Codable, Sendable, CaseIterable {
    case text
    case pdf
    case word
    case excel
    case powerpoint
    case image
}

public struct MessageAttachment: Codable, Sendable, Equatable {
    public let name: String
    public let ref: String
    public let bytes: Int
    public let kind: AttachmentKind
    public let truncated: Bool

    public init(name: String, ref: String, bytes: Int, kind: AttachmentKind, truncated: Bool) {
        self.name = MessageAttachments.cleanName(name)
        self.ref = ref
        self.bytes = bytes
        self.kind = kind
        self.truncated = truncated
    }

    public var tag: String {
        "<file name=\"\(name)\" ref=\"\(ref)\" bytes=\"\(bytes)\" kind=\"\(kind.rawValue)\"\(truncated ? " truncated=\"1\"" : "")/>"
    }
}

public enum MessageAttachments {
    public static let maximumCount = 10
    public static let messageLimitBytes = 64 * 1024
    public static let contentLimitBytes = 256 * 1024
    public static let fallbackName = "file"

    public static func cleanName(_ name: String) -> String {
        let banned = Set("\"<>\r\n".unicodeScalars)
        let removed = String(String.UnicodeScalarView(name.unicodeScalars.filter { !banned.contains($0) }))
        let trimmed = removed.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallbackName : trimmed
    }

    public static func compose(text: String, attachments: [MessageAttachment]) -> String {
        ((text.isEmpty ? [] : [text]) + attachments.map(\.tag)).joined(separator: "\n\n")
    }

    public static func fits(text: String, attachments: [MessageAttachment]) -> Bool {
        attachments.count <= maximumCount && compose(text: text, attachments: attachments).utf8.count <= messageLimitBytes
    }

    public static func clip(_ content: String) -> (text: String, truncated: Bool) {
        guard content.utf8.count > contentLimitBytes else { return (content, false) }
        var end = content.startIndex
        var used = 0
        for index in content.indices {
            let size = String(content[index]).utf8.count
            if used + size > contentLimitBytes { break }
            used += size
            end = content.index(after: index)
        }
        return (String(content[..<end]), true)
    }
}
