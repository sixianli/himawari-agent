import Foundation

public enum VaultItemKind: String, Codable, Sendable, CaseIterable {
    case login
    case apiKey = "api_key"

    public var requiredFields: [String] {
        switch self {
        case .login: ["password"]
        case .apiKey: ["api_key"]
        }
    }

    public var optionalFields: [String] {
        switch self {
        case .login: ["username", "totp"]
        case .apiKey: []
        }
    }
}

public enum VaultContract {
    public static let format = "himawari-vault-v1"
    public static let phoneOnlyFields: Set<String> = ["totp"]
    public static let nameCharacters = 64
    public static let originsPerItem = 8

    public static func isItemId(_ value: String) -> Bool {
        matches(value, prefix: "vi_", tokenLength: 22)
    }

    public static func isRequestId(_ value: String) -> Bool {
        matches(value, prefix: "vr_", tokenLength: 22)
    }

    public static func isNonce(_ value: String) -> Bool {
        value.count == 43 && value.unicodeScalars.allSatisfy(isTokenScalar)
    }

    public static func newItemId() -> String {
        "vi_" + RandomToken.base64URL(byteCount: 16)
    }

    public static func name(_ value: String) -> String? {
        let count = value.unicodeScalars.count
        guard count >= 1, count <= nameCharacters else { return nil }
        guard value.trimmingCharacters(in: .whitespacesAndNewlines) == value else { return nil }
        guard !value.unicodeScalars.contains(where: isHidden) else { return nil }
        return value
    }

    public static func origin(_ value: String) -> String? {
        guard value.utf8.count <= 300 else { return nil }
        let lowered = value.lowercased()
        let prefix = "https://"
        guard lowered.hasPrefix(prefix) else { return nil }
        var rest = Substring(lowered.dropFirst(prefix.count))
        if rest.hasSuffix("/") { rest = rest.dropLast() }
        var host = rest
        var port: Int?
        if let colon = rest.lastIndex(of: ":") {
            host = rest[..<colon]
            let portText = rest[rest.index(after: colon)...]
            guard (1...5).contains(portText.count), portText.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            guard let parsed = Int(portText), (1...65_535).contains(parsed), String(parsed) == portText else { return nil }
            port = parsed
        }
        guard !host.isEmpty, host.count <= 253 else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        for label in labels {
            guard (1...63).contains(label.count) else { return nil }
            guard label.unicodeScalars.allSatisfy({ isLowerAlphanumeric($0) || $0 == "-" }) else { return nil }
            guard let first = label.unicodeScalars.first, let last = label.unicodeScalars.last,
                  isLowerAlphanumeric(first), isLowerAlphanumeric(last) else { return nil }
        }
        if let port, port != 443 { return "https://\(host):\(port)" }
        return "https://\(host)"
    }

    public static func fieldsValid(kind: VaultItemKind, fields: [String]) -> Bool {
        let unique = Set(fields)
        let allowed = Set(kind.requiredFields + kind.optionalFields)
        return unique.count == fields.count && unique.isSubset(of: allowed) && Set(kind.requiredFields).isSubset(of: unique)
    }

    public static func fieldAAD(itemId: String, field: String, version: Int) -> Data {
        Data("\(format)|field|\(itemId)|\(field)|\(version)".utf8)
    }

    public static func itemKeyAAD(itemId: String, version: Int) -> Data {
        Data("\(format)|item-key|\(itemId)|\(version)".utf8)
    }

    public static func releaseAAD(requestId: String, itemId: String, version: Int) -> Data {
        Data("\(format)|release|\(requestId)|\(itemId)|\(version)".utf8)
    }

    public static var releaseInfo: Data { Data("\(format) release".utf8) }

    private static func matches(_ value: String, prefix: String, tokenLength: Int) -> Bool {
        guard value.hasPrefix(prefix) else { return false }
        let token = value.dropFirst(prefix.count)
        return token.count == tokenLength && token.unicodeScalars.allSatisfy(isTokenScalar)
    }

    private static func isTokenScalar(_ scalar: Unicode.Scalar) -> Bool {
        scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_")
    }

    private static func isLowerAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    private static let hiddenRanges: [ClosedRange<UInt32>] = [
        0x00...0x1F, 0x7F...0x9F, 0x200B...0x200F, 0x202A...0x202E,
        0x2060...0x2064, 0x2066...0x2069, 0xFEFF...0xFEFF, 0xE0000...0xE007F,
    ]

    private static func isHidden(_ scalar: Unicode.Scalar) -> Bool {
        hiddenRanges.contains { $0.contains(scalar.value) }
    }
}
