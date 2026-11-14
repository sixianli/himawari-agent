#if canImport(Security)
import Foundation
import Security

public struct KeychainValueStore: Sendable {
    public let service: String
    public let accessGroup: String?

    public init(service: String, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func scoped(_ query: [String: Any]) -> [String: Any] {
        guard let accessGroup else { return query }
        var query = query
        query[kSecAttrAccessGroup as String] = accessGroup
        return query
    }

    public func presence(_ account: String) -> KeychainPresence {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: false,
        ]
        return KeychainPresence(SecItemCopyMatching(scoped(query) as CFDictionary, nil))
    }

    public func read(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(scoped(query) as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    public func write(_ account: String, _ data: Data?) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let deleted = SecItemDelete(scoped(query) as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw DeviceKeyError.keychain(deleted) }
        guard let data else { return }
        var item = query
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecValueData as String] = data
        let status = SecItemAdd(scoped(item) as CFDictionary, nil)
        guard status == errSecSuccess else { throw DeviceKeyError.keychain(status) }
    }
}

extension KeychainPresence {
    public init(_ status: OSStatus) {
        switch status {
        case errSecSuccess: self = .present
        case errSecItemNotFound: self = .absent
        default: self = .unreadable
        }
    }
}

#endif
