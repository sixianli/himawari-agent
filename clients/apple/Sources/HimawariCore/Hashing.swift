import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

enum Hashing {
    static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }
}

enum RandomToken {
    static func base64URL(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        var generator = SystemRandomNumberGenerator()
        for index in bytes.indices {
            bytes[index] = generator.next()
        }
        return Data(bytes).base64URLEncodedString()
    }
}

extension Data {
    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public init?(base64URLEncoded value: String) {
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = text.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { text += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: text)
    }
}
