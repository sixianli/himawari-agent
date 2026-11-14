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
    public private(set) var waitingCapabilities: [CapabilitySummary] = []
    public private(set) var capabilitiesInUse: [CapabilitySummary] = []

    public private(set) var devices: [PairedDevice] = []
    public private(set) var server: ServerReach?
    public private(set) var loginDevices: [LoginDevice]?
    public private(set) var shelves: [FileOrigin: FileShelf] = [:]

    @ObservationIgnored public private(set) lazy var export = DataExportSession(gateway: gateway)

    public var capabilityCount: Int { waitingCapabilities.count + capabilitiesInUse.count }

    @ObservationIgnored let gateway: ManageGateway
    @ObservationIgnored let identity: DeviceIdentity?

    public init(gateway: ManageGateway, identity: DeviceIdentity?) {
        self.gateway = gateway
        self.identity = identity
    }

    public func load() async {
        async let status = loadServerReach()
        async let logins = try? loadLoginDevices()
        do {
            async let capabilities = loadCapabilities()
            async let listed = loadDevices()
            let all = try await capabilities
            waitingCapabilities = all.filter { CapabilityStanding.of($0.lifecycle) == .waitingForYou }
            capabilitiesInUse = all.filter { CapabilityStanding.of($0.lifecycle) == .inUse }
            devices = try await listed.devices
            phase = .loaded
        } catch {
            phase = .failed
        }
        server = await status
        loginDevices = await logins
    }

    public func reloadLoginDevices() async {
        if let listed = try? await loadLoginDevices() { loginDevices = listed }
    }

    public func signOut(_ device: LoginDevice, reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "login.device.revoke",
            payload: ["deviceId": .string(device.deviceId), "recentAuthenticationRef": .string(ClientCapabilities.referencePlaceholder)],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await reloadLoginDevices()
    }

    public func signOutOthers(reason: String) async throws -> SignOutOthersOutcome {
        defer { Task { await reloadLoginDevices() } }
        do {
            _ = try await gateway.command(
                .v2,
                "login.devices.revoke_others",
                payload: ["recentAuthenticationRef": .string(ClientCapabilities.referencePlaceholder)],
                options: ManageCommandOptions(confirmReason: reason)
            )
            return .done
        } catch ManageGatewayError.rejected(409, _, Self.stillChangingReason) {
            return .stillChanging
        }
    }

    static let stillChangingReason: String? = "LOGIN_DEVICES_STILL_CHANGING"

    public func shelf(_ origin: FileOrigin) -> FileShelf {
        shelves[origin] ?? FileShelf()
    }

    public func loadFiles(_ origin: FileOrigin, more: Bool = false) async {
        var shelf = more ? shelf(origin) : FileShelf()
        if more && shelf.nextCursor == nil { return }
        do {
            let data = try await gateway.read(
                .v2,
                "files.list.read",
                payload: [
                    "kind": .null,
                    "origin": .string(origin.rawValue),
                    "before": shelf.nextCursor.map(JSONValue.string) ?? .null,
                    "limit": .number(Double(Self.filePageSize)),
                ]
            )
            let page = try JSONDecoder().decode(Snapshot<FilesPage>.self, from: data).payload
            shelf.files += page.files.filter { !$0.deleted }
            shelf.nextCursor = page.nextCursor
            shelf.loaded = true
            shelf.failed = false
        } catch {
            shelf.loaded = true
            shelf.failed = shelf.files.isEmpty
        }
        shelves[origin] = shelf
    }

    static let filePageSize = 50

    private func loadLoginDevices() async throws -> [LoginDevice] {
        let data = try await gateway.read(.v2, "login.devices.read")
        return try JSONDecoder().decode(Snapshot<LoginDevicesPayload>.self, from: data).payload.devices
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

    private func loadServerReach() async -> ServerReach {
        guard
            let data = try? await gateway.read(.v2, "server.status.read"),
            let status = try? JSONDecoder().decode(Snapshot<ServerStatusPayload>.self, from: data)
        else { return .unreachable }
        return status.payload.ready ? .connected : .notReady
    }

    private func refs(_ type: String, filter: String, value: String?) async throws -> [String] {
        var refs: [String] = []
        var cursor: String?
        repeat {
            let data = try await gateway.read(
                .v2,
                type,
                payload: [
                    filter: value.map(JSONValue.string) ?? .null,
                    "afterCursor": cursor.map(JSONValue.string) ?? .null,
                    "limit": 100,
                ]
            )
            let page = try JSONDecoder().decode(Snapshot<CollectionPage>.self, from: data).payload
            refs += page.itemRefs
            cursor = page.nextCursor
        } while cursor != nil
        return refs
    }

    private func loadCapabilities() async throws -> [CapabilitySummary] {
        var result: [CapabilitySummary] = []
        for ref in try await refs("capability.list", filter: "lifecycle", value: nil) {
            let data = try await gateway.read(.v2, "capability.detail", payload: ["capabilityRef": .string(ref)])
            result.append(try JSONDecoder().decode(Snapshot<CapabilitySummary>.self, from: data).payload)
        }
        return result
    }
}
