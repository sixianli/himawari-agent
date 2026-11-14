#if canImport(Security)
import Foundation
import Security

public struct KeychainValueStore: Sendable {
    public let service: String

    public init(service: String) {
        self.service = service
    }

    public func presence(_ account: String) -> KeychainPresence {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: false,
        ]
        return KeychainPresence(SecItemCopyMatching(query as CFDictionary, nil))
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
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    public func write(_ account: String, _ data: Data?) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let deleted = SecItemDelete(query as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw DeviceKeyError.keychain(deleted) }
        guard let data else { return }
        var item = query
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecValueData as String] = data
        let status = SecItemAdd(item as CFDictionary, nil)
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
