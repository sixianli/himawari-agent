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

    @ObservationIgnored let gateway: ManageGateway
    @ObservationIgnored let identity: DeviceIdentity?

    public init(gateway: ManageGateway, identity: DeviceIdentity?) {
        self.gateway = gateway
        self.identity = identity
    }

    public func load() async {
        do {
            devices = try await loadDevices().devices
            phase = .loaded
        } catch {
            phase = .failed
        }
    }

    public func reloadDevices() async {
        if let listed = try? await loadDevices() { devices = listed.devices }
    }

    public func isThisDevice(_ device: PairedDevice) -> Bool {
        device.id == identity?.deviceId
    }

    public func presence(_ device: PairedDevice) -> DevicePresence {
        DevicePresence.of(device, isThisDevice: isThisDevice(device))
    }

    public func rename(_ device: PairedDevice, to name: String, reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "device.rename",
            payload: [
                "deviceId": .string(device.id),
                "expectedRevision": .number(Double(device.revision)),
                "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            ],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await reloadDevices()
    }

    public func revoke(_ device: PairedDevice, reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "device.revoke",
            payload: ["deviceId": .string(device.id), "expectedRevision": .number(Double(device.revision))],
            options: ManageCommandOptions(confirmReason: reason)
        )
        if !isThisDevice(device) { await reloadDevices() }
    }

    func loadDevices() async throws -> DeviceListPayload {
        let data = try await gateway.read(.v2, "device.list.read")
        let payload = try JSONDecoder().decode(Snapshot<DeviceListPayload>.self, from: data).payload
        return DeviceListPayload(
            devices: payload.devices.filter { $0.status != "revoked" },
            pairing: payload.pairing
        )
    }
}
