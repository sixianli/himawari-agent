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
        do {
            return try store.load(role, context: nil).publicKey.derRepresentation
        } catch let error as DeviceKeyError {
            throw error
        } catch {
            throw DeviceKeyError.keyUnreadable(role)
        }
    }

    public func sign(_ message: Data, reason: String?) async throws -> Data {
        try key(reason: reason, context: LAContext()).signature(for: message).rawRepresentation
    }

    public func held() -> any DeviceKeySigner {
        HeldSecureEnclaveKeySigner(signer: self)
    }

    fileprivate func key(reason: String?, context: LAContext) throws -> SecureEnclave.P256.Signing.PrivateKey {
        #if !os(watchOS)
        if let reason { context.localizedReason = reason }
        #endif
        do {
            return try store.load(role, context: role == .confirm ? context : nil)
        } catch let error as DeviceKeyError {
            throw error
        } catch {
            throw DeviceKeyError.keyUnreadable(role)
        }
    }
}

final class HeldSecureEnclaveKeySigner: DeviceKeySigner, @unchecked Sendable {
    private let signer: SecureEnclaveKeySigner
    private let context = LAContext()
    private let lock = NSLock()
    private var loaded: SecureEnclave.P256.Signing.PrivateKey?

    init(signer: SecureEnclaveKeySigner) {
        self.signer = signer
    }

    func publicKeySPKI() throws -> Data {
        try signer.publicKeySPKI()
    }

    func sign(_ message: Data, reason: String?) async throws -> Data {
        try lock.withLock {
            let key = try loaded ?? signer.key(reason: reason, context: context)
            loaded = key
            return try key.signature(for: message).rawRepresentation
        }
    }
}

public struct SecureEnclaveKeyStore: Sendable {
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
        let flags = Self.accessFlags(role)
        var error: Unmanaged<CFError>?
        let protection = role == .confirm ? kSecAttrAccessibleWhenUnlockedThisDeviceOnly : kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            protection,
            flags,
            &error
        ) else { throw DeviceKeyError.accessControl }
        let key: SecureEnclave.P256.Signing.PrivateKey
        do {
            key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        } catch {
            throw DeviceKeyError.notCreated(role)
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: role.rawValue,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: key.dataRepresentation,
        ]
        let status = SecItemAdd(scoped(query) as CFDictionary, nil)
        guard status == errSecSuccess else { throw DeviceKeyError.keychain(status) }
    }

    static func accessFlags(_ role: DeviceKeyRole) -> SecAccessControlCreateFlags {
        #if targetEnvironment(simulator)
        return [.privateKeyUsage]
        #else
        return role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
        #endif
    }

    public func delete(_ role: DeviceKeyRole) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: role.rawValue,
        ]
        let status = SecItemDelete(scoped(query) as CFDictionary)
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
        let status = SecItemCopyMatching(scoped(query) as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            if status == errSecItemNotFound { throw DeviceKeyError.keyMissing(role) }
            throw DeviceKeyError.keychain(status)
        }
        return data
    }
}
#endif
