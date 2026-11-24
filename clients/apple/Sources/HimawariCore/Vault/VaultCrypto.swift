import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public enum VaultCryptoError: Error, Equatable, Sendable {
    case masterKeyLength
    case malformedCiphertext
    case malformedPublicKey
    case invalidField(String)
    case originNotAllowed
    case unknownItem(String)
    case invalidTOTPSeed
}

public struct VaultItemValues: Sendable, Equatable {
    public var name: String
    public var kind: VaultItemKind
    public var origins: [String]
    public var values: [String: String]
    public var backgroundAllowed: Bool

    public init(name: String, kind: VaultItemKind, origins: [String], values: [String: String], backgroundAllowed: Bool) {
        self.name = name
        self.kind = kind
        self.origins = origins
        self.values = values
        self.backgroundAllowed = backgroundAllowed
    }
}

public struct VaultSealedItem: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let kind: VaultItemKind
    public let origins: [String]
    public let fields: [String]
    public let version: Int
    public let backgroundAllowed: Bool
    public let wrappedKey: String
    public let ciphertexts: [String: String]

    public init(id: String, name: String, kind: VaultItemKind, origins: [String], fields: [String], version: Int, backgroundAllowed: Bool, wrappedKey: String, ciphertexts: [String: String]) {
        self.id = id
        self.name = name
        self.kind = kind
        self.origins = origins
        self.fields = fields
        self.version = version
        self.backgroundAllowed = backgroundAllowed
        self.wrappedKey = wrappedKey
        self.ciphertexts = ciphertexts
    }
}

public struct VaultManifestSignature: Codable, Sendable, Equatable {
    public let version: Int
    public let signature: String

    public init(version: Int, signature: String) {
        self.version = version
        self.signature = signature
    }
}

public struct VaultSealedRelease: Codable, Sendable, Equatable {
    public let itemId: String
    public let enc: String
    public let ciphertext: String
}

public struct VaultKeyring: Sendable {
    private let master: Data

    public init(masterKey: Data) throws {
        guard masterKey.count == 32 else { throw VaultCryptoError.masterKeyLength }
        master = masterKey
    }

    public static func newMasterKey() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    func derive(_ info: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: master),
            salt: Data(VaultContract.format.utf8),
            info: Data(info.utf8),
            outputByteCount: 32
        )
    }

    private func fieldKey(itemId: String, field: String, itemKey: SymmetricKey) -> SymmetricKey {
        VaultContract.phoneOnlyFields.contains(field) ? derive("phone-only|\(itemId)") : itemKey
    }

    public func seal(id: String, item: VaultItemValues, version: Int) throws -> VaultSealedItem {
        guard VaultContract.isItemId(id), VaultContract.name(item.name) != nil else { throw VaultCryptoError.invalidField("item") }
        let fields = item.values.keys.sorted()
        guard VaultContract.fieldsValid(kind: item.kind, fields: fields) else { throw VaultCryptoError.invalidField(fields.joined(separator: ",")) }
        if let empty = fields.first(where: { item.values[$0]?.isEmpty ?? true }) { throw VaultCryptoError.invalidField(empty) }
        let origins = try item.origins.map { origin -> String in
            guard let normalized = VaultContract.origin(origin) else { throw VaultCryptoError.invalidField("origin") }
            return normalized
        }
        guard !origins.isEmpty, origins.count <= VaultContract.originsPerItem, Set(origins).count == origins.count else {
            throw VaultCryptoError.invalidField("origins")
        }
        let itemKey = SymmetricKey(size: .bits256)
        var ciphertexts: [String: String] = [:]
        for field in fields {
            let aad = VaultContract.fieldAAD(itemId: id, field: field, version: version)
            ciphertexts[field] = try Self.sealAESGCM(Data((item.values[field] ?? "").utf8), key: fieldKey(itemId: id, field: field, itemKey: itemKey), aad: aad)
        }
        let rawItemKey = itemKey.withUnsafeBytes { Data($0) }
        let wrapped = try Self.sealAESGCM(rawItemKey, key: derive("item-key"), aad: VaultContract.itemKeyAAD(itemId: id, version: version))
        return VaultSealedItem(
            id: id,
            name: item.name,
            kind: item.kind,
            origins: origins.sorted(),
            fields: fields,
            version: version,
            backgroundAllowed: item.backgroundAllowed,
            wrappedKey: wrapped,
            ciphertexts: ciphertexts
        )
    }

    public func itemKey(_ item: VaultSealedItem) throws -> Data {
        try Self.openAESGCM(item.wrappedKey, key: derive("item-key"), aad: VaultContract.itemKeyAAD(itemId: item.id, version: item.version))
    }

    public func open(_ item: VaultSealedItem) throws -> VaultItemValues {
        let itemKey = SymmetricKey(data: try itemKey(item))
        var values: [String: String] = [:]
        for field in item.fields {
            guard let ciphertext = item.ciphertexts[field] else { throw VaultCryptoError.malformedCiphertext }
            let plain = try Self.openAESGCM(ciphertext, key: fieldKey(itemId: item.id, field: field, itemKey: itemKey), aad: VaultContract.fieldAAD(itemId: item.id, field: field, version: item.version))
            guard let text = String(data: plain, encoding: .utf8) else { throw VaultCryptoError.malformedCiphertext }
            values[field] = text
        }
        return VaultItemValues(name: item.name, kind: item.kind, origins: item.origins, values: values, backgroundAllowed: item.backgroundAllowed)
    }

    public func manifestSignature(version: Int, items: [VaultSealedItem]) -> VaultManifestSignature {
        let code = HMAC<SHA256>.authenticationCode(for: VaultManifest.bytes(version: version, items: items), using: derive("manifest"))
        return VaultManifestSignature(version: version, signature: Data(code).base64EncodedString())
    }

    public func manifestValid(_ manifest: VaultManifestSignature, items: [VaultSealedItem]) -> Bool {
        guard let signature = Data(base64Encoded: manifest.signature) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(signature, authenticating: VaultManifest.bytes(version: manifest.version, items: items), using: derive("manifest"))
    }

    public func release(request: VaultPendingRequest, items: [VaultSealedItem], now: Date) throws -> [VaultSealedRelease] {
        guard let recipientBytes = Data(base64Encoded: request.ephemeralPublicKey),
              let recipient = try? P256.KeyAgreement.PublicKey(x963Representation: recipientBytes) else {
            throw VaultCryptoError.malformedPublicKey
        }
        let byId = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var sealed: [VaultSealedRelease] = []
        for (index, itemId) in request.itemIds.enumerated() {
            guard let item = byId[itemId], index < request.itemVersions.count, item.version == request.itemVersions[index] else {
                throw VaultCryptoError.unknownItem(itemId)
            }
            guard item.origins.contains(request.origin) else { throw VaultCryptoError.originNotAllowed }
            var payload: [String: Any] = ["itemKey": try itemKey(item).base64EncodedString()]
            if item.fields.contains("totp") {
                let seed = try open(item).values["totp"] ?? ""
                let start = Int64(now.timeIntervalSince1970)
                payload["totp"] = try [0, 30, 60].map { offset -> [String: Any] in
                    ["at": start + Int64(offset), "code": try VaultTOTP.code(base32Seed: seed, at: start + Int64(offset))]
                }
            }
            let plaintext = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            var sender = try HPKE.Sender(recipientKey: recipient, ciphersuite: .P256_SHA256_AES_GCM_256, info: VaultContract.releaseInfo)
            let ciphertext = try sender.seal(plaintext, authenticating: VaultContract.releaseAAD(requestId: request.id, itemId: itemId, version: item.version))
            sealed.append(VaultSealedRelease(itemId: itemId, enc: sender.encapsulatedKey.base64EncodedString(), ciphertext: ciphertext.base64EncodedString()))
        }
        return sealed
    }

    static func sealAESGCM(_ plaintext: Data, key: SymmetricKey, aad: Data) throws -> String {
        guard let combined = try AES.GCM.seal(plaintext, using: key, authenticating: aad).combined else {
            throw VaultCryptoError.malformedCiphertext
        }
        return combined.base64EncodedString()
    }

    static func openAESGCM(_ base64: String, key: SymmetricKey, aad: Data) throws -> Data {
        guard let combined = Data(base64Encoded: base64), combined.count >= 28 else { throw VaultCryptoError.malformedCiphertext }
        return try AES.GCM.open(try AES.GCM.SealedBox(combined: combined), using: key, authenticating: aad)
    }
}

