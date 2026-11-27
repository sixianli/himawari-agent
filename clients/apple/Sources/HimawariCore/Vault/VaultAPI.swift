import Foundation

public struct VaultPendingRequest: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let nonce: String
    public let itemIds: [String]
    public let itemVersions: [Int]
    public let origin: String
    public let pageVersion: String?
    public let ephemeralPublicKey: String
    public let expiresAt: String
    public let createdAt: String
    public let purpose: String
}

public struct VaultStoredItem: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let kind: VaultItemKind
    public let origins: [String]
    public let fields: [String]
    public let version: Int
    public let backgroundAllowed: Bool
    public let wrappedKey: String
    public let ciphertexts: [String: String]
    public let updatedAt: String

    public var sealed: VaultSealedItem {
        VaultSealedItem(id: id, name: name, kind: kind, origins: origins, fields: fields, version: version, backgroundAllowed: backgroundAllowed, wrappedKey: wrappedKey, ciphertexts: ciphertexts)
    }
}

public struct VaultSnapshot: Codable, Sendable, Equatable {
    public let manifest: VaultManifestSignature?
    public let items: [VaultStoredItem]
    public let pending: [VaultPendingRequest]
}

public enum VaultUsageOutcome: String, Codable, Sendable {
    case approved
    case denied
    case expired
    case filled
    case failed
}

public struct VaultUsageEntry: Codable, Sendable, Equatable {
    public let requestId: String
    public let itemId: String
    public let origin: String
    public let outcome: VaultUsageOutcome
    public let at: String
    public let purpose: String?
}

public struct VaultChange: Codable, Sendable, Equatable {
    public let expectedManifestVersion: Int
    public let manifest: VaultManifestSignature
    public let upserts: [VaultSealedItem]
    public let deletes: [String]
    public let rotation: Bool

    public init(expectedManifestVersion: Int, manifest: VaultManifestSignature, upserts: [VaultSealedItem], deletes: [String], rotation: Bool) {
        self.expectedManifestVersion = expectedManifestVersion
        self.manifest = manifest
        self.upserts = upserts
        self.deletes = deletes
        self.rotation = rotation
    }
}

public struct VaultApproval: Codable, Sendable, Equatable {
    public let requestId: String
    public let nonce: String
    public let deviceId: String
    public let itemIds: [String]
    public let itemVersions: [Int]
    public let origin: String
    public let pageVersion: String?
    public let ephemeralPublicKey: String
    public let expiresAt: String
    public let sealed: [VaultSealedRelease]

    public init(request: VaultPendingRequest, deviceId: String, sealed: [VaultSealedRelease]) {
        requestId = request.id
        nonce = request.nonce
        self.deviceId = deviceId
        itemIds = request.itemIds
        itemVersions = request.itemVersions
        origin = request.origin
        pageVersion = request.pageVersion
        ephemeralPublicKey = request.ephemeralPublicKey
        expiresAt = request.expiresAt
        self.sealed = sealed
    }

    private enum CodingKeys: String, CodingKey {
        case requestId, nonce, deviceId, itemIds, itemVersions, origin, pageVersion, ephemeralPublicKey, expiresAt, sealed
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(requestId, forKey: .requestId)
        try container.encode(nonce, forKey: .nonce)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(itemIds, forKey: .itemIds)
        try container.encode(itemVersions, forKey: .itemVersions)
        try container.encode(origin, forKey: .origin)
        if let pageVersion { try container.encode(pageVersion, forKey: .pageVersion) } else { try container.encodeNil(forKey: .pageVersion) }
        try container.encode(ephemeralPublicKey, forKey: .ephemeralPublicKey)
        try container.encode(expiresAt, forKey: .expiresAt)
        try container.encode(sealed, forKey: .sealed)
    }
}

public enum VaultChangeOutcome: Sendable, Equatable {
    case applied(VaultManifestSignature)
    case conflict
}

public enum VaultDecisionOutcome: Sendable, Equatable {
    case recorded
    case gone
}

extension DeviceAPI {
    public func vaultSnapshot() async throws -> VaultSnapshot {
        try decode(VaultSnapshot.self, try await http.send(DeviceRequest(method: "GET", path: "vault")))
    }

