import Foundation

public protocol DeviceKeySigner: Sendable {
    func publicKeySPKI() throws -> Data
    func sign(_ message: Data, reason: String?) async throws -> Data
    func held() -> any DeviceKeySigner
}

public extension DeviceKeySigner {
    func held() -> any DeviceKeySigner { self }
}

public enum DeviceKeyRole: String, Sendable, CaseIterable {
    case device
    case confirm
}

public enum DeviceKeyError: Error, Equatable, Sendable {
    case secureEnclaveUnavailable
    case keyMissing(DeviceKeyRole)
    case keyUnreadable(DeviceKeyRole)
    case notCreated(DeviceKeyRole)
    case keychain(Int32)
    case accessControl
    case signatureLength(Int)
}
