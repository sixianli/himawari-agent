import Foundation

public struct PairingRecord: Codable, Sendable, Equatable {
    public let origin: URL
    public let deviceId: String
    public let access: ServiceAccessToken?
    public var status: PairedDeviceStatus
    public let pairingNumber: String

    public init(origin: URL, deviceId: String, access: ServiceAccessToken?, status: PairedDeviceStatus, pairingNumber: String) {
        self.origin = origin
        self.deviceId = deviceId
        self.access = access
        self.status = status
        self.pairingNumber = pairingNumber
    }
}

public enum PairingProblem: Sendable, Equatable {
    case unreadableCode
    case codeExpired(ttlSeconds: Int?)
    case codeUsed
    case codeInvalid
    case unreachable
    case keysUnavailable
    case keysUnreadable
    case storageUnavailable
    case stateUnknown
    case removed

    public static func from(_ error: Error) -> PairingProblem {
        if let parse = error as? PairingInvitation.ParseError {
            return parse == .unsupportedVersion ? .codeInvalid : .unreadableCode
        }
        if error is DeviceKeyError { return .keysUnavailable }
        if let api = error as? DeviceAPIError, case let .server(status, code, ttl) = api {
            switch code {
            case "DEVICE_PAIRING_CODE_EXPIRED": return .codeExpired(ttlSeconds: ttl.flatMap { $0 > 0 ? $0 : nil })
            case "DEVICE_PAIRING_CODE_USED": return .codeUsed
            case "DEVICE_REVOKED": return .removed
            case "DEVICE_PAIRING_CODE_INVALID", "DEVICE_PAIRING_REQUEST_INVALID": return .codeInvalid
            default: return status >= 500 ? .unreachable : .codeInvalid
            }
        }
        return .unreachable
    }
}
