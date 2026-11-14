#if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
import CryptoKit
import Foundation
import LocalAuthentication
import Security

public struct SecureEnclaveKeySigner: DeviceKeySigner {
    public let role: DeviceKeyRole
    private let store: SecureEnclaveKeyStore

    init(role: DeviceKeyRole, store: SecureEnclaveKeyStore) {
        self.role = role
        self.store = store
    }

    public func publicKeySPKI() throws -> Data {
        try store.load(role, context: nil).publicKey.derRepresentation
    }

    public func sign(_ message: Data, reason: String?) async throws -> Data {
        let context = LAContext()
        #if !os(watchOS)
        if let reason { context.localizedReason = reason }
        #endif
        let key = try store.load(role, context: role == .confirm ? context : nil)
        return try key.signature(for: message).rawRepresentation
    }
}

public struct SecureEnclaveKeyStore: Sendable {
    public let service: String

    public init(service: String) {
        self.service = service
    }

    public func signer(_ role: DeviceKeyRole) -> SecureEnclaveKeySigner {
        SecureEnclaveKeySigner(role: role, store: self)
    }

    public func exists(_ role: DeviceKeyRole) -> Bool {
        (try? readRepresentation(role)) != nil
    }

    public func presence(_ role: DeviceKeyRole) -> KeychainPresence {
        do {
            _ = try readRepresentation(role)
            return .present
        } catch DeviceKeyError.keyMissing {
            return .absent
        } catch {
            return .unreadable
        }
    }

    public func create(_ role: DeviceKeyRole) throws {
        guard SecureEnclave.isAvailable else { throw DeviceKeyError.secureEnclaveUnavailable }
        try delete(role)
        let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
        var error: Unmanaged<CFError>?
        let protection = role == .confirm ? kSecAttrAccessibleWhenUnlockedThisDeviceOnly : kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            protection,
            flags,
            &error
        ) else { throw DeviceKeyError.accessControl }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: role.rawValue,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: key.dataRepresentation,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw DeviceKeyError.keychain(status) }
    }

    public func delete(_ role: DeviceKeyRole) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: role.rawValue,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DeviceKeyError.keychain(status) }
    }

    func load(_ role: DeviceKeyRole, context: LAContext?) throws -> SecureEnclave.P256.Signing.PrivateKey {
        let representation = try readRepresentation(role)
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: representation, authenticationContext: context)
    }

    private func readRepresentation(_ role: DeviceKeyRole) throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: role.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            if status == errSecItemNotFound { throw DeviceKeyError.keyMissing(role) }
            throw DeviceKeyError.keychain(status)
        }
        return data
    }
}
#endif
