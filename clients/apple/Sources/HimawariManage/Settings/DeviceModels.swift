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
    public let online: Bool?
}

public struct DeviceRoster: Decodable, Sendable, Equatable {
    public struct Server: Decodable, Sendable, Equatable {
        public let origin: String
        public let since: String?
    }

    public let thisDeviceId: String
    public let devices: [PairedDevice]
    public let server: Server?
}

public enum DevicePresence: Equatable, Sendable {
    case connected
    case justNow
    case seen(Date)
    case neverSeen

    static func of(_ device: PairedDevice, isThisDevice: Bool) -> DevicePresence {
        if isThisDevice || device.online == true { return .connected }
        return of(lastSeenAt: device.lastSeenAt.flatMap(Timestamp.parse), now: Date())
    }

    static func of(lastSeenAt: Date?, now: Date) -> DevicePresence {
        guard let lastSeenAt else { return .neverSeen }
        return now.timeIntervalSince(lastSeenAt) < 60 ? .justNow : .seen(lastSeenAt)
    }
}

public protocol DeviceDirectory: Sendable {
    func roster() async throws -> DeviceRoster
    func rename(_ deviceId: String, expectedRevision: Int, name: String) async throws
    func revoke(_ deviceId: String, expectedRevision: Int, confirmReason: String?) async throws
}

public struct SignedDeviceDirectory: DeviceDirectory {
    private let http: DeviceHTTPClient
    private let confirmKey: DeviceKeySigner

    public init(http: DeviceHTTPClient, confirmKey: DeviceKeySigner) {
        self.http = http
        self.confirmKey = confirmKey
    }

    public func roster() async throws -> DeviceRoster {
        let data = try await http.send(DeviceRequest(method: "GET", path: "devices"))
        guard let roster = try? JSONDecoder().decode(DeviceRoster.self, from: data) else { throw DeviceAPIError.invalidResponse }
        return roster
    }

    public func rename(_ deviceId: String, expectedRevision: Int, name: String) async throws {
        struct Body: Encodable {
            let deviceId: String
            let expectedRevision: Int
            let name: String
        }
        let body = try JSONEncoder().encode(Body(deviceId: deviceId, expectedRevision: expectedRevision, name: name))
        _ = try await http.send(DeviceRequest(method: "POST", path: "devices/rename", body: body))
    }

    public func revoke(_ deviceId: String, expectedRevision: Int, confirmReason: String?) async throws {
        struct Body: Encodable {
            let deviceId: String
            let expectedRevision: Int
        }
        let body = try JSONEncoder().encode(Body(deviceId: deviceId, expectedRevision: expectedRevision))
        guard let confirmReason else {
            _ = try await http.send(DeviceRequest(method: "POST", path: "devices/revoke", body: body))
            return
        }
        let issued = try await http.send(DeviceRequest(method: "POST", path: ManageGateway.challengePath, body: Data("{}".utf8)))
        struct Issued: Decodable { let challenge: String }
        guard let challenge = try? JSONDecoder().decode(Issued.self, from: issued).challenge else { throw DeviceAPIError.invalidResponse }
        _ = try await http.send(DeviceRequest(
            method: "POST",
            path: "devices/revoke",
            body: body,
            nonce: challenge,
            confirmSigner: confirmKey,
            confirmReason: confirmReason
        ))
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
