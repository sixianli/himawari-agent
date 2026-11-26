import Foundation
import HimawariCore
import Observation

@MainActor
@Observable
public final class SettingsStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case failed
    }

    public private(set) var phase: Phase = .loading
    public private(set) var devices: [PairedDevice] = []
    public private(set) var thisDeviceId: String?
    public private(set) var server: DeviceRoster.Server?

    @ObservationIgnored let directory: DeviceDirectory

    public init(directory: DeviceDirectory) {
        self.directory = directory
    }

    public func load() async {
        do {
            apply(try await directory.roster())
            phase = .loaded
        } catch {
            phase = .failed
        }
    }

    public func reloadDevices() async {
        if let roster = try? await directory.roster() { apply(roster) }
    }

    private func apply(_ roster: DeviceRoster) {
        thisDeviceId = roster.thisDeviceId
        server = roster.server
        devices = roster.devices.filter { $0.status != "revoked" }
    }

    public var thisDevice: PairedDevice? { devices.first(where: isThisDevice) }

    public var otherDevices: [PairedDevice] {
        devices.filter { !isThisDevice($0) }.sorted { first, second in
            (first.lastSeenAt.flatMap(Timestamp.parse) ?? .distantPast) > (second.lastSeenAt.flatMap(Timestamp.parse) ?? .distantPast)
        }
    }

    public func isThisDevice(_ device: PairedDevice) -> Bool {
        device.id == thisDeviceId
    }

    public func presence(_ device: PairedDevice) -> DevicePresence {
        DevicePresence.of(device, isThisDevice: isThisDevice(device))
    }

    public func rename(_ device: PairedDevice, to name: String) async throws {
        try await directory.rename(device.id, expectedRevision: device.revision, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
        await reloadDevices()
    }

    public func revoke(_ device: PairedDevice, reason: String) async throws {
        let mine = isThisDevice(device)
        try await directory.revoke(device.id, expectedRevision: device.revision, confirmReason: mine ? nil : reason)
        if !mine {
            devices.removeAll { $0.id == device.id }
            await reloadDevices()
        }
    }
}
