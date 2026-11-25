import Foundation

public enum MessageReply {
    public static func compose(replyingTo messageId: String?, text: String) -> String {
        guard let messageId, isValidId(messageId) else { return text }
        return "<reply to=\"\(messageId)\"/>\n" + text
    }

    public static func split(_ raw: String) -> (replyTo: String?, text: String) {
        let prefix = "<reply to=\""
        guard raw.hasPrefix(prefix) else { return (nil, raw) }
        let afterPrefix = raw.dropFirst(prefix.count)
        guard let close = afterPrefix.range(of: "\"/>") else { return (nil, raw) }
        let id = String(afterPrefix[..<close.lowerBound])
        guard isValidId(id) else { return (nil, raw) }
        var rest = afterPrefix[close.upperBound...]
        if rest.hasPrefix("\n") { rest = rest.dropFirst() }
        return (id, String(rest))
    }

    public static func quoteLine(_ raw: String) -> String {
        let shown = MessageAttachments.shown(raw)
        let body = shown.text.isEmpty ? (shown.attachments.first?.name ?? "") : shown.text
        let linked = body.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        let plain = linked.replacingOccurrences(of: #"[#*_`>~|]"#, with: "", options: .regularExpression)
        return plain.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func isValidId(_ id: String) -> Bool {
        !id.isEmpty && id.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII || "_.:-".unicodeScalars.contains(scalar)
        }
    }
}
