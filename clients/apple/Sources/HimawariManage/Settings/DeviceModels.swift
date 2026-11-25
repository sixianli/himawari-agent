import Foundation
import HimawariCore

public struct PairedDevice: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let revision: Int
    public let kind: String
    public let name: String
    public let releaseChannel: String
    public let status: String
    public let pairedAt: String
    public let lastSeenAt: String?
    public let pairingNumber: String?
}

struct DeviceListPayload: Decodable {
    struct Pairing: Decodable {
        let expiresAt: String
        let access: ServiceAccessToken?
    }

    let devices: [PairedDevice]
    let pairing: Pairing?
}

public enum DevicePresence: Equatable, Sendable {
    case connected
    case justNow
    case seen(Date)
    case neverSeen
    case waitingForConfirmation

    static func of(_ device: PairedDevice, isThisDevice: Bool) -> DevicePresence {
        if device.status == "pending" { return .waitingForConfirmation }
        if isThisDevice { return .connected }
        return of(lastSeenAt: device.lastSeenAt.flatMap(Timestamp.parse), now: Date())
    }

    static func of(lastSeenAt: Date?, now: Date) -> DevicePresence {
        guard let lastSeenAt else { return .neverSeen }
        return now.timeIntervalSince(lastSeenAt) < 60 ? .justNow : .seen(lastSeenAt)
    }
}

public struct DeviceIdentity: Sendable, Equatable {
    public let deviceId: String
    public let origin: URL
    public let access: ServiceAccessToken?

    public init(deviceId: String, origin: URL, access: ServiceAccessToken?) {
        self.deviceId = deviceId
        self.origin = origin
        self.access = access
    }
}

enum DeviceName {
    static let maxLength = 64

    static func accepted(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...maxLength).contains(trimmed.unicodeScalars.count) else { return nil }
        let hidden = trimmed.unicodeScalars.contains { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator: true
            default: false
            }
        }
        return hidden ? nil : trimmed
    }
}
