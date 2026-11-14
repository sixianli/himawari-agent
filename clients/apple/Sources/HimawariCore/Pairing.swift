import Foundation

public struct ServiceAccessToken: Codable, Sendable, Equatable {
    public let clientId: String
    public let secret: String

    private enum CodingKeys: String, CodingKey {
        case clientId
        case secret = "clientSecret"
    }

    public init(clientId: String, secret: String) {
        self.clientId = clientId
        self.secret = secret
    }
}

public struct PairingInvitation: Sendable, Equatable {
    public let origin: URL
    public let code: String
    public let access: ServiceAccessToken?

    public static let scheme = "himawari-pair"

    public init(origin: URL, code: String, access: ServiceAccessToken?) {
        self.origin = origin
        self.code = code
        self.access = access
    }

    public var link: String {
        struct Outgoing: Encodable {
            let v: Int
            let origin: String
            let code: String
            let access: ServiceAccessToken?
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let origin = origin.absoluteString.hasSuffix("/") ? String(origin.absoluteString.dropLast()) : origin.absoluteString
        let data = (try? encoder.encode(Outgoing(v: 1, origin: origin, code: code, access: access))) ?? Data()
        return "\(Self.scheme):\(data.base64URLEncodedString())"
    }

    public static func newCode() -> String {
        RandomToken.base64URL(byteCount: 16)
    }

    public enum ParseError: Error, Equatable, Sendable {
        case notAPairingCode
        case unsupportedVersion
        case malformed
    }

    private struct Envelope: Decodable {
        let v: Int
        let origin: String
        let code: String
        let access: ServiceAccessToken?
    }

    public static func parse(_ text: String) throws -> PairingInvitation {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "\(scheme):"
        guard trimmed.hasPrefix(prefix) else { throw ParseError.notAPairingCode }
        guard let data = Data(base64URLEncoded: String(trimmed.dropFirst(prefix.count))) else {
            throw ParseError.malformed
        }
        let envelope: Envelope
        do {
            envelope = try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            throw ParseError.malformed
        }
        guard envelope.v == 1 else { throw ParseError.unsupportedVersion }
        guard
            let origin = URL(string: envelope.origin),
            origin.scheme == "https",
            origin.host?.isEmpty == false,
            origin.user == nil,
            origin.password == nil,
            origin.query == nil,
            origin.fragment == nil,
            origin.path.isEmpty || origin.path == "/",
            envelope.code.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil
        else { throw ParseError.malformed }
        return PairingInvitation(origin: origin, code: envelope.code, access: envelope.access)
    }
}

public enum PairingNumber {
    public static let domain = "himawari-pairing-v1"

    public static func value(devicePublicKey: Data, confirmPublicKey: Data) -> UInt32 {
        var input = Data(domain.utf8)
        input.append(devicePublicKey)
        input.append(confirmPublicKey)
        let digest = Hashing.sha256(input)
        let prefix = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return prefix % 1_000_000
    }

    public static func digits(devicePublicKey: Data, confirmPublicKey: Data) -> String {
        let number = value(devicePublicKey: devicePublicKey, confirmPublicKey: confirmPublicKey)
        let text = String(number)
        return String(repeating: "0", count: 6 - text.count) + text
    }

    public static func display(devicePublicKey: Data, confirmPublicKey: Data) -> String {
        let text = digits(devicePublicKey: devicePublicKey, confirmPublicKey: confirmPublicKey)
        return "\(text.prefix(3)) \(text.suffix(3))"
    }
}

public enum PairingRequestLimits {
    public static let deviceNameCharacters = 64

    public static func deviceName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = String(String.UnicodeScalarView(trimmed.unicodeScalars.prefix(deviceNameCharacters)))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "iPhone" : name
    }
}
