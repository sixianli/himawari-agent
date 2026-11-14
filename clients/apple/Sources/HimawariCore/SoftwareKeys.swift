import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public struct SoftwareKeySigner: DeviceKeySigner {
    private let scalar: Data

    public init(rawRepresentation: Data? = nil) throws {
        if let rawRepresentation {
            scalar = try P256.Signing.PrivateKey(rawRepresentation: rawRepresentation).rawRepresentation
        } else {
            scalar = P256.Signing.PrivateKey().rawRepresentation
        }
    }

    private var restored: P256.Signing.PrivateKey {
        get throws { try P256.Signing.PrivateKey(rawRepresentation: scalar) }
    }

    public func publicKeySPKI() throws -> Data {
        try restored.publicKey.derRepresentation
    }

    public func sign(_ message: Data, reason: String?) async throws -> Data {
        try restored.signature(for: message).rawRepresentation
    }

    public static func verify(signature: Data, message: Data, publicKeySPKI: Data) -> Bool {
        guard
            let publicKey = try? P256.Signing.PublicKey(derRepresentation: publicKeySPKI),
            let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: signature)
        else { return false }
        return publicKey.isValidSignature(parsed, for: message)
    }
}
