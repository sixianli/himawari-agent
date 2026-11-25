import Foundation

public enum VaultKeySlot: String, Sendable, CaseIterable {
    case current = "master-key"
    case next = "master-key-next"
}

public protocol VaultMasterKeyStoring: Sendable {
    func read(_ slot: VaultKeySlot) throws -> Data?
    func write(_ slot: VaultKeySlot, _ key: Data) throws
    func remove(_ slot: VaultKeySlot) throws
}

public enum VaultMasterKeyError: Error, Equatable, Sendable {
    case keychain(Int32)
    case malformed
}

#if canImport(Security)
import Security

public struct VaultKeychainMasterKeyStore: VaultMasterKeyStoring {
    public static let service = "himawari.vault"

    public let accessGroup: String?

    public init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    private func base(_ account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanTrue as Any,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func read(_ slot: VaultKeySlot) throws -> Data? {
        var query = base(slot.rawValue)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw VaultMasterKeyError.keychain(status) }
        guard let data = item as? Data, data.count == 32 else { throw VaultMasterKeyError.malformed }
        return data
    }

    public func write(_ slot: VaultKeySlot, _ key: Data) throws {
        guard key.count == 32 else { throw VaultMasterKeyError.malformed }
        try remove(slot)
        var item = base(slot.rawValue)
        item[kSecValueData as String] = key
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaultMasterKeyError.keychain(status) }
    }

    public func remove(_ slot: VaultKeySlot) throws {
        let status = SecItemDelete(base(slot.rawValue) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultMasterKeyError.keychain(status) }
    }
}
#endif