    public func vaultUsage(itemId: String?) async throws -> [VaultUsageEntry] {
        struct Reply: Decodable { let usage: [VaultUsageEntry] }
        let query = itemId.map { [URLQueryItem(name: "itemId", value: $0)] } ?? []
        return try decode(Reply.self, try await http.send(DeviceRequest(method: "GET", path: "vault/usage", query: query))).usage
    }

    public func changeVault(_ change: VaultChange) async throws -> VaultChangeOutcome {
        struct Reply: Decodable { let manifest: VaultManifestSignature }
        do {
            let data = try await http.send(DeviceRequest(method: "POST", path: "vault/change", body: try JSONEncoder().encode(change)))
            return .applied(try decode(Reply.self, data).manifest)
        } catch let DeviceAPIError.server(status, code, _, _) where status == 409 && code == "VAULT_MANIFEST_CONFLICT" {
            return .conflict
        }
    }

    public func approveVault(_ approval: VaultApproval, confirm: DeviceKeySigner, reason: String) async throws -> VaultDecisionOutcome {
        do {
            let challenge = try await issueConfirmChallenge()
            _ = try await http.send(DeviceRequest(method: "POST", path: "vault/approve", body: try JSONEncoder().encode(approval), nonce: challenge, confirmSigner: confirm, confirmReason: reason))
            return .recorded
        } catch let DeviceAPIError.server(status, _, _, _) where status == 404 || status == 410 {
            return .gone
        }
    }

    public func denyVault(requestId: String, nonce: String) async throws -> VaultDecisionOutcome {
        struct Body: Encodable { let requestId: String; let nonce: String }
        do {
            _ = try await http.send(DeviceRequest(method: "POST", path: "vault/deny", body: try JSONEncoder().encode(Body(requestId: requestId, nonce: nonce))))
            return .recorded
        } catch let DeviceAPIError.server(status, _, _, _) where status == 404 || status == 410 {
            return .gone
        }
    }
}

public struct VaultCodeRequest: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let origin: String
    public let purpose: String
    public let createdAt: String
    public let expiresAt: String

    public init(id: String, origin: String, purpose: String, createdAt: String, expiresAt: String) {
        self.id = id
        self.origin = origin
        self.purpose = purpose
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public enum VaultCode {
    public static let allowedLength = 4...12

    public static func cleaned(_ typed: String) -> String? {
        let code = typed.filter { !$0.isWhitespace && $0 != "-" }
        guard allowedLength.contains(code.count), code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        return code
    }
}

public protocol VaultCodeTransport: Sendable {
    func vaultCodeRequests() async throws -> [VaultCodeRequest]
    func answerVaultCode(requestId: String, code: String) async throws -> VaultDecisionOutcome
    func declineVaultCode(requestId: String) async throws -> VaultDecisionOutcome
}

extension DeviceAPI: VaultCodeTransport {
    public func vaultCodeRequests() async throws -> [VaultCodeRequest] {
        struct Reply: Decodable { let requests: [VaultCodeRequest] }
        return try decode(Reply.self, try await http.send(DeviceRequest(method: "GET", path: "vault/codes"))).requests
    }

    public func answerVaultCode(requestId: String, code: String) async throws -> VaultDecisionOutcome {
        struct Body: Encodable { let requestId: String; let code: String }
        do {
            _ = try await http.send(DeviceRequest(method: "POST", path: "vault/codes/answer", body: try JSONEncoder().encode(Body(requestId: requestId, code: code))))
            return .recorded
        } catch let DeviceAPIError.server(status, _, _, _) where status == 404 || status == 410 {
            return .gone
        }
    }

    public func declineVaultCode(requestId: String) async throws -> VaultDecisionOutcome {
        struct Body: Encodable { let requestId: String }
        do {
            _ = try await http.send(DeviceRequest(method: "POST", path: "vault/codes/decline", body: try JSONEncoder().encode(Body(requestId: requestId))))
            return .recorded
        } catch let DeviceAPIError.server(status, _, _, _) where status == 404 || status == 410 {
            return .gone
        }
    }
}
