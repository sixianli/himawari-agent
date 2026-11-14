#if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
import Foundation

public struct SharedVault: Sendable {
    public static let keychainGroupKey = "HimawariKeychainGroup"
    public static let appGroupKey = "HimawariAppGroup"
    public static let service = "himawari.device"
    public static let recordAccount = "pairing-record"
    public static let handoverStoreName = "himawari-handover"

    public let keychainGroup: String?
    public let appGroup: String?

    public init(keychainGroup: String?, appGroup: String?) {
        self.keychainGroup = keychainGroup
        self.appGroup = appGroup
    }

    public init(bundle: Bundle) {
        self.init(
            keychainGroup: Self.setting(bundle, Self.keychainGroupKey),
            appGroup: Self.setting(bundle, Self.appGroupKey)
        )
    }

    static func setting(_ bundle: Bundle, _ key: String) -> String? {
        guard let value = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || trimmed.contains("$(") ? nil : trimmed
    }

    public var keys: SecureEnclaveKeyStore {
        SecureEnclaveKeyStore(service: Self.service + ".keys", accessGroup: keychainGroup)
    }

    public var keychain: KeychainValueStore {
        KeychainValueStore(service: Self.service, accessGroup: keychainGroup)
    }

    public func pairingRecord() -> PairingRecord? {
        keychain.read(Self.recordAccount).flatMap { try? JSONDecoder().decode(PairingRecord.self, from: $0) }
    }

    public func savePairingRecord(_ record: PairingRecord?) throws {
        try keychain.write(Self.recordAccount, try record.map { try JSONEncoder().encode($0) })
    }

    public func activeCredentials() -> DeviceCredentials? {
        guard let record = pairingRecord(), record.status == .active, keys.exists(.device) else { return nil }
        return DeviceCredentials(origin: record.origin, deviceId: record.deviceId, access: record.access, deviceKey: keys.signer(.device))
    }

    public func handoverStore() throws -> FileLocalStore {
        if let appGroup, let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            return try FileLocalStore(directory: base.appendingPathComponent(Self.handoverStoreName, isDirectory: true))
        }
        return try FileLocalStore.applicationSupport(named: Self.handoverStoreName)
    }
}
#endif