public enum VaultManifest {
    public static func bytes(version: Int, items: [VaultSealedItem]) -> Data {
        let lines = items.sorted { $0.id < $1.id }.map { item in
            [
                item.id,
                Data(item.name.utf8).base64EncodedString(),
                item.kind.rawValue,
                item.origins.sorted().joined(separator: ","),
                item.fields.sorted().joined(separator: ","),
                String(item.version),
                item.backgroundAllowed ? "1" : "0",
            ].joined(separator: "\t")
        }
        return Data((["\(VaultContract.format) manifest", "version \(version)"] + lines).joined(separator: "\n").utf8)
    }
}

public enum VaultTOTP {
    public static func code(base32Seed: String, at seconds: Int64, digits: Int = 6, period: Int64 = 30) throws -> String {
        guard let secret = base32Decode(base32Seed), !secret.isEmpty else { throw VaultCryptoError.invalidTOTPSeed }
        var counter = UInt64(seconds / period).bigEndian
        let message = withUnsafeBytes(of: &counter) { Data($0) }
        let digest = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: SymmetricKey(data: secret)))
        let offset = Int(digest[digest.count - 1] & 0x0f)
        let value = (UInt32(digest[offset] & 0x7f) << 24) | (UInt32(digest[offset + 1]) << 16) | (UInt32(digest[offset + 2]) << 8) | UInt32(digest[offset + 3])
        var modulus: UInt32 = 1
        for _ in 0..<digits { modulus *= 10 }
        let text = String(value % modulus)
        return String(repeating: "0", count: max(0, digits - text.count)) + text
    }

    public static func base32Decode(_ text: String) -> Data? {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var lookup: [Character: UInt8] = [:]
        for (index, character) in alphabet.enumerated() { lookup[character] = UInt8(index) }
        var buffer: UInt32 = 0
        var bits = 0
        var output = Data()
        for character in text.uppercased() where character != "=" && character != " " && character != "-" {
            guard let value = lookup[character] else { return nil }
            buffer = (buffer << 5) | UInt32(value)
            bits += 5
            if bits >= 8 {
                bits -= 8
                output.append(UInt8((buffer >> UInt32(bits)) & 0xff))
            }
        }
        return output
    }
}

public enum VaultOTPAuth {
    public static func seed(from scanned: String) -> String? {
        guard let components = URLComponents(string: scanned), components.scheme?.lowercased() == "otpauth", components.host?.lowercased() == "totp" else { return nil }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] { values[item.name.lowercased()] = item.value }
        guard (values["algorithm"] ?? "SHA1").uppercased() == "SHA1", (values["digits"] ?? "6") == "6", (values["period"] ?? "30") == "30" else { return nil }
        guard let secret = values["secret"]?.replacingOccurrences(of: " ", with: "").uppercased(), let decoded = VaultTOTP.base32Decode(secret), !decoded.isEmpty else { return nil }
        return secret
    }
}
