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
    public private(set) var capabilitiesDisabled: [CapabilitySummary] = []

    public private(set) var devices: [PairedDevice] = []
    public private(set) var server: ServerReach?
    public private(set) var loginDevices: [LoginDevice]?
    public private(set) var shelves: [FileOrigin: FileShelf] = [:]
    public private(set) var proposals: ProposalList?
    public private(set) var tuning: [TuningKind: TuningSnapshot] = [:]

    @ObservationIgnored public private(set) lazy var export = DataExportSession(gateway: gateway)

    public var capabilityCount: Int { waitingCapabilities.count + capabilitiesInUse.count + capabilitiesDisabled.count }

    @ObservationIgnored private var loadingMoreFiles: Set<FileOrigin> = []
    @ObservationIgnored private var fileLoadGeneration: [FileOrigin: Int] = [:]
    @ObservationIgnored let gateway: ManageGateway
    @ObservationIgnored let identity: DeviceIdentity?

    public init(gateway: ManageGateway, identity: DeviceIdentity?) {
        self.gateway = gateway
        self.identity = identity
    }

    public func load() async {
        async let status = loadServerReach()
        async let logins = try? loadLoginDevices()
        async let listedProposals = try? loadProposals()
        do {
            async let capabilities = loadCapabilities()
            async let listed = loadDevices()
            let all = try await capabilities
            waitingCapabilities = all.filter { CapabilityStanding.of($0.lifecycle) == .waitingForYou }
            capabilitiesInUse = all.filter { CapabilityStanding.of($0.lifecycle) == .inUse }
            capabilitiesDisabled = all.filter { CapabilityStanding.of($0.lifecycle) == .disabled }
            devices = try await listed.devices
            phase = .loaded
        } catch {
            phase = .failed
        }
        await loadTuning()
        server = await status
        loginDevices = await logins
        proposals = await listedProposals
    }

    public func disable(_ capability: CapabilitySummary, reason: String) async throws {
        defer { Task { await reloadCapabilities() } }
        _ = try await gateway.command(
            .v2,
            "capability.disable",
            payload: [
                "capabilityRef": .string(capability.capabilityRef),
                "expectedRevision": .number(Double(capability.revision)),
                "reasonCode": .string(Self.ownerDisabledReason),
                "recentAuthenticationRef": .string(ClientCapabilities.referencePlaceholder),
            ],
            options: ManageCommandOptions(confirmReason: reason)
        )
    }

    static let ownerDisabledReason = "owner_disabled"

    public func reloadCapabilities() async {
        guard let all = try? await loadCapabilities() else { return }
        waitingCapabilities = all.filter { CapabilityStanding.of($0.lifecycle) == .waitingForYou }
        capabilitiesInUse = all.filter { CapabilityStanding.of($0.lifecycle) == .inUse }
        capabilitiesDisabled = all.filter { CapabilityStanding.of($0.lifecycle) == .disabled }
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

    public func loadTuning() async {
        for kind in TuningKind.allCases { await reloadTuning(kind) }
    }

    public func reloadTuning(_ kind: TuningKind) async {
        guard let data = try? await gateway.read(.v2, kind.readType, payload: kind.readPayload) else { return }
        if let snapshot = try? JSONDecoder().decode(Snapshot<TuningSnapshot>.self, from: data).payload {
            tuning[kind] = snapshot
        }
    }

    public func changeTuning(_ kind: TuningKind, key: String, value: Int?, reason: String) async throws {
        guard let snapshot = tuning[kind] else { throw ManageGatewayError.malformedResponse }
        defer { Task { await reloadTuning(kind) } }
        _ = try await gateway.command(
            .v2,
            kind.changeType,
            payload: [
                "expectedRevision": .number(Double(snapshot.revision)),
                "key": .string(key),
                "value": value.map { .number(Double($0)) } ?? .null,
            ],
            options: ManageCommandOptions(confirmReason: reason)
        )
    }

    public func reloadProposals() async {
        if let listed = try? await loadProposals() { proposals = listed }
    }

    public func respond(_ proposal: Proposal, _ action: ProposalAction, reason: String) async throws -> ProposalOutcome {
        do {
            var fullReadToken = JSONValue.null
            if action == .adopt && proposal.requiresFullRead {
                fullReadToken = .string(try await openFullText(proposal))
            }
            _ = try await gateway.command(
                .v2,
                "proposal.respond",
                payload: [
                    "proposalId": .string(proposal.proposalId),
                    "expectedVersion": .number(Double(proposal.version)),
                    "fingerprint": .string(proposal.fingerprint),
                    "action": .string(action.rawValue),
                    "recentAuthenticationRef": .string(ClientCapabilities.referencePlaceholder),
                    "fullReadToken": fullReadToken,
                ],
                options: ManageCommandOptions(confirmReason: reason)
            )
            await reloadProposals()
            return .done(action)
        } catch let error as ManageGatewayError {
            guard case .rejected(let status, _, _) = error, status != 401, status != 403 else { throw error }
            guard let listed = try? await loadProposals() else { throw error }
            proposals = listed
            guard let latest = listed.proposals.first(where: { $0.proposalId == proposal.proposalId }) else { return .gone }
            guard latest.version != proposal.version || latest.fingerprint != proposal.fingerprint else { throw error }
            return .changed(latest)
        }
    }

    private func openFullText(_ proposal: Proposal) async throws -> String {
        let data = try await gateway.read(
            .v2,
            "proposals.read",
            payload: [
                "open": .object([
                    "proposalId": .string(proposal.proposalId),
                    "expectedVersion": .number(Double(proposal.version)),
                    "fingerprint": .string(proposal.fingerprint),
                ]),
            ]
        )
        let list = try JSONDecoder().decode(Snapshot<ProposalList>.self, from: data).payload
        guard let token = list.opened?.fullReadToken else { throw ManageGatewayError.malformedResponse }
        return token
    }

    private func loadProposals() async throws -> ProposalList {
        let data = try await gateway.read(.v2, "proposals.read", payload: ["open": .null])
        return try JSONDecoder().decode(Snapshot<ProposalList>.self, from: data).payload
    }

    public func shelf(_ origin: FileOrigin) -> FileShelf {
        shelves[origin] ?? FileShelf()
    }

    public func loadFiles(_ origin: FileOrigin, more: Bool = false) async {
        var shelf = more ? shelf(origin) : FileShelf()
        if more && shelf.nextCursor == nil { return }
        if more {
            guard loadingMoreFiles.insert(origin).inserted else { return }
        }
        defer {
            if more { loadingMoreFiles.remove(origin) }
        }
        if !more { fileLoadGeneration[origin, default: 0] += 1 }
        let generation = fileLoadGeneration[origin, default: 0]
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
        guard fileLoadGeneration[origin, default: 0] == generation else { return }
        fileLoadGeneration[origin] = generation + 1
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
